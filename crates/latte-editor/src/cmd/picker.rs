use std::path::PathBuf;
use tauri::State;
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
    state: State<'_, AppState>,
    path: String,
) -> Result<WorkspaceChange, String> {
    let new_path = PathBuf::from(&path);
    if !new_path.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let canonical = std::fs::canonicalize(&new_path)
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let previous = {
        let mut ws = state.workspace.lock().unwrap();
        let prev = ws.clone();
        *ws = Some(canonical.clone());
        prev
    };
    // Mirror to the session file so the next launch restores it.
    crate::cmd::session::cmd_set_last_workspace(canonical.to_string_lossy().to_string())?;
    Ok(set_workspace_inner(previous, canonical))
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
