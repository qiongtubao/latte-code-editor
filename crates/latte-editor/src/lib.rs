pub mod build;
pub mod cmd;
pub mod index;
pub mod path;
pub mod search;
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
            // T25: restore the last-open workspace from the session file
            // (written by `cmd_set_last_workspace` on the previous run).
            // If we have a persisted path, prefer it. Otherwise fall back
            // to the historical default: first CLI arg, else cwd.
            let state = app.state::<AppState>();
            crate::cmd::session::restore_into(&state);
            {
                let mut ws = state.workspace.lock().unwrap();
                if ws.is_none() {
                    *ws = Some(
                        std::env::args()
                            .nth(1)
                            .map(std::path::PathBuf::from)
                            .unwrap_or_else(|| std::env::current_dir().unwrap()),
                    );
                }
            }
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
            cmd::search::cmd_semantic_search,
            cmd::session::cmd_get_last_workspace,
            cmd::session::cmd_set_last_workspace,
        ])
}
