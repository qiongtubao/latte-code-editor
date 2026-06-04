mod editor;
mod graph;
mod project;

use editor::commands::EditorState;
use std::sync::Arc;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(RwLock::new(EditorState {
            buffer_manager: editor::buffer::BufferManager::new(),
            project_root: None,
        })))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                project::watcher::start_watcher(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            editor::commands::open_file,
            editor::commands::save_file,
            editor::commands::get_file_content,
            editor::commands::open_folder,
            editor::commands::list_directory,
            graph::commands::graph_get_data,
            graph::commands::graph_search,
            graph::commands::graph_find_definitions,
            graph::commands::graph_get_subgraph,
            graph::build_commands::build_code_graph,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
