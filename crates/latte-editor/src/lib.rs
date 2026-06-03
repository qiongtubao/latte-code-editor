pub mod build;
pub mod cmd;
pub mod index;
pub mod path;
pub mod search;
pub mod state;

use state::AppState;
use tauri::{DragDropEvent, Manager, WindowEvent};

/// Build a `tauri::Builder` pre-configured with the latte-editor commands
/// and `AppState`. The Tauri context (config, capabilities) lives in the
/// downstream crate (e.g. `apps/desktop/src-tauri`), so the caller owns
/// `.run(generate_context!())` and any platform-specific config.
pub fn build_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                if let Some(first) = paths.first() {
                    if first.is_dir() {
                        // Route through the same helper the IPC command uses
                        // so drag-drop also persists the session file and
                        // emits `workspace-changed` to the renderer.
                        let state = window.state::<AppState>();
                        let app = window.app_handle();
                        let _ = crate::cmd::picker::apply_workspace(app, &state, first);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            cmd::graph::cmd_definition,
            cmd::graph::cmd_references,
            cmd::graph::cmd_neighbors,
            cmd::callh::cmd_call_hierarchy,
            cmd::build::cmd_build,
            cmd::fs::cmd_list_dir,
            cmd::fs::cmd_read_file,
            cmd::palette::cmd_palette_search,
            cmd::search::cmd_semantic_search,
            cmd::session::cmd_get_last_workspace,
            cmd::session::cmd_set_last_workspace,
            cmd::userhook::cmd_user_hook,
            cmd::workspace::cmd_get_workspace,
            cmd::picker::cmd_pick_folder,
            cmd::picker::cmd_set_workspace,
        ])
}
