use crate::editor::commands::EditorState;
use crate::graph::codegraph;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

#[derive(Serialize)]
pub struct GraphResponse {
    pub data: codegraph::GraphData,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub nodes: Vec<codegraph::GraphNode>,
}

#[derive(Serialize)]
pub struct SubgraphResponse {
    pub data: codegraph::GraphData,
}

/// Resolve the project root and find .codegraph/ directory.
/// First checks EditorState.project_root, then falls back to current_dir.
fn find_graph_dir(state: &EditorState) -> Result<PathBuf, String> {
    // Try project_root first (set by open_folder)
    if let Some(root) = &state.project_root {
        let graph_dir = root.join(".codegraph");
        if graph_dir.exists() {
            return Ok(graph_dir);
        }
    }

    // Fallback to current working directory
    if let Ok(cwd) = std::env::current_dir() {
        let graph_dir = cwd.join(".codegraph");
        if graph_dir.exists() {
            return Ok(graph_dir);
        }
    }
    Err("No .codegraph/ directory found. Open a folder that contains code graph data, or run the graph build tool first.".to_string())
}

#[tauri::command]
pub async fn graph_get_data(
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<GraphResponse, String> {
    let graph_dir = {
        let editor = state.read().await;
        find_graph_dir(&editor)?
    };

    // Run SQLite query in a blocking thread to avoid blocking async
    let data = tokio::task::spawn_blocking(move || {
        codegraph::load_graph(&graph_dir)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Graph load error: {}", e))?;

    Ok(GraphResponse { data })
}

#[tauri::command]
pub async fn graph_search(
    query: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<SearchResponse, String> {
    let graph_dir = {
        let editor = state.read().await;
        find_graph_dir(&editor)?
    };

    let nodes = tokio::task::spawn_blocking(move || {
        codegraph::search_nodes(&graph_dir, &query, 100)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Search error: {}", e))?;

    Ok(SearchResponse { nodes })
}
#[tauri::command]
pub async fn graph_find_definitions(
    name: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<SearchResponse, String> {
    let graph_dir = {
        let editor = state.read().await;
        find_graph_dir(&editor)?
    };

    let nodes = tokio::task::spawn_blocking(move || {
        codegraph::find_definitions(&graph_dir, &name, 50)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Find definitions error: {}", e))?;

    Ok(SearchResponse { nodes })
}

#[tauri::command]
pub async fn graph_get_subgraph(
    node_id: String,
    depth: u32,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<SubgraphResponse, String> {
    let graph_dir = {
        let editor = state.read().await;
        find_graph_dir(&editor)?
    };

    let data = tokio::task::spawn_blocking(move || {
        codegraph::get_subgraph(&graph_dir, &node_id, depth)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Subgraph error: {}", e))?;

    Ok(SubgraphResponse { data })
}
