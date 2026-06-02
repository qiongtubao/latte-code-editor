use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;

/// Returns the current workspace path held in `AppState`, if any.
/// Used by the desktop `App.tsx` to refresh user CSS/JS hooks when the
/// workspace changes (see plan T26 / issue I1).
#[tauri::command]
pub fn cmd_get_workspace(state: State<AppState>) -> Option<String> {
    state
        .workspace
        .lock()
        .unwrap()
        .as_ref()
        .map(|p: &PathBuf| p.to_string_lossy().to_string())
}
