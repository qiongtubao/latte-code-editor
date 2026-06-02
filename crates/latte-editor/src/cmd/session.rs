use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;

fn session_file() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("latte-editor");
    p.push("last-workspace.txt");
    p
}

#[tauri::command]
pub fn cmd_get_last_workspace() -> Option<String> {
    std::fs::read_to_string(session_file()).ok().map(|s| s.trim().to_string())
}

#[tauri::command]
pub fn cmd_set_last_workspace(path: String) -> Result<(), String> {
    let p = session_file();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, path).map_err(|e| e.to_string())
}

// `restore_into` takes `&State<AppState>` because it's called from `setup`,
// where the only handle we have on the managed state is the `State<T>` wrapper
// (Tauri does not expose the bare `AppState` here). `State<T>` derefs to `T`,
// so the rest of the body can just use `state.workspace` as if it were `AppState`.
pub fn restore_into(state: &State<AppState>) {
    if let Some(ws) = cmd_get_last_workspace() {
        *state.workspace.lock().unwrap() = Some(PathBuf::from(ws));
    }
}
