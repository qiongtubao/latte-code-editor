//! Graph 查询命令
//!
//! 所有命令按 window label 路由到当前 workspace，从该 workspace 的 project_root 推 .latte/。

use crate::graph::codegraph;
use crate::workspace::registry::WorkspaceRegistry;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{State, Window};

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

async fn resolve_graph_dir(
    window: &Window,
    registry: &Arc<WorkspaceRegistry>,
) -> Result<PathBuf, String> {
    let label = window.label().to_string();
    let id = registry
        .active_for_window(&label)
        .await
        .ok_or_else(|| format!("No active workspace for window '{}'", label))?;
    let root = registry
        .project_root(&id)
        .await
        .ok_or_else(|| format!("Workspace '{}' not found", id))?;
    let graph_dir = root.join(".latte");
    if graph_dir.exists() {
        Ok(graph_dir)
    } else {
        Err(format!(
            "No .latte/ directory in workspace '{}'",
            root.display()
        ))
    }
}

#[tauri::command]
pub async fn graph_get_data(
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<GraphResponse, String> {
    let graph_dir = resolve_graph_dir(&window, &registry).await?;
    let data = tokio::task::spawn_blocking(move || codegraph::load_graph(&graph_dir))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Graph load error: {}", e))?;
    Ok(GraphResponse { data })
}

#[tauri::command]
pub async fn graph_search(
    query: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<SearchResponse, String> {
    let graph_dir = resolve_graph_dir(&window, &registry).await?;
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
    caller_path: Option<String>,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<SearchResponse, String> {
    let label = window.label().to_string();
    let id = registry
        .active_for_window(&label)
        .await
        .ok_or_else(|| format!("No active workspace for window '{}'", label))?;
    let project_root = registry
        .project_root(&id)
        .await
        .ok_or_else(|| format!("Workspace '{}' not found", id))?;
    let graph_dir = project_root.join(".latte");
    if !graph_dir.exists() {
        return Err(format!("No .latte/ directory in workspace '{}'", project_root.display()));
    }

    let nodes = tokio::task::spawn_blocking(move || {
        // Strip project_root prefix so caller_path matches DB's relative file_path
        let relative_caller = caller_path
            .as_deref()
            .and_then(|p| std::path::Path::new(p).strip_prefix(&project_root).ok())
            .and_then(|r| r.to_str())
            .unwrap_or("");
        codegraph::find_definitions(&graph_dir, &name, relative_caller, 200)
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
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<SubgraphResponse, String> {
    let graph_dir = resolve_graph_dir(&window, &registry).await?;
    let data = tokio::task::spawn_blocking(move || {
        codegraph::get_subgraph(&graph_dir, &node_id, depth)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Subgraph error: {}", e))?;
    Ok(SubgraphResponse { data })
}

#[tauri::command]
pub async fn graph_resolve_call(
    file_path: String,
    line: u32,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Option<codegraph::GraphNode>, String> {
    let graph_dir = resolve_graph_dir(&window, &registry).await?;
    let result = tokio::task::spawn_blocking(move || {
        codegraph::resolve_call(&graph_dir, &file_path, line)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Resolve call error: {}", e))?;
    Ok(result)
}
