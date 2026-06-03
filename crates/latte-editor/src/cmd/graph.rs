use crate::state::AppState;
use latte_graph_adapter::{definition, neighbors, references, Location, Neighbor, Reference};
use tauri::State;

#[tauri::command]
pub fn cmd_definition(
    state: State<AppState>,
    symbol: String,
) -> Result<Option<Location>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("graph index not initialized")?;
    definition(db, &symbol).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_references(
    state: State<AppState>,
    symbol: String,
    limit: Option<u32>,
) -> Result<Vec<Reference>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("graph index not initialized")?;
    references(db, &symbol, limit.unwrap_or(200)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_neighbors(
    state: State<AppState>,
    node_id: String,
    depth: Option<u32>,
) -> Result<Vec<Neighbor>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("graph index not initialized")?;
    neighbors(db, &node_id, depth.unwrap_or(2)).map_err(|e| e.to_string())
}
