mod editor;
mod graph;
mod project;
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
            let settings_store = Arc::new(SettingsStore::new(data_dir.unwrap_or_else(|| std::env::temp_dir())));
            let hub = IncrementalHub::start(app.handle().clone(), (*settings_store).clone());
            app.manage(settings_store);
            app.manage(hub);
            
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
            // doc_gen
            crate::doc_gen::commands::scan_project_for_docs,
            crate::doc_gen::commands::write_doc_stub,
            // chat panel (multi-agent)
            crate::chat_panel::commands::chat_list_workflows,
            crate::chat_panel::commands::chat_list_roles,
            crate::chat_panel::commands::chat_start_discussion,
            crate::chat_panel::commands::chat_continue,
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
            crate::chat_panel::commands::chat_list_workflows_full,
            crate::chat_panel::commands::chat_reset_roles_to_defaults,
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