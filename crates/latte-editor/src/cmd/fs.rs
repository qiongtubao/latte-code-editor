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
    // `None` (or an empty string) means "list the workspace root".
    let p = match path.as_deref() {
        Some(s) if !s.is_empty() => safe_path(&ws, s).map_err(|e| e.to_string())?,
        _ => ws.clone(),
    };
    let mut out = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let meta = e.metadata().map_err(|e| e.to_string())?;
        let abs = e.path();
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool }
