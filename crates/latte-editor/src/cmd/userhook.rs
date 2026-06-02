use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct UserHook { pub css: Option<String>, pub js: Option<String> }

#[tauri::command]
pub fn cmd_user_hook(state: State<AppState>) -> Result<UserHook, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let dir: PathBuf = ws.join(".latte/hooks");
    Ok(UserHook {
        css: std::fs::read_to_string(dir.join("user.css")).ok(),
        js:  std::fs::read_to_string(dir.join("user.js")).ok(),
    })
}
