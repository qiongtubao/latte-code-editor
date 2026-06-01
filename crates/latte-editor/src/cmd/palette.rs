use crate::state::AppState;
use crate::path::safe_path;
use tauri::State;

#[derive(serde::Serialize)]
pub struct Hit { pub kind: String, pub label: String, pub detail: Option<String>, pub path: Option<String>, pub line: Option<u32> }

#[tauri::command]
pub fn cmd_palette_search(state: State<AppState>, mode: String, term: String, limit: u32) -> Result<Vec<Hit>, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    match mode.as_str() {
        "cmd" => Ok(vec![Hit{kind:"cmd".into(),label:format!("> {term}"),detail:None,path:None,line:None}]),
        "symbol" => Ok(vec![]),  // filled in T22 via semantic
        _ => search_files(&ws, &term, limit).map_err(|e| e.to_string()),
    }
}

fn search_files(root: &std::path::Path, term: &str, limit: u32) -> std::io::Result<Vec<Hit>> {
    use ignore::WalkBuilder;
    // Reject empty/whitespace-only terms here so the file walk doesn't
    // match every entry (any path contains ""). The renderer normally
    // guards on `!q`, but defending at the boundary is cheap.
    if term.trim().is_empty() { return Ok(Vec::new()); }
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root).max_depth(Some(8)).build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        let p = entry.path();
        if p.to_string_lossy().contains(term) {
            let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().to_string();
            let safe = safe_path(root, &rel).is_ok();
            if !safe { continue; }
            out.push(Hit { kind: "file".into(), label: rel.clone(), detail: None, path: Some(rel), line: None });
            if out.len() as u32 >= limit { break; }
        }
    }
    Ok(out)
}
