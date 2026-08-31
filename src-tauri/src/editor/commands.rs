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
            chat_state: None,
        };
        registry
            .add(ws_id.clone(), Workspace::new(meta))
            .await
            .map_err(|e| format!("Cannot register workspace: {}", e))?;
        let app = window.app_handle().clone();
        let hub: tauri::State<Arc<crate::graph::incremental::IncrementalHub>> = app.state();
        match crate::workspace::watcher::WorkspaceWatcher::start(
            &canonical,
            hub.inner().clone(),
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
pub async fn list_directory(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<FsEntry>, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let dir = resolve_under_workspace(&project_root, &path)?;
    list_dir_inner(&dir)
}

#[tauri::command]
pub async fn create_file(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let p = resolve_under_workspace(&project_root, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    std::fs::write(&p, "").map_err(|e| format!("Cannot create file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_folder(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let dir = resolve_under_workspace(&project_root, &path)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create folder: {}", e))?;
    Ok(())
}

/// 词法归一：消解 `.` 与 `..`，不触碰文件系统。
///
/// 归一必须在解析符号链接之前完成，否则路径不存在时 `..` 段会残留，
/// 后续拼接就会把 `root/a/../../etc` 之类的穿越带过检查。
fn lexical_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 把路径解析进工作区并校验包含性，**允许目标是工作区根、也允许目标尚不存在**。
///
/// 与 `resolve_within_workspace` 的分工：
/// - 这个用于读取/创建（list_directory、create_file、create_folder、
///   write_doc_stub）。`list_directory` 要能列根目录，`create_file` 会自行
///   `create_dir_all(parent)`，所以既不能拒绝根、也不能要求父目录已存在。
/// - `resolve_within_workspace` 用于删除单个条目：它拒绝根（不允许删掉整个
///   工作区），并按父目录 canonicalize 以正确处理符号链接自身。
///
/// 做法是先词法归一消掉 `..`，再 canonicalize「最长的已存在祖先」并把余下
/// 段落拼回。这样既解析了路径中间的符号链接，又不要求目标存在。
fn resolve_under_workspace(project_root: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw_path = Path::new(raw);
    let joined = if raw_path.is_relative() {
        project_root.join(raw_path)
    } else {
        raw_path.to_path_buf()
    };
    let normalized = lexical_normalize(&joined);

    // 找最长的已存在祖先，canonicalize 它，再拼回剩余段落
    let mut existing = normalized.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return Err(format!("Cannot resolve path: {}", normalized.display())),
        }
    }
    let mut resolved = existing
        .canonicalize()
        .map_err(|e| format!("Cannot resolve '{}': {}", existing.display(), e))?;
    for seg in rest.iter().rev() {
        resolved.push(seg);
    }

    let root = project_root.canonicalize().map_err(|e| {
        format!(
            "Cannot resolve workspace root '{}': {}",
            project_root.display(),
            e
        )
    })?;
    // 允许等于根本身；`starts_with` 按路径分量比较，`/a/proj-evil` 不会被
    // 误判为位于 `/a/proj` 之内。
    if resolved != root && !resolved.starts_with(&root) {
        return Err(format!(
            "Refusing to operate outside the workspace: '{}' is not inside '{}'",
            resolved.display(),
            root.display()
        ));
    }
    Ok(resolved)
}

