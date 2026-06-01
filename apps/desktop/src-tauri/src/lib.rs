// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// `latte_editor::build_builder()` returns a `tauri::Builder` already wired
// with `AppState`, the setup that captures the default workspace, and the
// four `cmd_*` invoke handlers. We add the Tauri context (config + capabilities)
// here because that lives in this crate.
pub fn run() {
    latte_editor::build_builder()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
