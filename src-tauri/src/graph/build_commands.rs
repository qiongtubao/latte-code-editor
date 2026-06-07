use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::RwLock;

use latte_rs_graph::engine::TreeSitterEngine;
use latte_rs_graph::storage::SqliteStorage;
use latte_rs_graph::traits::GraphProvider;
use latte_rs_graph::types::BuildOptions;

use crate::editor::commands::EditorState;

/// Result sent back to the frontend after a graph build.
#[derive(serde::Serialize)]
pub struct BuildResult {
    pub files_scanned: usize,
    pub nodes_created: usize,
    pub edges_created: usize,
    pub errors: Vec<String>,
}

/// Resolve the graph database path for a project root.
fn graph_db_path(root: &Path) -> PathBuf {
    root.join(".latte")
}

#[tauri::command]
pub async fn build_code_graph(
    app: tauri::AppHandle,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<BuildResult, String> {
    let project_root: PathBuf = {
        let editor = state.read().await;
        editor
            .project_root
            .clone()
            .ok_or_else(|| "No folder opened".to_string())?
    };

    let graph_dir = graph_db_path(&project_root);

    // Ensure directory exists and start with a fresh database
    std::fs::create_dir_all(&graph_dir)
        .map_err(|e| format!("Cannot create graph dir: {}", e))?;
    let db_path = graph_dir.join("graph.db");
    let _ = std::fs::remove_file(&db_path);

    let storage =
        SqliteStorage::open(&db_path).map_err(|e| format!("Cannot open graph DB: {}", e))?;
    let engine = TreeSitterEngine::new(storage);

    let mut options = BuildOptions::default();
    options.project_root = project_root.to_string_lossy().to_string();

    // Emit build progress event
    let app_for_progress = app.clone();
    let _progress_handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = app_for_progress.emit("graph-build-progress", 0u32);
    });

    let stats = engine
        .build(&project_root, &options)
        .await
        .map_err(|e| format!("Build error: {}", e))?;

    let _ = app.emit("graph-build-done", true);

    Ok(BuildResult {
        files_scanned: stats.files_scanned,
        nodes_created: stats.nodes_created,
        edges_created: stats.edges_created,
        errors: stats.errors,
    })
}