/// 供其它模块（doc_gen 等）复用的封装：解析当前窗口的工作区，再校验
/// `raw` 落在工作区内。让所有写盘命令共用同一套边界判定，避免各处重复实现。
pub async fn resolve_workspace_subpath(
    window: &Window,
    registry: &Arc<WorkspaceRegistry>,
    raw: &str,
) -> Result<PathBuf, String> {
    let ws_id = resolve_workspace_id(window, registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    resolve_under_workspace(&project_root, raw)
}

/// 把前端传入的路径解析成工作区内的绝对路径，并确保它没有逃出 `project_root`。
///
/// 校验的是**条目自身所在的位置**，而不是它指向的位置：这里 canonicalize 的是
/// 父目录、再把最后一段文件名拼回去，而非直接 canonicalize 目标本身。原因是
///
/// - 项目内的符号链接指向外部 → 应当放行。删除操作作用于链接自身
///   （`remove_file` 删链接不删目标），它确实位于工作区内。
/// - `../../etc/passwd` 这类穿越 → 父目录 canonicalize 后落在根之外 → 拒绝。
///
/// 若直接 canonicalize 目标，上面两种情况会被混为一谈：既误杀了合法的项目内
/// 链接，语义上也不对（把「链接指向哪」当成了「链接在哪」）。
///
/// 另外 `Path::starts_with` 是按路径分量比较而非字符串前缀，所以
/// `/a/proj-evil` 不会被误判为位于 `/a/proj` 之内。
fn resolve_within_workspace(project_root: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw_path = Path::new(raw);
    // 与 open_file / save_file 保持一致：相对路径按 project_root 解析
    let joined = if raw_path.is_relative() {
        project_root.join(raw_path)
    } else {
        raw_path.to_path_buf()
    };

    let parent = joined
        .parent()
        .ok_or_else(|| format!("Refusing to operate on filesystem root: {}", joined.display()))?;
    let file_name = joined
        .file_name()
        .ok_or_else(|| format!("Path has no final component: {}", joined.display()))?;

    let real_parent = parent
        .canonicalize()
        .map_err(|e| format!("Cannot resolve parent of '{}': {}", joined.display(), e))?;
    let root = project_root.canonicalize().map_err(|e| {
        format!(
            "Cannot resolve workspace root '{}': {}",
            project_root.display(),
            e
        )
    })?;

    // 注意：workspace 根目录自身也会被这一条拦下（其父目录在根之外），
    // 这正是期望行为——不允许把整个工作区删掉。
    if !real_parent.starts_with(&root) {
        return Err(format!(
            "Refusing to operate outside the workspace: '{}' is not inside '{}'",
            joined.display(),
            root.display()
        ));
    }

    Ok(real_parent.join(file_name))
}

#[tauri::command]
pub async fn delete_entry(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    let target = resolve_within_workspace(&project_root, &path)?;

    // 用 symlink_metadata 而非 is_dir()：后者会跟随符号链接，导致指向目录的
    // 链接走进 remove_dir_all 分支。链接一律按文件删除，只摘掉链接本身。
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(m) => m,
        // 目标不存在时保持原有的幂等语义，不报错
        Err(_) => return Ok(()),
    };
    if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Cannot delete folder: {}", e))?;
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("Cannot delete file: {}", e))?;
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
    // project_root 此前只用于解析相对路径，绝对路径可以直接穿透到工作区外。
    let resolved_path = resolve_under_workspace(&project_root, &resolved_path.to_string_lossy())?;
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
    // project_root 此前只用于解析相对路径；绝对路径可直接穿透到工作区外。
    let resolved = resolve_under_workspace(&project_root, &resolved.to_string_lossy())?;
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

/// 文本文件的尺寸信息。
///
/// 与 `read_file_range` 分成两个命令：虚拟滚动需要总行数来定滚动条高度，
/// 但那是**一次性**信息，不该在每次滚动取片段时重算一遍。
#[derive(Serialize)]
pub struct TextFileStat {
    pub total_lines: usize,
    pub byte_size: u64,
}

/// 一段行区间。
#[derive(Serialize)]
pub struct FileRange {
    /// 本片段起始行（0-based），回显以便前端校验
    pub start_line: usize,
    pub lines: Vec<String>,
    /// 是否已读到文件末尾
    pub eof: bool,
}

const MAX_RANGE_LINES: usize = 4096;

/// 复用有效索引，否则流式重建并写回已打开的 buffer。mtime 与尺寸都参与
/// fingerprint，因此同尺寸的外部编辑也会让旧索引失效。
async fn ensure_text_index(
    buffers: &super::buffer::BufferManager,
    resolved: &Path,
) -> Result<super::buffer::TextFileIndex, String> {
    let open_buffer = buffers.get_buffer(resolved).await;
    if let Some(buffer) = &open_buffer {
        let reader = buffer.read().await;
        if !reader.line_index.is_empty() {
            let metadata = std::fs::metadata(resolved)
                .map_err(|e| format!("Cannot read metadata: {}", e))?;
            if metadata.len() == reader.byte_size as u64
                && metadata.modified().ok() == reader.indexed_modified
            {
                return Ok(super::buffer::TextFileIndex {
                    total_lines: reader.line_count,
                    byte_size: reader.byte_size as u64,
                    offsets: reader.line_index.clone(),
                    modified: reader.indexed_modified,
                });
            }
        }
    }

    let path = resolved.to_path_buf();
    let index = tokio::task::spawn_blocking(move || super::buffer::index_text_file(&path))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
    if let Some(buffer) = open_buffer {
        let mut writer = buffer.write().await;
        writer.line_count = index.total_lines;
        writer.byte_size = usize::try_from(index.byte_size)
            .map_err(|_| "File size exceeds this platform".to_string())?;
        writer.line_index = index.offsets.clone();
        writer.indexed_modified = index.modified;
    }
    Ok(index)
}

