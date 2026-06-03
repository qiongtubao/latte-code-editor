use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use crate::state::AppState;
use crate::path::safe_path;

/// Directory names that are always hidden from the file tree, server-side.
/// Keeps the IPC payload small and the renderer logic trivial.
const HIDDEN_DIR_NAMES: &[&str] = &["node_modules", ".git", "target"];

/// 5 MiB cap on file reads. Generous for source files; rejects binaries
/// and accidental large-file slurps before they hit the IPC layer.
const MAX_READ_BYTES: u64 = 5 * 1024 * 1024;

/// True for the workspace-root sentinels. Used by create/delete to reject
/// "operate on the root" requests — the root is implicit, not an entry.
fn is_root_marker(raw: &str) -> bool {
    raw.is_empty() || raw == "." || raw == "./"
}

/// True if any segment of `abs` is in `HIDDEN_DIR_NAMES`. Used by delete:
/// the tree never shows these directories, so allowing IPC-driven deletes
/// inside them would create a "tree says present, disk says gone" split.
fn path_has_hidden_segment(abs: &Path) -> bool {
    abs.components().any(|c| {
        HIDDEN_DIR_NAMES.contains(&c.as_os_str().to_string_lossy().as_ref())
    })
}

/// True if the final segment of `abs` is in `HIDDEN_DIR_NAMES`. Used by
/// create: we only block the new entry's own name, not its parent (the
/// tree simply won't show children of a hidden directory, but the
/// directory itself can still be a valid create target).
fn last_segment_is_hidden(abs: &Path) -> bool {
    abs.file_name()
        .map(|n| HIDDEN_DIR_NAMES.contains(&n.to_string_lossy().as_ref()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn cmd_list_dir(state: State<AppState>, path: Option<String>) -> Result<Vec<FsEntry>, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    cmd_list_dir_inner(ws, path)
}

// Extracted so the logic is testable without a Tauri `State` (mirrors the
// `cmd_write_file_inner` / `set_workspace_inner` pattern).
pub(crate) fn cmd_list_dir_inner(ws: PathBuf, path: Option<String>) -> Result<Vec<FsEntry>, String> {
    // `None` (or an empty string) means "list the workspace root".
    let p = match path.as_deref() {
        Some(s) if !s.is_empty() => safe_path(&ws, s).map_err(|e| e.to_string())?,
        _ => ws.clone(),
    };
    let mut out = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let abs = e.path();
        // `DirEntry::metadata` is equivalent to `lstat` on Unix (does NOT
        // follow symlinks), so a symlink pointing at a directory would be
        // reported as `is_dir() == false` and the FileTree would treat it
        // as a file — clicking it would then EISDIR inside `cmd_read_file`.
        // `Path::metadata` follows symlinks, matching the semantics of
        // `cmd_read_file` / `cmd_write_file` / `cmd_delete_entry` (which
        // all resolve the path and let the OS follow links on open).
        let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
        let name_os = e.file_name();
        let name = name_os.to_string_lossy().to_string();
        // Filter hidden directories server-side. Files are not filtered by
        // name (e.g. a file literally called `target` should still show up,
        // even though a directory of that name would be hidden).
        if meta.is_dir() && HIDDEN_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }
        // Emit workspace-relative paths so the renderer can re-submit them
        // to list_dir without tripping safe_path's absolute-path rejection.
        let rel = abs
            .strip_prefix(&ws)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| PathBuf::from(&name_os));
        out.push(FsEntry {
            name,
            path: rel.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub fn cmd_read_file(state: State<AppState>, path: String) -> Result<String, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let abs = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}

/// Write `content` to `path` (workspace-relative), atomically.
///
/// Validation matches `cmd_create_file`: rejects root markers, paths
/// inside `HIDDEN_DIR_NAMES` (the tree never shows those — allowing
/// writes there would create a "tree says absent, disk says present"
/// split), missing parent directories, and hidden names as the final
/// segment. Content is normalised to LF-only on the way out.
///
/// Atomicity is provided by writing into a `NamedTempFile` in the same
/// directory as the target and `persist`-ing it (POSIX `rename(2)` on
/// the same filesystem; on Windows it uses `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`, which is non-atomic and can briefly
/// fail with `ERROR_ACCESS_DENIED` if an antivirus or indexing service
/// holds a handle on the target). We retry once after a 50ms sleep to
/// cover the transient case; a second failure surfaces the error to
/// the renderer.
#[tauri::command]
pub fn cmd_write_file(
    state: State<AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    cmd_write_file_inner(
        state.workspace.lock().unwrap().clone().ok_or("workspace not open")?,
        &path,
        &content,
    )
}

/// Inner write logic, extracted so unit tests can drive it without
/// constructing a Tauri `State`. Same validation contract as
/// `cmd_write_file`.
pub(crate) fn cmd_write_file_inner(
    ws: PathBuf,
    path: &str,
    content: &str,
) -> Result<(), String> {
    if is_root_marker(path) {
        return Err("path must not be empty (workspace root)".into());
    }
    let abs = safe_path(&ws, path).map_err(|e| e.to_string())?;
    if path_has_hidden_segment(&abs) {
        return Err(format!("refusing to write inside hidden directory: {path}"));
    }
    let parent = abs
        .parent()
        .ok_or_else(|| format!("no parent for: {path}"))?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {path}"));
    }
    if last_segment_is_hidden(&abs) {
        return Err(format!(
            "name '{}' is in the hidden list and cannot be created",
            abs.file_name().unwrap().to_string_lossy()
        ));
    }
    // Normalise line endings to LF. We don't try to preserve CRLF here
    // (J3): the renderer reads in whatever shape, but writes out LF.
    let normalized = content.replace("\r\n", "\n");
    // `tempfile::NamedTempFile::new_in(parent_dir)` puts the temp
    // file on the same filesystem as the target, which is required
    // for `persist` to be a true atomic rename on POSIX.
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("tempfile create failed: {e}"))?;
    use std::io::Write;
    tmp.write_all(normalized.as_bytes())
        .map_err(|e| format!("tempfile write failed: {e}"))?;
    // Try persist once. If it fails (Windows AV/index race), sleep
    // briefly and retry — the `PersistError` exposes the original
    // `NamedTempFile` so we get a second chance with the same temp.
    if let Err(e) = tmp.persist(&abs) {
        let tmp = e.file;
        std::thread::sleep(std::time::Duration::from_millis(50));
        tmp.persist(&abs).map_err(|e| format!("persist failed: {e}"))?;
    }
    Ok(())
}

