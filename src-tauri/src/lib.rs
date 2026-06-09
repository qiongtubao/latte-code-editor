mod editor;
mod graph;
mod project;
mod settings;
mod settings_commands;
mod workspace;

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
            // Initialise the settings store + incremental graph hub.
            // The hub runs in its own thread and bridges the
            // workspace::watcher events to the engine. The settings
            // store is created here (not via `.manage`) so we can
            // wrap it in `Arc` and share it with the hub.
            let data_dir = app.path().app_data_dir().ok();
            if let Some(dir) = data_dir {
                let store = Arc::new(SettingsStore::new(dir));
                let hub = IncrementalHub::start(app.handle().clone(), (*store).clone());
                app.manage(store);
                app.manage(hub);
            }
            // 启动时恢复持久化的 workspace 列表 + 为每个 workspace 启动文件监听
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                init_workspaces(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            editor::commands::open_file,
            editor::commands::save_file,
            editor::commands::get_file_content,
            editor::commands::open_folder,
            editor::commands::list_directory,
            editor::commands::create_file,
            editor::commands::create_folder,
            editor::commands::delete_entry,
            editor::commands::search_in_files,
            editor::commands::replace_in_files,
            editor::commands::find_files,
            graph::commands::graph_search,
            graph::commands::graph_find_definitions,
            graph::commands::graph_get_subgraph,
            graph::build_commands::build_code_graph,
            graph::build_commands::update_code_graph,
            workspace::commands::list_workspaces,
            workspace::commands::new_workspace,
            workspace::commands::close_workspace,
            workspace::commands::set_active_workspace,
            workspace::commands::update_workspace_meta,
            workspace::commands::detach_workspace_to_window,
            settings_commands::get_graph_settings,
            settings_commands::get_app_settings,
            settings_commands::set_graph_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 启动时初始化：从 app_data_dir 读 state.json 恢复 workspace 列表，
/// 为每个 workspace 启动文件监听器。
async fn init_workspaces(app: tauri::AppHandle) {
    let registry: tauri::State<Arc<WorkspaceRegistry>> = app.state();
    let pers = match app.path().app_data_dir() {
        Ok(dir) => Persistence::new(dir),
        Err(e) => {
            eprintln!("[setup] cannot resolve app_data_dir: {}", e);
            return;
        }
    };
    let snap = pers.load().await;
    if let Err(e) = registry.restore(snap).await {
        eprintln!("[setup] restore workspaces failed: {}", e);
    }
    // 为每个已恢复的 workspace 启动监听器
    let hub: tauri::State<Arc<IncrementalHub>> = app.state();
    for ws_id in registry.ids().await {
        let project_root = match registry.project_root(&ws_id).await {
            Some(r) => r,
            None => continue,
        };
        match crate::workspace::watcher::WorkspaceWatcher::start(
            &project_root,
            hub.inner().clone(),
            ws_id.clone(),
        ) {
            Ok(watcher) => {
                if let Err(e) = registry.attach_watcher(&ws_id, watcher).await {
                    eprintln!("[setup] attach watcher for {} failed: {}", ws_id, e);
                }
            }
            Err(e) => eprintln!("[setup] start watcher for {} failed: {}", ws_id, e),
        }
    }
}