/// 统计文本文件并建立稀疏行索引。扫描使用固定 64KB 缓冲区；索引仅每
/// 1024 行保存一个偏移，内存不会随文件内容等比例增长。
#[tauri::command]
pub async fn stat_text_file(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<TextFileStat, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let resolved = resolve_workspace_subpath(&window, &registry, &path).await?;
    let buffers = registry
        .with_workspace(&ws_id, |ws| ws.buffers.clone())
        .await?;
    let index = ensure_text_index(&buffers, &resolved).await?;
    Ok(TextFileStat {
        total_lines: index.total_lines,
        byte_size: index.byte_size,
    })
}

/// 从最近的稀疏行锚点读取 `[start_line, start_line + max_lines)`。
/// 任意跳转最多重扫 1023 行，而不是每个 page 都从文件头开始。
#[tauri::command]
pub async fn read_file_range(
    path: String,
    start_line: usize,
    max_lines: usize,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<FileRange, String> {
    if max_lines > MAX_RANGE_LINES {
        return Err(format!(
            "Requested {} lines; maximum range is {}",
            max_lines, MAX_RANGE_LINES
        ));
    }
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let resolved = resolve_workspace_subpath(&window, &registry, &path).await?;
    let buffers = registry
        .with_workspace(&ws_id, |ws| ws.buffers.clone())
        .await?;
    let index = ensure_text_index(&buffers, &resolved).await?;
    let read_path = resolved.clone();
    let range = tokio::task::spawn_blocking(move || {
        super::buffer::read_indexed_range(&read_path, start_line, max_lines, &index)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    Ok(FileRange {
        start_line,
        lines: range.lines,
        eof: range.eof,
    })
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
    // project_root 此前只用于解析相对路径；绝对路径可直接穿透到工作区外。
    let resolved = resolve_under_workspace(&project_root, &resolved.to_string_lossy())?;
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
    // 默认排除的目录：仅排除与版本控制、构建产物、项目内部元数据相关的目录
    // 注意：不要硬编码 "deps"——它是 Redis/Elixir/Go 等项目中常见的源码目录（含 git submodule），
    // 需要排除时应让用户在搜索面板的 excludeGlob 中自行配置。
    let exclude_dirs = vec![
        "node_modules".into(),
        "target".into(),
        ".git".into(),
        "dist".into(),
        "build".into(),
        ".venv".into(),
        ".latte".into(),
    ];
    let opts = super::search::SearchOptions {
        query,
        max_results: 500,
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

/// 匹配到但写盘失败的文件。
#[derive(serde::Serialize)]
pub struct ReplaceFailure {
    pub file_path: String,
    pub error: String,
}

/// 批量替换的完整结果。
///
/// 必须把失败项一并回给前端：批量替换直接写盘且无撤销，若只回报成功项，
/// 磁盘满 / 只读文件 / 权限不足时用户会以为全部替换成功，而工作区实际处于
/// 半改状态。
#[derive(serde::Serialize)]
pub struct ReplaceOutcome {
    pub replaced: Vec<ReplaceFileResult>,
    pub failed: Vec<ReplaceFailure>,
}

#[tauri::command]
pub async fn replace_in_files(
    query: String,
    replacement: String,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<ReplaceOutcome, String> {
    let ws_id = resolve_workspace_id(&window, &registry).await?;
    let project_root: PathBuf = registry
        .project_root(&ws_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {}", ws_id))?;
    // 与 search_in_files 保持一致：不要硬编码 "deps"，由用户通过 excludeGlob 控制
    let exclude_dirs = vec![
        "node_modules".into(),
        "target".into(),
        ".git".into(),
        "dist".into(),
        "build".into(),
        ".venv".into(),
        ".latte".into(),
    ];
    let outcome = tokio::task::spawn_blocking(move || {
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
    Ok(ReplaceOutcome {
        replaced: outcome
            .replaced
            .into_iter()
            .map(|(file_path, count)| ReplaceFileResult { file_path, count })
            .collect(),
        failed: outcome
            .failed
            .into_iter()
            .map(|(file_path, error)| ReplaceFailure { file_path, error })
            .collect(),
    })
}

/// 刷新文件缓存（从磁盘重新加载）
#[tauri::command]
pub async fn refresh_file(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<FileResult, String> {
    let workspace_id = resolve_workspace_id(&window, &registry).await?;
    
    let snap = registry.snapshot().await;
    let _workspace = snap.workspaces.get(&workspace_id)
        .ok_or_else(|| format!("Workspace {} not found", workspace_id))?;
    
    // 获取 workspace 实例（包含 BufferManager）
    let buffer_manager = registry.with_workspace(&workspace_id, |ws| {
        ws.buffers.clone()
    }).await?;
    
    let path_buf = PathBuf::from(&path);
    let buffer = buffer_manager.refresh(&path_buf).await?;
    let buf = buffer.read().await;
    
    Ok(FileResult {
        path: buf.path.to_string_lossy().to_string(),
        content: buf.content.clone(),
        line_count: buf.line_count,
        is_large_file: buf.is_large_file,
        is_modified: buf.is_modified,
    })
}

/// 检查文件是否在磁盘上被修改
#[tauri::command]
pub async fn check_file_changed(
    path: String,
    window: Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<bool, String> {
    let workspace_id = resolve_workspace_id(&window, &registry).await?;
    
    let buffer_manager = registry.with_workspace(&workspace_id, |ws| {
        ws.buffers.clone()
    }).await?;
    
    let path_buf = PathBuf::from(&path);
    buffer_manager.is_file_changed_on_disk(&path_buf).await
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
    // 不硬编码 "deps"——它是 Redis/Elixir/Go 等项目中常见的源码目录（含 git submodule）
    let exclude_dirs = vec![
        "node_modules".into(),
        "target".into(),
        ".git".into(),
        "dist".into(),
        "build".into(),
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

#[cfg(test)]
mod tests {
    use super::{resolve_under_workspace, resolve_within_workspace};
    use std::fs;
    use std::path::PathBuf;

    /// 建一个临时工作区，返回 (tempdir, project_root)。
    /// tempdir 必须由调用方持有，drop 即清理。
    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().expect("create tempdir");
        let root = tmp.path().join("proj");
        fs::create_dir_all(root.join("src")).expect("create project tree");
        fs::write(root.join("src/main.rs"), "fn main() {}").expect("write file");
        (tmp, root)
    }

    #[test]
    fn allows_file_directly_inside_root() {
        let (_tmp, root) = workspace();
        let target = root.join("src/main.rs");
        let got = resolve_within_workspace(&root, target.to_str().unwrap())
            .expect("file inside root must be allowed");
        assert!(got.ends_with("src/main.rs"));
    }

    #[test]
    fn resolves_relative_path_against_root() {
        let (_tmp, root) = workspace();
        // 与 open_file / save_file 一致：相对路径按 project_root 解析
        let got = resolve_within_workspace(&root, "src/main.rs")
            .expect("relative path inside root must be allowed");
        assert!(got.ends_with("src/main.rs"));
        assert!(got.is_absolute(), "结果应当是绝对路径");
    }

    #[test]
    fn rejects_parent_traversal_escaping_root() {
        let (tmp, root) = workspace();
        let outside = tmp.path().join("secret.txt");
        fs::write(&outside, "sensitive").expect("write outside file");

        let err = resolve_within_workspace(&root, "../secret.txt")
            .expect_err("../ 穿越必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
        assert!(outside.exists(), "被拒绝的路径不应受影响");
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let (tmp, root) = workspace();
        let outside = tmp.path().join("secret.txt");
        fs::write(&outside, "sensitive").expect("write outside file");

        let err = resolve_within_workspace(&root, outside.to_str().unwrap())
            .expect_err("工作区外的绝对路径必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
    }

    #[test]
    fn rejects_the_workspace_root_itself() {
        let (_tmp, root) = workspace();
        // 根目录的父目录在根之外，因此会被同一条规则拦下——
        // 不允许把整个工作区删掉。
        let err = resolve_within_workspace(&root, root.to_str().unwrap())
            .expect_err("删除工作区根目录必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
    }

    #[test]
    fn rejects_sibling_dir_sharing_a_string_prefix() {
        let (tmp, root) = workspace();
        // `proj-evil` 与 `proj` 有相同的字符串前缀，但不在其内部。
        // Path::starts_with 按分量比较，所以这里应当被拒绝。
        let evil = tmp.path().join("proj-evil");
        fs::create_dir_all(&evil).expect("create sibling dir");
        let target = evil.join("loot.txt");
        fs::write(&target, "x").expect("write sibling file");

        let err = resolve_within_workspace(&root, target.to_str().unwrap())
            .expect_err("同前缀的兄弟目录必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
    }

    #[test]
    fn allows_nonexistent_file_when_parent_is_inside() {
        let (_tmp, root) = workspace();
        // 目标不存在但父目录合法：应放行，由调用方决定如何处理不存在的条目
        // （delete_entry 对此保持幂等）。
        let got = resolve_within_workspace(&root, "src/not_yet.rs")
            .expect("父目录在工作区内即可放行");
        assert!(got.ends_with("src/not_yet.rs"));
    }

    #[test]
    fn errors_when_parent_does_not_exist() {
        let (_tmp, root) = workspace();
        let err = resolve_within_workspace(&root, "no/such/dir/file.rs")
            .expect_err("父目录不存在应返回错误而非 panic");
        assert!(err.contains("Cannot resolve parent"), "err was: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_inside_root_even_if_it_points_outside() {
        let (tmp, root) = workspace();
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, "sensitive").expect("write outside file");
        let link = root.join("src/link.txt");
        std::os::unix::fs::symlink(&outside, &link).expect("create symlink");

        // 链接自身位于工作区内，删除它只会摘掉链接、不动目标，因此应放行。
        // 若这里改成直接 canonicalize 目标，就会被误判成工作区外而拒绝。
        let got = resolve_within_workspace(&root, link.to_str().unwrap())
            .expect("项目内的符号链接应当放行");
        assert!(got.ends_with("src/link.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_path_traversing_through_a_symlinked_dir_to_outside() {
        let (tmp, root) = workspace();
        let outside_dir = tmp.path().join("outside_dir");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        fs::write(outside_dir.join("loot.txt"), "sensitive").expect("write loot");
        // 项目内放一个指向外部目录的链接，再试图穿过它访问内部文件。
        // 此时父目录 canonicalize 后会落在工作区之外，必须拒绝。
        std::os::unix::fs::symlink(&outside_dir, root.join("escape")).expect("create dir symlink");

        let err = resolve_within_workspace(&root, "escape/loot.txt")
            .expect_err("穿过目录链接抵达外部必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
        assert!(
            outside_dir.join("loot.txt").exists(),
            "被拒绝的路径不应受影响"
        );
    }

    // -----------------------------------------------------------------
    // resolve_under_workspace：读取/创建用。与 resolve_within_workspace 的
    // 区别是允许根自身、允许目标尚不存在。
    // -----------------------------------------------------------------

    #[test]
    fn under_allows_the_workspace_root_itself() {
        let (_tmp, root) = workspace();
        // list_directory(folderRoot) 必须能列根目录——这正是它与
        // resolve_within_workspace（删除用，拒绝根）的关键差异
        let got = resolve_under_workspace(&root, root.to_str().unwrap())
            .expect("列工作区根目录必须放行");
        assert_eq!(got, root.canonicalize().unwrap());
    }

    #[test]
    fn under_allows_target_whose_parent_does_not_exist_yet() {
        let (_tmp, root) = workspace();
        // create_file 会自行 create_dir_all(parent)，所以父目录可以还不存在
        let got = resolve_under_workspace(&root, "brand/new/deep/file.ts")
            .expect("尚不存在的嵌套路径应放行");
        assert!(got.ends_with("brand/new/deep/file.ts"));
        assert!(got.is_absolute());
    }

    #[test]
    fn under_rejects_parent_traversal_even_when_path_does_not_exist() {
        let (_tmp, root) = workspace();
        // 这是 docsInputDir 被填成 ../.. 时的实际形态：路径不存在，
        // 因此必须靠词法归一消解 ..，不能依赖 canonicalize
        for raw in ["../escaped/x.md", "docs/../../escaped/x.md"] {
            let err = resolve_under_workspace(&root, raw)
                .expect_err(&format!("{raw} 必须被拒绝"));
            assert!(err.contains("outside the workspace"), "err was: {err}");
        }
    }

    #[test]
    fn under_rejects_absolute_path_outside_root() {
        let (tmp, root) = workspace();
        let outside = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        let err = resolve_under_workspace(&root, outside.to_str().unwrap())
            .expect_err("工作区外的绝对路径必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
    }

    #[test]
    fn under_rejects_sibling_dir_sharing_a_string_prefix() {
        let (tmp, root) = workspace();
        let evil = tmp.path().join("proj-evil");
        std::fs::create_dir_all(&evil).unwrap();
        let err = resolve_under_workspace(&root, evil.to_str().unwrap())
            .expect_err("同前缀的兄弟目录必须被拒绝");
        assert!(err.contains("outside the workspace"), "err was: {err}");
    }

    #[test]
    fn under_allows_existing_nested_path() {
        let (_tmp, root) = workspace();
        let got = resolve_under_workspace(&root, "src/main.rs").expect("根内文件应放行");
        assert!(got.ends_with("src/main.rs"));
    }
}
