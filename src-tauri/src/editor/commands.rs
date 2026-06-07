use crate::editor::buffer::BufferManager;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

pub struct EditorState {
    pub buffer_manager: BufferManager,
    pub project_root: Option<PathBuf>,
}

/// A filesystem entry returned to the frontend
#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// A folder open result
#[derive(Serialize)]
pub struct OpenFolderResult {
    pub root: String,
    pub entries: Vec<FsEntry>,
    pub has_graph: bool,
    pub graph_node_count: usize,
}


#[derive(Serialize)]
pub struct FileResult {
    pub path: String,
    pub content: String,
    pub line_count: usize,
    pub is_large_file: bool,
    pub is_modified: bool,
}
#[tauri::command]
pub async fn open_folder(
    path: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<OpenFolderResult, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let canonical = dir_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    // Store project root
    {
        let mut editor = state.write().await;
        editor.project_root = Some(canonical.clone());
    }
    // Check for existing graph — validate the schema actually works
    let graph_db = canonical.join(".latte").join("graph.db");
    let (has_graph, graph_node_count) = if graph_db.exists() {
        match rusqlite::Connection::open(&graph_db) {
            Ok(conn) => {
                // Verify the DB has a valid schema with qualified_name column
                let schema_ok = conn
                    .query_row(
                        "SELECT qualified_name FROM nodes LIMIT 1",
                        [],
                        |_| Ok(()),
                    )
                    .is_ok();

                if !schema_ok {
                    // Stale database from old version — delete and rebuild
                    drop(conn);
                    let _ = std::fs::remove_file(&graph_db);
                    (false, 0)
                } else {
                    let count = conn
                        .query_row("SELECT COUNT(*) FROM nodes", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .ok()
                        .map(|c| c as usize)
                        .unwrap_or(0);
                    (true, count)
                }
            }
            Err(_) => (false, 0),
        }
    } else {
        (false, 0)
    };


    let entries = list_dir_inner(canonical.as_path())?;

    Ok(OpenFolderResult {
        root: canonical.to_string_lossy().to_string(),
        entries,
        has_graph,
        graph_node_count,
    })
}

#[tauri::command]
pub async fn list_directory(
    path: String,
) -> Result<Vec<FsEntry>, String> {
    list_dir_inner(Path::new(&path))
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent directory: {}", e))?;
    }
    std::fs::write(p, "")
        .map_err(|e| format!("Cannot create file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    std::fs::create_dir_all(std::path::Path::new(&path))
        .map_err(|e| format!("Cannot create folder: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_entry(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir(p)
            .map_err(|e| format!("Cannot remove directory: {}", e))?;
    } else {
        std::fs::remove_file(p)
            .map_err(|e| format!("Cannot remove file: {}", e))?;
    }
    Ok(())
}

fn list_dir_inner(path: &Path) -> Result<Vec<FsEntry>, String> {
    let mut entries: Vec<FsEntry> = Vec::new();

    let read_dir = std::fs::read_dir(path)
        .map_err(|e| format!("Cannot read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Cannot read entry: {}", e))?;
        let entry_path = entry.path();

        // Skip hidden files/directories
        if entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false)
        {
            continue;
        }

        // Skip node_modules and target
        if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
            if name == "node_modules" || name == "target" {
                continue;
            }
        }

        let metadata = entry.metadata().ok();

        entries.push(FsEntry {
            name: entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string(),
            path: entry_path.to_string_lossy().to_string(),
            is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            is_symlink: metadata.as_ref().map(|m| m.is_symlink()).unwrap_or(false),
        });
    }

    // Sort: directories first, then files; alphabetical
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

#[tauri::command]
pub async fn open_file(
    path: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<FileResult, String> {
    // Resolve relative paths against project_root
    let resolved_path = {
        let editor = state.read().await;
        let raw = std::path::Path::new(&path);
        if raw.is_relative() {
            if let Some(root) = &editor.project_root {
                root.join(raw)
            } else {
                raw.to_path_buf()
            }
        } else {
            raw.to_path_buf()
        }
    };
    let buf = {
        let editor = state.read().await;
        editor.buffer_manager.open(&resolved_path).await?
    };

    let reader = buf.read().await;
    Ok(FileResult {
        path: reader.path.to_string_lossy().to_string(),
        content: reader.content.clone(),
        line_count: reader.line_count,
        is_large_file: reader.is_large_file,
        is_modified: reader.is_modified,
    })
}

#[tauri::command]
pub async fn save_file(
    path: String,
    content: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);

    // Update buffer content in memory
    {
        let editor = state.read().await;
        let buf = editor
            .buffer_manager
            .get_buffer(file_path)
            .await
            .ok_or_else(|| "Buffer not found".to_string())?;
        let mut writer = buf.write().await;
        writer.content = content.clone();
        writer.is_modified = true;
    }

    // Save to disk
    {
        let editor = state.read().await;
        editor.buffer_manager.save(file_path).await
    }
}

#[tauri::command]
pub async fn get_file_content(
    path: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<FileResult, String> {
    let editor = state.read().await;
    let file_path = std::path::Path::new(&path);
    let buf = editor
        .buffer_manager
        .get_buffer(file_path)
        .await
        .ok_or_else(|| "Buffer not found".to_string())?;

    let reader = buf.read().await;
    Ok(FileResult {
        path: reader.path.to_string_lossy().to_string(),
        content: reader.content.clone(),
        line_count: reader.line_count,
        is_large_file: reader.is_large_file,
        is_modified: reader.is_modified,
    })
}


/// Search for text across all source files
#[tauri::command]
pub async fn search_in_files(
    query: String,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<Vec<super::search::SearchMatch>, String> {
    let project_root = {
        let editor = state.read().await;
        editor.project_root.clone().ok_or_else(|| "No folder opened".to_string())?
    };
    let exclude_dirs = vec![
        "node_modules".into(), "target".into(), ".git".into(),
        "dist".into(), "build".into(), "deps".into(),
        ".venv".into(), ".latte".into(),
    ];
    let opts = super::search::SearchOptions {
        query,
        max_results: 100,
        exclude_dirs,
        include_glob,
        exclude_glob,
    };
    let results = tokio::task::spawn_blocking(move || {
        super::search::search_text(&project_root, &opts)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    Ok(results)
}
/// Replace text across all source files
#[derive(serde::Serialize)]
pub struct ReplaceFileResult {
    pub file_path: String,
    pub count: usize,
}

#[tauri::command]
pub async fn replace_in_files(
    query: String,
    replacement: String,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<Vec<ReplaceFileResult>, String> {
    let project_root = {
        let editor = state.read().await;
        editor.project_root.clone().ok_or_else(|| "No folder opened".to_string())?
    };
    let exclude_dirs = vec![
        "node_modules".into(), "target".into(), ".git".into(),
        "dist".into(), "build".into(), "deps".into(),
        ".venv".into(), ".latte".into(),
    ];
    let results = tokio::task::spawn_blocking(move || {
        super::search::replace_text(&project_root, &query, &replacement, &exclude_dirs, &include_glob, &exclude_glob)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    Ok(results.into_iter().map(|(fp, c)| ReplaceFileResult { file_path: fp, count: c }).collect())
}