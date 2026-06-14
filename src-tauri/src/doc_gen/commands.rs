//! Tauri commands for the doc-generation workflow.

use std::path::Path;

use crate::doc_gen::generate;
use crate::doc_gen::scan::{scan_project, DocSuggestion, ScanResult};

/// Walk a project root and return suggested documents.
#[tauri::command]
pub async fn scan_project_for_docs(project_root: String) -> Result<ScanResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&project_root);
        if !root.is_dir() {
            return Err(format!("not a directory: {project_root}"));
        }
        Ok(scan_project(root))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Write a stub .md file for one suggestion. Returns the absolute path.
#[tauri::command]
pub async fn write_doc_stub(
    docs_root: String,
    suggestion: DocSuggestion,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || generate::write_stub(Path::new(&docs_root), &suggestion))
        .await
        .map_err(|e| format!("join: {e}"))?
}
