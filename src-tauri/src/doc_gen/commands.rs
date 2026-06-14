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

/// Write a stub .md file for one suggestion. The `all_suggestions` list is
/// used to add [[related]] links between same-type docs. Returns the path.
#[tauri::command]
pub async fn write_doc_stub(
    docs_root: String,
    suggestion: DocSuggestion,
    all_suggestions: Option<Vec<DocSuggestion>>,
) -> Result<String, String> {
    let related = all_suggestions
        .map(|all| {
            all.iter()
                .filter(|s| s.doc_type == suggestion.doc_type && s.title != suggestion.title)
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        generate::write_stub(Path::new(&docs_root), &suggestion, &related)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
