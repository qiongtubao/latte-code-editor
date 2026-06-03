use crate::state::AppState;
use latte_graph_adapter::{definition, references};
use tauri::State;

#[derive(serde::Serialize)]
pub struct CallNode {
    pub name: String,
    pub file: String,
    pub line: u32,
    pub role: String, // "caller" | "callee"
}

#[tauri::command]
pub fn cmd_call_hierarchy(
    state: State<AppState>,
    symbol: String,
) -> Result<Vec<CallNode>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("graph index not initialized")?;
    let callers = references(db, &symbol, 100).map_err(|e| e.to_string())?; // cap so a noisy symbol can't blow up the drawer
    let def = definition(db, &symbol).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for c in callers {
        if c.kind == "call" {
            out.push(CallNode {
                name: symbol.clone(),
                file: c.location.file,
                line: c.location.line,
                role: "caller".into(),
            });
        }
    }
    if let Some(loc) = def {
        out.push(CallNode {
            name: symbol,
            file: loc.file,
            line: loc.line,
            role: "callee".into(),
        });
    }
    Ok(out)
}
