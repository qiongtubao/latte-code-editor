pub mod build;
pub mod cmd;
pub mod index;
pub mod path;
pub mod state;

use state::AppState;
use tauri::Manager;

/// Build a `tauri::Builder` pre-configured with the latte-editor commands
/// and `AppState`. The Tauri context (config, capabilities) lives in the
/// downstream crate (e.g. `apps/desktop/src-tauri`), so the caller owns
/// `.run(generate_context!())` and any platform-specific config.
pub fn build_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            // Default workspace = first CLI arg, else cwd.
            let ws = std::env::args()
                .nth(1)
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap());
            let state = app.state::<AppState>();
            *state.workspace.lock().unwrap() = Some(ws);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd::graph::cmd_definition,
            cmd::graph::cmd_references,
            cmd::graph::cmd_neighbors,
            cmd::callh::cmd_call_hierarchy,
            cmd::build::cmd_build,
            cmd::fs::cmd_list_dir,
            cmd::palette::cmd_palette_search,
        ])
}
