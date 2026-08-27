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
///
/// `docs_root` 由前端拼成 `${folderRoot}/${docsInputDir}`，而 `docsInputDir`
/// 是用户可改的设置项——填 `../..` 就能把文档写到工作区外。因此这里必须做
/// 与 editor 命令同一套的工作区包含性校验。
#[tauri::command]
pub async fn write_doc_stub(
    docs_root: String,
    suggestion: DocSuggestion,
    all_suggestions: Option<Vec<DocSuggestion>>,
    window: tauri::Window,
    registry: tauri::State<'_, std::sync::Arc<crate::workspace::registry::WorkspaceRegistry>>,
) -> Result<String, String> {
    let docs_root = crate::editor::commands::resolve_workspace_subpath(
        &window, &registry, &docs_root,
    )
    .await?;
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
        generate::write_stub(&docs_root, &suggestion, &related)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
