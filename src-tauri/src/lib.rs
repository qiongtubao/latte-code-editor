mod editor;
mod graph;
mod project;
mod settings;
mod settings_commands;
mod workspace;
mod debug;

use std::sync::Arc;
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
        .manage(Arc::new(WorkspaceRegistry::new()))
        .setup(|app| {
            // Initialise debug-mode logging (no-op unless LATTE_DEBUG=1).
            debug::logger::init(app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()));
            // Initialise the settings store + incremental graph hub.
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