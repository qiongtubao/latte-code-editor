// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// T8 will register latte-editor Tauri commands via .invoke_handler(...)
// and .manage(latte_editor::state::AppState::new()) before Builder::default().
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
