use std::fs;
use tauri::State;
use crate::state::AppState;
use crate::path::safe_path;

#[tauri::command]
pub fn cmd_list_dir(state: State<AppState>, path: String) -> Result<Vec<FsEntry>, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let p = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let meta = e.metadata().map_err(|e| e.to_string())?;
        let abs = e.path();
        let name_os = e.file_name();
        // Emit workspace-relative paths so the renderer can re-submit them
        // to list_dir without tripping safe_path's absolute-path rejection.
        let rel = abs
            .strip_prefix(&ws)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| std::path::PathBuf::from(&name_os));
        out.push(FsEntry {
            name: name_os.to_string_lossy().to_string(),
            path: rel.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    out.sort_by(|a,b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool }
