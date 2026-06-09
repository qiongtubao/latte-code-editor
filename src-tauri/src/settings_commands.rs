//! IPC commands for the user-facing settings store.

use std::sync::Arc;

use tauri::State;

use crate::graph::incremental::IncrementalHub;
use crate::settings::{AppSettings, GraphSettings, SettingsStore};

/// Read the current settings. Always returns a value — the store
/// never errors on read; it falls back to defaults on corrupt or
/// missing files.
#[tauri::command]
pub async fn get_graph_settings(
    store: State<'_, Arc<SettingsStore>>,
) -> Result<GraphSettings, String> {
    let s = store.load().await;
    Ok(s.graph)
}

/// Read the full settings struct (graph + future categories). Kept
/// alongside the graph-only getter for parity.
#[tauri::command]
pub async fn get_app_settings(
    store: State<'_, Arc<SettingsStore>>,
) -> Result<AppSettings, String> {
    Ok(store.load().await)
}

/// Persist a new graph settings struct, then push it to the running
/// hub so the next debounced batch uses the updated values.
#[tauri::command]
pub async fn set_graph_settings(
    new_graph: GraphSettings,
    store: State<'_, Arc<SettingsStore>>,
    hub: State<'_, IncrementalHub>,
) -> Result<(), String> {
    let mut s = store.load().await;
    s.graph = new_graph.clone();
    store.save(&s).await?;
    hub.update_settings(s);
    Ok(())
}
