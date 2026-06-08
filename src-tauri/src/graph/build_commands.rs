//! Graph 构建命令（按 workspace 路由）

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State, Window};

use latte_rs_graph::engine::TreeSitterEngine;
use latte_rs_graph::storage::SqliteStorage;
use latte_rs_graph::traits::GraphProvider;
use latte_rs_graph::types::BuildOptions;

use crate::workspace::registry::WorkspaceRegistry;

#[derive(serde::Serialize)]
pub struct BuildResult {
    pub files_scanned: usize,
    pub nodes_created: usize,
    pub edges_created: usize,
    pub errors: Vec<String>,
}

fn graph_db_path(root: &Path) -> PathBuf {
    root.join(".latte")
}

#[tauri::command]
pub async fn build_code_graph(
    app: tauri::AppHandle,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<BuildResult, String> {
    let label = window.label().to_string();
    let workspace_id = registry
        .active_for_window(&label)
        .await
        .ok_or_else(|| format!("No active workspace for window '{}'", label))?;
    let project_root = registry
        .project_root(&workspace_id)
        .await
        .ok_or_else(|| format!("Workspace '{}' not found", workspace_id))?;
    let graph_dir = graph_db_path(&project_root);

    std::fs::create_dir_all(&graph_dir)
        .map_err(|e| format!("Cannot create graph dir: {}", e))?;
    let db_path = graph_dir.join("graph.db");
    let _ = std::fs::remove_file(&db_path);

    let storage = SqliteStorage::open(&db_path)
        .map_err(|e| format!("Cannot open graph DB: {}", e))?;
    let engine = TreeSitterEngine::new(storage);

    let mut options = BuildOptions::default();
    options.project_root = project_root.to_string_lossy().to_string();

    // 进度/完成事件按 workspace id 命名空间（前端按 id 路由）
    let app_for_progress = app.clone();
    let progress_event = format!("graph-build-progress:{}", workspace_id);
    let _progress_handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = app_for_progress.emit(progress_event.as_str(), 0u32);
    });

    let stats = engine
        .build(&project_root, &options)
        .await
        .map_err(|e| format!("Build error: {}", e))?;

    let done_event = format!("graph-build-done:{}", workspace_id);
    let _ = app.emit(done_event.as_str(), true);

    Ok(BuildResult {
        files_scanned: stats.files_scanned,
        nodes_created: stats.nodes_created,
        edges_created: stats.edges_created,
        errors: stats.errors,
    })
}
