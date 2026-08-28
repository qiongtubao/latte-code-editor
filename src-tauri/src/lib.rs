mod editor;
mod graph;
mod settings;
mod settings_commands;
mod workspace;
mod debug;
mod ai;
use std::sync::Arc;
mod doc_gen;
pub mod chat_panel;
mod screenshot;
use tauri::Manager;

use crate::graph::incremental::IncrementalHub;
use crate::settings::SettingsStore;
use crate::workspace::persistence::Persistence;
use crate::workspace::registry::WorkspaceRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(WorkspaceRegistry::new()))
        .setup(|app| {
            // Initialise debug-mode logging (no-op unless LATTE_DEBUG=1).
            let data_dir_for_debug = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
            debug::logger::init(data_dir_for_debug.clone());
            // Purge old debug logs on startup (env-tunable thresholds).
            let max_age_secs: u64 = std::env::var("LATTE_DEBUG_MAX_AGE_DAYS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(7) * 86_400;
            let max_bytes_mb: u64 = std::env::var("LATTE_DEBUG_MAX_DIR_MB")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(500);
            let debug_dir = data_dir_for_debug.join("debug");
            match debug::storage::purge_old_logs(&debug_dir, max_age_secs, max_bytes_mb, 50) {
                Ok(removed) => tracing::info!(event = "debug.log.purged", removed, "purged old debug logs"),
                Err(e) => tracing::warn!(event = "debug.log.purge_error", error = %e, "purge failed"),
            }
            let data_dir = app.path().app_data_dir().ok();
            if let Some(dir) = &data_dir {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    eprintln!("[setup] Failed to create app_data_dir: {}", e);
                }
            }
            // Pin CWD to the app's data dir so relative paths in
            // roles.yaml (prompt_file, etc.) resolve correctly.
            // Desktop Tauri starts with `cwd` set to the working
            // directory of the launcher binary (`tauri dev` / .app
            // bundle root), which is rarely the user's project root
            // or the config directory. This caused `prompt_file:
            // "prompts/manager.md"` to look in the bundle root
            // rather than `~/.latte-code-editor/prompts/manager.md`.
            if let Some(dir) = &data_dir {
                let _ = std::env::set_current_dir(dir);
            }
            let settings_store = Arc::new(SettingsStore::new(data_dir.unwrap_or_else(|| std::env::temp_dir())));
            let hub = IncrementalHub::start(app.handle().clone(), (*settings_store).clone());
            app.manage(settings_store);
            app.manage(hub);

            // chat 面板后端（ui-embedding-design.md §3 阶段 2）：
            // 进程内 Tauri commands + 事件，按工作区 get-or-spawn
            // UiBackend 容器。懒加载：首个 ui_* 命令触发，不在启动时预热。
            app.manage(Arc::new(chat_panel::ui_adapter::UiAdapterState::new()));

            // 启动时恢复持久化的 workspace 列表
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                init_workspaces(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // editor
            crate::editor::commands::open_folder,
            crate::editor::commands::list_directory,
            crate::editor::commands::create_file,
            crate::editor::commands::create_folder,
            crate::editor::commands::delete_entry,
            crate::editor::commands::open_file,
            crate::editor::commands::save_file,
            crate::editor::commands::get_file_content,
            crate::editor::commands::refresh_file,
            crate::editor::commands::check_file_changed,
            crate::editor::commands::search_in_files,
            crate::editor::commands::replace_in_files,
            crate::editor::commands::find_files,
            // workspace
            crate::workspace::commands::list_workspaces,
            crate::workspace::commands::set_active_workspace,
            crate::workspace::commands::close_workspace,
            crate::workspace::commands::update_workspace_meta,
            crate::workspace::commands::new_workspace,
            crate::workspace::commands::detach_workspace_to_window,
            // graph
            crate::graph::commands::graph_get_data,
            crate::graph::commands::graph_search,
            crate::graph::commands::graph_find_definitions,
            crate::graph::commands::graph_get_subgraph,
            crate::graph::commands::graph_resolve_call,
            crate::graph::build_commands::build_code_graph,
            crate::graph::build_commands::update_code_graph,
            // settings
            crate::settings_commands::get_graph_settings,
            crate::settings_commands::get_app_settings,
            crate::settings_commands::set_graph_settings,
            // debug
            crate::debug::commands::debug_dump_backend_state,
            crate::debug::commands::debug_purge_now,
            // ai
            crate::ai::commands::ai_review,
            // screenshot（StatusBar 的 📷 / Ctrl+Shift+S）
            crate::screenshot::screenshot_window,
            // doc_gen
            crate::doc_gen::commands::scan_project_for_docs,
            crate::doc_gen::commands::write_doc_stub,
            // chat panel (multi-agent)
            crate::chat_panel::commands::chat_list_workflows,
            crate::chat_panel::commands::chat_list_roles,
            crate::chat_panel::commands::chat_start_discussion,
            crate::chat_panel::commands::chat_cancel,
            crate::chat_panel::commands::chat_cancel_workspace,
            crate::chat_panel::commands::chat_list_models,
            crate::chat_panel::commands::chat_get_role_config,
            crate::chat_panel::commands::chat_set_role_model,
            crate::chat_panel::commands::chat_set_role_model_chain,
            crate::chat_panel::commands::chat_set_default_model,
            crate::chat_panel::commands::chat_open_config,
            crate::chat_panel::commands::chat_save_workflow,
            crate::chat_panel::commands::chat_delete_workflow,
            crate::chat_panel::commands::chat_get_workflow_full,
            crate::chat_panel::commands::chat_reset_roles_to_defaults,
            crate::chat_panel::commands::chat_hil_start,
            crate::chat_panel::commands::chat_hil_send,
            crate::chat_panel::commands::chat_hil_edit_message,
            crate::chat_panel::commands::chat_hil_inject,
            crate::chat_panel::commands::chat_hil_continue,
            crate::chat_panel::commands::chat_hil_transition,
            crate::chat_panel::commands::chat_hil_get_state,
            crate::chat_panel::commands::chat_hil_list_sessions,
            crate::chat_panel::commands::chat_controller_spawn,
            crate::chat_panel::commands::chat_controller_submit,
            crate::chat_panel::commands::chat_controller_pause,
            crate::chat_panel::commands::chat_controller_resume,
            crate::chat_panel::commands::chat_controller_abort,
            crate::chat_panel::commands::chat_session_list,
            crate::chat_panel::commands::chat_session_get,
            crate::chat_panel::commands::chat_session_delete,
            crate::chat_panel::commands::chat_session_edit_message,
            // single-role chat replica (latte-agent chat CLI in HTML)
            crate::chat_panel::chat_stream::chat_stream,
            // agent UI (iframe) IPC transport — ui_* commands + ui:chat_event /
            // ui:self_loop_event 事件（ui-embedding-design.md §3 阶段 2）
            crate::chat_panel::ui_adapter::ui_sessions_list,
            crate::chat_panel::ui_adapter::ui_sessions_create,
            crate::chat_panel::ui_adapter::ui_sessions_get,
            crate::chat_panel::ui_adapter::ui_sessions_delete,
            crate::chat_panel::ui_adapter::ui_sessions_set_label,
            crate::chat_panel::ui_adapter::ui_sessions_history,
            crate::chat_panel::ui_adapter::ui_roles_list,
            crate::chat_panel::ui_adapter::ui_roles_config_get,
            crate::chat_panel::ui_adapter::ui_roles_config_save,
            crate::chat_panel::ui_adapter::ui_chat_send,
            crate::chat_panel::ui_adapter::ui_chat_command,
            crate::chat_panel::ui_adapter::ui_chat_role,
            crate::chat_panel::ui_adapter::ui_traces_list,
            crate::chat_panel::ui_adapter::ui_traces_get,
            crate::chat_panel::ui_adapter::ui_subsessions_get,
            crate::chat_panel::ui_adapter::ui_role_graph,
            crate::chat_panel::ui_adapter::ui_self_loop_start,
            crate::chat_panel::ui_adapter::ui_self_loop_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
/// 启动时初始化：从 app_data_dir 读 state.json 恢复 workspace 列表
async fn init_workspaces(app: tauri::AppHandle) {
    let registry: tauri::State<Arc<WorkspaceRegistry>> = app.state();
    
    let pers = match app.path().app_data_dir() {
        Ok(dir) => Persistence::new(dir),
        Err(e) => {
            eprintln!("[setup] Failed to get app_data_dir: {}", e);
            return;
        }
    };
    
    let snap = pers.load().await;
    if let Err(e) = registry.restore(snap).await {
        eprintln!("[setup] restore workspaces failed: {}", e);
    }

    // restore 之后必须设置 window→workspace 映射，否则 graph_get_data 等命令
    // 在 resolve_graph_dir 中调用 active_for_window() 会返回 None，导致图谱数据
    // 永远加载不到。App.tsx 的 hydrate+requestReload 依赖此映射。
    let ids = registry.ids().await;
    if !ids.is_empty() {
        let first = &ids[0];
        if let Err(e) = registry.set_active("main", first).await {
            eprintln!("[setup] set_active failed: {}", e);
        }
    }
}