/// Create an empty file at `path` (workspace-relative). Rejects:
///   - root markers (no name after the workspace)
///   - targets that already exist (no clobber)
///   - missing parent directories
///   - names in `HIDDEN_DIR_NAMES` (e.g. `node_modules/x` is fine as a
///     *parent*; the new file's own name is what's checked)
#[tauri::command]
pub fn cmd_create_file(state: State<AppState>, path: String) -> Result<(), String> {
    if is_root_marker(&path) {
        return Err("path must not be empty (workspace root)".into());
    }
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let abs = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    if fs::metadata(&abs).is_ok() {
        return Err(format!("target already exists: {path}"));
    }
    let parent = abs
        .parent()
        .ok_or_else(|| format!("no parent for: {path}"))?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {path}"));
    }
    if last_segment_is_hidden(&abs) {
        return Err(format!(
            "name '{}' is in the hidden list and cannot be created",
            abs.file_name().unwrap().to_string_lossy()
        ));
    }
    fs::write(&abs, "").map_err(|e| e.to_string())
}

/// Create an empty directory at `path` (workspace-relative). Same
/// validation as `cmd_create_file`, with `fs::create_dir` as the final
/// step. `fs::create_dir` is the non-recursive variant; we deliberately
/// require the parent to exist (see parent check above) so a typo can't
/// silently build a deep tree.
#[tauri::command]
pub fn cmd_create_dir(state: State<AppState>, path: String) -> Result<(), String> {
    if is_root_marker(&path) {
        return Err("path must not be empty (workspace root)".into());
    }
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let abs = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    if fs::metadata(&abs).is_ok() {
        return Err(format!("target already exists: {path}"));
    }
    let parent = abs
        .parent()
        .ok_or_else(|| format!("no parent for: {path}"))?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {path}"));
    }
    if last_segment_is_hidden(&abs) {
        return Err(format!(
            "name '{}' is in the hidden list and cannot be created",
            abs.file_name().unwrap().to_string_lossy()
        ));
    }
    fs::create_dir(&abs).map_err(|e| e.to_string())
}

/// Delete the file or (empty) directory at `path` (workspace-relative).
/// Rejects:
///   - root markers (can't delete the workspace itself)
///   - paths where any segment is in `HIDDEN_DIR_NAMES` (the tree never
///     shows those directories; deleting inside them would orphan the
///     remaining visible children from their (invisible) parent)
/// Directories must be empty — `fs::remove_dir` (not `remove_dir_all`)
/// is used to keep that an explicit, recoverable error.
#[tauri::command]
pub fn cmd_delete_entry(state: State<AppState>, path: String) -> Result<(), String> {
    if is_root_marker(&path) {
        return Err("cannot delete workspace root".into());
    }
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let abs = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    if path_has_hidden_segment(&abs) {
        return Err(format!("refusing to delete inside hidden directory: {path}"));
    }
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir(&abs).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&abs).map_err(|e| e.to_string())
    }
}

