use std::fs;
use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;
use crate::path::safe_path;

/// Directory names that are always hidden from the file tree, server-side.
/// Keeps the IPC payload small and the renderer logic trivial.
const HIDDEN_DIR_NAMES: &[&str] = &["node_modules", ".git", "target"];

/// 5 MiB cap on file reads. Generous for source files; rejects binaries
/// and accidental large-file slurps before they hit the IPC layer.
const MAX_READ_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
pub fn cmd_list_dir(state: State<AppState>, path: Option<String>) -> Result<Vec<FsEntry>, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    // `None` (or an empty string) means "list the workspace root".
    let p = match path.as_deref() {
        Some(s) if !s.is_empty() => safe_path(&ws, s).map_err(|e| e.to_string())?,
        _ => ws.clone(),
    };
    let mut out = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let meta = e.metadata().map_err(|e| e.to_string())?;
        let abs = e.path();
        let name_os = e.file_name();
        let name = name_os.to_string_lossy().to_string();
        // Filter hidden directories server-side. Files are not filtered by
        // name (e.g. a file literally called `target` should still show up,
        // even though a directory of that name would be hidden).
        if meta.is_dir() && HIDDEN_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }
        // Emit workspace-relative paths so the renderer can re-submit them
        // to list_dir without tripping safe_path's absolute-path rejection.
        let rel = abs
            .strip_prefix(&ws)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| PathBuf::from(&name_os));
        out.push(FsEntry {
            name,
            path: rel.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub fn cmd_read_file(state: State<AppState>, path: String) -> Result<String, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let abs = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool }
