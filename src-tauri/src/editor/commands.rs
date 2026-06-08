//! 编辑器相关命令
//!
//! 所有命令通过 `window: tauri::Window` 参数拿到调用窗口 label，
//! 再从 WorkspaceRegistry 查找当前窗口激活的 workspace，最后路由到该 workspace 的 buffer。
//!
//! 这样保证：每个 workspace 的打开文件、buffer 状态、project_root 完全隔离。

use crate::workspace::registry::{WorkspaceMeta, WorkspaceRegistry};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Manager, State, Window};

/// 解析窗口 → 当前 workspace id（不持锁；调用方按需用 snapshot_workspace/project_root 拿数据）
async fn resolve_workspace_id(
    window: &Window,
    registry: &Arc<WorkspaceRegistry>,
) -> Result<String, String> {
    let label = window.label().to_string();
    registry
        .active_for_window(&label)
        .await
        .ok_or_else(|| format!("No active workspace for window '{}'", label))
}

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// 打开文件夹的返回。
///
/// `workspace_id` + `workspace_meta` 是新增字段，让前端 `useWorkspaceStore.openFolder`
/// 一次调用就能拿到后端权威 workspace id 并写入 store，不再需要"先调 open_folder，
/// 再调 list_workspaces 同步状态"这种 race-prone 模式。
#[derive(Serialize)]
pub struct OpenFolderResult {
    pub root: String,
    pub entries: Vec<FsEntry>,
    pub has_graph: bool,
    pub graph_node_count: usize,
    pub workspace_id: String,
    pub workspace_meta: WorkspaceMeta,
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
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<OpenFolderResult, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let canonical = dir_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    let ws_id = crate::workspace::registry::derive_workspace_id(&canonical);
    let ws_name = crate::workspace::registry::derive_workspace_name(&canonical);

    if registry.snapshot_workspace(&ws_id).await.is_none() {
        use crate::workspace::registry::{Workspace, WorkspaceMeta as WMeta};
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let meta = WMeta {
            name: ws_name,
            project_root: canonical.clone(),
            open_tabs: vec![],
            active_tab: None,
            ui_state: Default::default(),
            last_used_at: now,
        };
        registry
            .add(ws_id.clone(), Workspace::new(meta))
            .await
            .map_err(|e| format!("Cannot register workspace: {}", e))?;
        let app = window.app_handle().clone();
        match crate::workspace::watcher::WorkspaceWatcher::start(
            &canonical,
            app,
            ws_id.clone(),
        ) {
            Ok(watcher) => {
                if let Err(e) = registry.attach_watcher(&ws_id, watcher).await {
                    eprintln!("[open_folder] attach watcher failed: {}", e);
                }
            }
            Err(e) => eprintln!("[open_folder] start watcher failed: {}", e),
        }
    }

    registry
        .set_active(window.label(), &ws_id)
        .await
        .map_err(|e| format!("Cannot set active: {}", e))?;
    registry.touch(&ws_id).await;

    // 重新拿一次最新的 meta（可能从持久化恢复后已带 open_tabs）
    let snap = registry
        .snapshot_workspace(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace '{}' disappeared after open", ws_id))?;

    let graph_db = canonical.join(".latte").join("graph.db");
    let (has_graph, graph_node_count) = if graph_db.exists() {
        match rusqlite::Connection::open(&graph_db) {
            Ok(conn) => {
                let schema_ok = conn
                    .query_row(
                        "SELECT qualified_name FROM nodes LIMIT 1",
                        [],
                        |_| Ok(()),
                    )
                    .is_ok();
                if !schema_ok {
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
        workspace_id: snap.id,
        workspace_meta: snap.meta,
    })
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FsEntry>, String> {
    list_dir_inner(Path::new(&path))
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    std::fs::write(p, "").map_err(|e| format!("Cannot create file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Cannot create folder: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_entry(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("Cannot delete folder: {}", e))?;
    } else if p.exists() {
        std::fs::remove_file(p).map_err(|e| format!("Cannot delete file: {}", e))?;
    }
    Ok(())
}

fn list_dir_inner(path: &Path) -> Result<Vec<FsEntry>, String> {
    let read_dir = std::fs::read_dir(path)
        .map_err(|e| format!("Cannot read dir {}: {}", path.display(), e))?;
    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let metadata = entry.metadata().ok();
        let file_type = metadata.as_ref().map(|m| m.file_type());
        let is_dir = file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false);
        let is_symlink = file_type.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
        entries.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn open_file(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<FileResult, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let raw = Path::new(&path);
    let resolved_path = if raw.is_relative() {
        project_root.join(raw)
    } else {
        raw.to_path_buf()
    };
    let buffers = registry
        .with_workspace(&ws_id, |ws| ws.buffers.clone())
        .await?;
    let buf = buffers
        .open(&resolved_path)
        .await
        .map_err(|e| format!("Open file error: {}", e))?;
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
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let file_path = Path::new(&path);
    let resolved = if file_path.is_relative() {
        project_root.join(file_path)
    } else {
        file_path.to_path_buf()
    };
    let buffers = registry
        .with_workspace(&ws_id, |ws| ws.buffers.clone())
        .await?;
    {
        let buf = buffers
            .get_buffer(&resolved)
            .await
            .ok_or_else(|| "Buffer not found".to_string())?;
        let mut writer = buf.write().await;
        writer.content = content;
        writer.is_modified = true;
    }
    buffers.save(&resolved).await
}

#[tauri::command]
pub async fn get_file_content(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<FileResult, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let file_path = Path::new(&path);
    let resolved = if file_path.is_relative() {
        project_root.join(file_path)
    } else {
        file_path.to_path_buf()
    };
    let buffers = registry
        .with_workspace(&ws_id, |ws| ws.buffers.clone())
        .await?;
    let buf = buffers
        .get_buffer(&resolved)
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

#[tauri::command]
pub async fn search_in_files(
    query: String,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<super::search::SearchMatch>, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root: PathBuf = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let exclude_dirs = vec![
        "node_modules".into(),
        "target".into(),
        ".git".into(),
        "dist".into(),
        "build".into(),
        "deps".into(),
        ".venv".into(),
        ".latte".into(),
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
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<ReplaceFileResult>, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root: PathBuf = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let exclude_dirs = vec![
        "node_modules".into(),
        "target".into(),
        ".git".into(),
        "dist".into(),
        "build".into(),
        "deps".into(),
        ".venv".into(),
        ".latte".into(),
    ];
    let results = tokio::task::spawn_blocking(move || {
        super::search::replace_text(
            &project_root,
            &query,
            &replacement,
            &exclude_dirs,
            &include_glob,
            &exclude_glob,
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    Ok(results
        .into_iter()
        .map(|(fp, c)| ReplaceFileResult {
            file_path: fp,
            count: c,
        })
        .collect())
}

/// Quick Open 用的文件名模糊搜索（按子序列匹配），返回 top N 候选
/// 注意：只搜文件名，不搜文件内容——内容搜索用 search_in_files
#[tauri::command]
pub async fn find_files(
    query: String,
    max_results: Option<usize>,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<super::search::FileMatch>, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let exclude_dirs = vec![
        "node_modules".into(),
        "target".into(),
        ".git".into(),
        "dist".into(),
        "build".into(),
        "deps".into(),
        ".venv".into(),
        ".latte".into(),
    ];
    let q = query;
    let max = max_results.unwrap_or(50);
    let results = tokio::task::spawn_blocking(move || {
        super::search::find_files(&project_root, &q, max, &exclude_dirs)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    Ok(results)
}
