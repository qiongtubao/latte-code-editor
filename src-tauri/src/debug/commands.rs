//! Debug Tauri commands.
//!
//! Surfaced to the frontend to support the Debug Bar (snapshot, purge-now, log forward).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::workspace::registry::WorkspaceRegistry;

#[derive(Serialize)]
pub struct BackendSnapshot {
    pub workspaces_in_registry: usize,
    pub lsp_managers: HashMap<String, HashMap<String, String>>,
}

#[tauri::command]
pub async fn debug_dump_backend_state(
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<BackendSnapshot, String> {
    let ids = registry.ids().await;
    let mut lsp_managers: HashMap<String, HashMap<String, String>> = HashMap::new();
    for ws_id in ids {
        if let Some(snap) = registry.lsp_managers_snapshot(&ws_id).await {
            lsp_managers.insert(ws_id, snap);
        }
    }
    Ok(BackendSnapshot {
        workspaces_in_registry: registry.ids().await.len(),
        lsp_managers,
    })
}

#[tauri::command]
pub async fn debug_purge_now() -> Result<usize, String> {
    let max_age_secs: u64 = std::env::var("LATTE_DEBUG_MAX_AGE_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7)
        * 86_400;
    let max_bytes_mb: u64 = std::env::var("LATTE_DEBUG_MAX_DIR_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let dir = crate::debug::logger::log_dir_or_fallback();
    crate::debug::storage::purge_old_logs(&dir, max_age_secs, max_bytes_mb, 50)
        .map_err(|e| format!("purge failed: {e}"))
}
