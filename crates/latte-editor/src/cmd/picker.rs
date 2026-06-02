use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use crate::state::AppState;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct WorkspaceChange {
    pub previous: Option<String>,
    pub current: String,
}

#[tauri::command]
pub fn cmd_pick_folder(app: tauri::AppHandle) -> Option<String> {
    // `blocking_pick_folder` is fine inside a Tauri command: commands run
    // on Tauri's IPC worker pool, so the WebView stays responsive while
    // the OS dialog is open. Returns `None` if the user cancels.
    let picked = app.dialog().file().blocking_pick_folder()?;
    // `FilePath` resolves to an OS path; we don't currently use the
    // in-VFS variant (it requires `tauri::scope::FileScope`).
    Some(picked.to_string())
}

#[tauri::command]
pub fn cmd_set_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<WorkspaceChange, String> {
    // Snapshot the previous path *before* `apply_workspace` mutates state.
    let previous = state.workspace.lock().unwrap().clone();
    let new_path = PathBuf::from(&path);
    let new_str = apply_workspace(&app, &state, &new_path)?;
    Ok(set_workspace_inner(previous, PathBuf::from(new_str)))
}

/// Canonicalize the candidate path, install it as the active workspace,
/// mirror it to the session file for next-launch restore, and notify the
/// renderer so it can re-fetch state. Used by both `cmd_set_workspace`
/// (after `cmd_pick_folder`) and the OS-level drag-drop handler in
/// `lib.rs`, so both code paths emit the same `workspace-changed` event
/// and the renderer's `App.tsx` updates regardless of which triggered it.
pub fn apply_workspace(
    app: &AppHandle,
    state: &AppState,
    new_path: &Path,
) -> Result<String, String> {
    if !new_path.is_dir() {
        return Err(format!("not a directory: {}", new_path.display()));
    }
    let canonical = std::fs::canonicalize(new_path)
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    {
        let mut ws = state.workspace.lock().unwrap();
        *ws = Some(canonical.clone());
    }
    let path_str = canonical.to_string_lossy().to_string();
    // Mirror to the session file so the next launch restores it.
    crate::cmd::session::cmd_set_last_workspace(path_str.clone())?;
    // Notify the renderer so React state stays in sync with the Rust side.
    // `emit` errors are intentionally swallowed: a failed event means the
    // renderer will re-fetch on the next IPC call anyway, and we don't want
    // a transient emit failure to roll back an otherwise-successful
    // workspace change.
    let _ = app.emit("workspace-changed", &path_str);
    Ok(path_str)
}

// Extracted so tests can hit it without spinning up a Tauri State.
pub(crate) fn set_workspace_inner(
    previous: Option<PathBuf>,
    current: PathBuf,
) -> WorkspaceChange {
    WorkspaceChange {
        previous: previous.map(|p| p.to_string_lossy().to_string()),
        current: current.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_workspace_records_previous_and_current() {
        // Build a State by going through Tauri is heavy; instead, exercise
        // the same business logic by calling `set_workspace_inner` directly.
        // We declare the helper here and forward from the command in step 3.
        let prev = Some(PathBuf::from("/old"));
        let new_path = PathBuf::from("/new");
        let change = set_workspace_inner(prev, new_path.clone());
        assert_eq!(change.previous.as_deref(), Some("/old"));
        assert_eq!(change.current, "/new");
    }

    #[test]
    fn set_workspace_inner_handles_none_previous() {
        let change = set_workspace_inner(None, PathBuf::from("/fresh"));
        assert_eq!(change.previous, None);
        assert_eq!(change.current, "/fresh");
    }
}