/// Show a native confirm dialog before deletion. Returns the user's
/// choice as a `bool` (true = confirm, false = cancel).
///
/// `async` + `spawn_blocking` is load-bearing on macOS for the same
/// reason as `cmd_pick_folder`: a sync Tauri command runs inside the
/// WKWebView url-scheme handler's main-thread stack, so calling
/// `blocking_show` there re-enters the main thread to construct the
/// native panel, deadlocking the dialog. `async fn` makes Tauri spawn
/// the future and immediately return from the url-scheme handler,
/// freeing the main thread to run the dialog at the next event-loop
/// tick. The `OkCancelCustom` buttons give the dialog explicit
/// "Delete"/"Cancel" labels matching the destructive action.
#[tauri::command]
pub async fn cmd_confirm_delete(app: AppHandle, path: String) -> Result<bool, String> {
    let message = format!("Delete \"{path}\"?\n\nThis cannot be undone.");
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Confirm Delete")
            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Delete".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|e| format!("dialog task failed: {e}"))
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool }

#[cfg(test)]
mod tests {
    use super::*;

    /// U1: writing to a normal workspace-relative path persists the
    /// content and leaves no stray `tmp.*` files behind.
    #[test]
    fn write_file_writes_to_workspace_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();
        // Pre-create a sub-directory so the target has a parent that
        // already exists on disk.
        fs::create_dir(ws.join("sub")).unwrap();

        let result = cmd_write_file_inner(ws.clone(), "sub/hello.txt", "hello world");
        assert!(result.is_ok(), "write failed: {result:?}");

        // File exists with the expected content.
        let on_disk = ws.join("sub/hello.txt");
        assert!(on_disk.is_file());
        assert_eq!(fs::read_to_string(&on_disk).unwrap(), "hello world");

        // The parent directory should contain *only* the target — no
        // leftover NamedTempFile from the atomic-write dance.
        let siblings: Vec<String> = fs::read_dir(ws.join("sub"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(siblings, vec!["hello.txt".to_string()]);
    }

    /// U2: writing inside a `HIDDEN_DIR_NAMES` directory is rejected
    /// before any disk mutation.
    #[test]
    fn write_file_rejects_hidden_directory() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();
        let hidden = ws.join("node_modules");
        fs::create_dir(&hidden).unwrap();

        let result = cmd_write_file_inner(ws.clone(), "node_modules/x.ts", "x");
        assert!(result.is_err(), "expected error, got {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.contains("hidden"),
            "error should mention 'hidden', got: {err}"
        );
        // The directory on disk must be untouched.
        assert!(hidden.is_dir());
        assert_eq!(
            fs::read_dir(&hidden).unwrap().count(),
            0,
            "hidden dir should be empty"
        );
    }

    /// U3: writing to a path whose parent directory does not exist
    /// is rejected (we never auto-mkdir; the create-file flow is the
    /// supported way to add new entries).
    #[test]
    fn write_file_rejects_missing_parent() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();

        let result = cmd_write_file_inner(ws.clone(), "nonexistent/foo.txt", "x");
        assert!(result.is_err(), "expected error, got {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.contains("parent"),
            "error should mention 'parent', got: {err}"
        );
        // The missing directory must NOT have been created as a side
        // effect of the failed write.
        assert!(!ws.join("nonexistent").exists());
    }

    /// U4: a symlink that *points at a directory* must be reported as
    /// `is_dir: true` — otherwise the FileTree would render it as a
    /// file row and clicking it would EISDIR inside `cmd_read_file`.
    /// Regression for: using `DirEntry::metadata` (lstat) instead of
    /// `fs::metadata` (stat) in the listing loop.
    #[cfg(unix)]
    #[test]
    fn list_dir_follows_symlink_to_directory() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();
        // Real target dir lives *outside* the workspace so we can prove
        // the listing follows the symlink (vs. just seeing a literal
        // directory inside the workspace).
        let real = tempfile::tempdir().unwrap();
        let real_dir = real.path().to_path_buf();
        std::fs::create_dir(real_dir.join("inside")).unwrap();
        // `gtid_link -> <real_dir>` — name doesn't matter; we just need
        // one symlink to a directory.
        std::os::unix::fs::symlink(&real_dir, ws.join("gtid_link")).unwrap();
        // Sanity: a real file inside the workspace to make sure we
        // didn't break the normal path.
        std::fs::write(ws.join("hello.txt"), "hi").unwrap();

        let entries = cmd_list_dir_inner(ws.clone(), None).expect("list root");
        let by_name: std::collections::HashMap<&str, &FsEntry> =
            entries.iter().map(|e| (e.name.as_str(), e)).collect();

        // The symlink is reported as a directory with a workspace-relative
        // path (no leading slash, no abs path leaking).
        let link_entry = by_name.get("gtid_link").expect("symlink entry missing");
        assert!(link_entry.is_dir, "symlink→dir must be is_dir=true, got {link_entry:?}");
        assert_eq!(link_entry.path, "gtid_link");

        // The normal file still works.
        let file_entry = by_name.get("hello.txt").expect("file entry missing");
        assert!(!file_entry.is_dir);
        assert_eq!(file_entry.path, "hello.txt");
    }
}
