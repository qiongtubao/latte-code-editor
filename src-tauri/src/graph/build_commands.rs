use crate::editor::commands::EditorState;
use crate::graph::builder;
use serde::Serialize;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::RwLock;

#[derive(Serialize)]
pub struct BuildResult {
    pub files_scanned: usize,
    pub nodes_created: usize,
    pub edges_created: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn build_code_graph(
    app: tauri::AppHandle,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<BuildResult, String> {
    let project_root = {
        let editor = state.read().await;
        editor.project_root.clone().ok_or_else(|| "No folder opened".to_string())?
    };

    let progress = Arc::new(AtomicUsize::new(0));
    let progress_clone = progress.clone();
    let app_clone = app.clone();

    // Emit progress
    let app_progress = app.clone();
    let prog = progress.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let current = prog.load(std::sync::atomic::Ordering::Relaxed);
            let _ = app_progress.emit("graph-build-progress", current);
            if current > 0 && prog.load(std::sync::atomic::Ordering::Relaxed) == current {
                // No change for 200ms, might be done
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if prog.load(std::sync::atomic::Ordering::Relaxed) == current {
                    break;
                }
            }
        }
    });

    let stats = tokio::task::spawn_blocking(move || {
        builder::build_graph(&project_root, progress_clone)
    })
    .await
    .map_err(|e| format!("Build task error: {}", e))?
    .map_err(|e| format!("Build error: {}", e))?;

    let _ = app_clone.emit("graph-build-done", true);

    Ok(BuildResult {
        files_scanned: stats.files_scanned,
        nodes_created: stats.nodes_created,
        edges_created: stats.edges_created,
        errors: stats.errors,
    })
}
