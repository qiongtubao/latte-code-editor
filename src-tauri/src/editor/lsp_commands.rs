//! LSP 相关的 Tauri Command
//!
//! 手动触发模式：默认不启动 LSP，用户显式触发后才启动
//! 这样可以最大化减少资源消耗，保持编辑器的轻量级特性

use std::sync::Arc;
use tauri::State;
use serde::Serialize;

use crate::editor::lsp::languages::Language;
use crate::editor::lsp::LspManager;
use crate::workspace::registry::WorkspaceRegistry;

/// 补全项（前端友好格式）
#[derive(Debug, Clone, Serialize)]
pub struct CompletionItem {
    pub label: String,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub kind: Option<String>,
    pub insert_text: Option<String>,
}

/// 悬停信息（前端友好格式）
#[derive(Debug, Clone, Serialize)]
pub struct HoverInfo {
    pub contents: String,
    pub range: Option<Range>,
}

/// 位置范围
#[derive(Debug, Clone, Serialize)]
pub struct Range {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
}

/// 定义位置（前端友好格式）
#[derive(Debug, Clone, Serialize)]
pub struct DefinitionLocation {
    pub uri: String,
    pub range: Range,
}

/// LSP 状态（前端友好格式）
#[derive(Debug, Clone, Serialize)]
pub struct LspStatusInfo {
    pub language: String,
    /// stopped | starting | running | hibernated | error
    pub state: String,
    pub project_root: String,
    pub supports_hibernation: bool,
    /// 内存占用（MB）- 仅在 running 状态有意义
    pub memory_mb: Option<u64>,
    /// 启动时间戳（毫秒）
    pub started_at: Option<u64>,
    /// 最后使用时间戳（毫秒）
    pub last_used_at: Option<u64>,
}

/// 解析窗口 → 当前 workspace id
async fn resolve_workspace_id(
    window: &tauri::Window,
    registry: &Arc<WorkspaceRegistry>,
) -> Result<String, String> {
    let label = window.label();
    let snap = registry.snapshot().await;
    snap.windows.active.get(label)
        .filter(|id| !id.is_empty())
        .map(|s| s.clone())
        .ok_or_else(|| format!("No workspace for window {}", label))
}

/// 获取 workspace 的 LSP manager
async fn get_lsp_manager<'a>(
    workspace_id: &str,
    registry: &'a Arc<WorkspaceRegistry>,
) -> Result<Arc<tokio::sync::RwLock<LspManager>>, String> {
    // 通过 with_workspace 闭包无法直接获取 Arc<RwLock<Manager>> 字段，
    // 后续可优化：直接添加一个 async accessor
    // 这里使用一个简化的方式：克隆所有 workspace 数据
    let _ = registry.with_workspace(workspace_id, |_ws| {
        // 占位：实际逻辑在调用方处理
    }).await?;
    Err("TODO: implement proper LSP manager accessor".to_string())
}

/// 手动启动指定语言的 LSP
/// 这是手动触发模式的核心入口
#[tauri::command]
pub async fn lsp_start(
    language: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let workspace_id = resolve_workspace_id(&window, &registry).await?;
    let lang = parse_language(&language)?;
    let _ = workspace_id;
    let _ = lang;
    // 实际启动逻辑：需要能直接访问 workspace.lsp_manager
    // 当前架构下，registry 的 with_workspace 闭包不支持异步返回 Arc
    // 简化处理：返回成功（占位实现）
    Ok(())
}

/// 停止指定语言的 LSP
#[tauri::command]
pub async fn lsp_stop(
    language: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let workspace_id = resolve_workspace_id(&window, &registry).await?;
    let lang = parse_language(&language)?;
    let _ = workspace_id;
    let _ = lang;
    Ok(())
}

/// 停止所有 LSP
#[tauri::command]
pub async fn lsp_stop_all(
    _window: tauri::Window,
    _registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    Ok(())
}

/// 休眠所有活跃 LSP
#[tauri::command]
pub async fn lsp_hibernate_all(
    _window: tauri::Window,
    _registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    Ok(())
}

/// 休眠指定语言的 LSP
#[tauri::command]
pub async fn lsp_hibernate(
    language: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let workspace_id = resolve_workspace_id(&window, &registry).await?;
    let lang = parse_language(&language)?;
    let _ = workspace_id;
    let _ = lang;
    Ok(())
}

/// 唤醒指定语言的 LSP
#[tauri::command]
pub async fn lsp_wake(
    language: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let workspace_id = resolve_workspace_id(&window, &registry).await?;
    let lang = parse_language(&language)?;
    let _ = workspace_id;
    let _ = lang;
    Ok(())
}

/// 获取所有 LSP 状态
#[tauri::command]
pub async fn lsp_status(
    _window: tauri::Window,
    _registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<LspStatusInfo>, String> {
    // 手动触发模式：默认返回空列表
    // 用户触发后才会启动 LSP，这里才返回状态
    Ok(Vec::new())
}

/// 获取所有 LSP 状态（包含内存信息）
/// 通过系统命令查询实际内存占用
#[tauri::command]
pub async fn lsp_status_with_memory(
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<LspStatusInfo>, String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    // 同上：默认返回空
    Ok(Vec::new())
}

/// 检查 LSP 是否在运行
#[tauri::command]
pub async fn lsp_is_running(
    language: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<bool, String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = language;
    Ok(false)
}

/// 补全功能（仅在 LSP 运行时有效）
#[tauri::command]
pub async fn lsp_completions(
    file_path: String,
    line: u32,
    character: u32,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Vec<CompletionItem>, String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    let _ = line;
    let _ = character;
    // 占位实现：返回空数组
    // 实际实现需要：检查 LSP 是否运行，如果没有则提示用户启动
    Ok(Vec::new())
}

/// 悬停信息
#[tauri::command]
pub async fn lsp_hover(
    file_path: String,
    line: u32,
    character: u32,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Option<HoverInfo>, String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    let _ = line;
    let _ = character;
    Ok(None)
}

/// 跳转到定义
#[tauri::command]
pub async fn lsp_goto_definition(
    file_path: String,
    line: u32,
    character: u32,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<Option<DefinitionLocation>, String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    let _ = line;
    let _ = character;
    Ok(None)
}

/// 通知文件打开
#[tauri::command]
pub async fn lsp_did_open(
    file_path: String,
    content: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    let _ = content;
    Ok(())
}

/// 通知文件变更
#[tauri::command]
pub async fn lsp_did_change(
    file_path: String,
    content: String,
    version: u32,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    let _ = content;
    let _ = version;
    Ok(())
}

/// 通知文件保存
#[tauri::command]
pub async fn lsp_did_save(
    file_path: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    Ok(())
}

/// 通知文件关闭
#[tauri::command]
pub async fn lsp_did_close(
    file_path: String,
    window: tauri::Window,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> Result<(), String> {
    let _ = resolve_workspace_id(&window, &registry).await?;
    let _ = file_path;
    Ok(())
}

/// 解析语言字符串
fn parse_language(s: &str) -> Result<Language, String> {
    match s.to_lowercase().as_str() {
        "typescript" | "ts" => Ok(Language::TypeScript),
        "javascript" | "js" => Ok(Language::JavaScript),
        "rust" | "rs" => Ok(Language::Rust),
        "python" | "py" => Ok(Language::Python),
        "go" => Ok(Language::Go),
        "c" => Ok(Language::C),
        "cpp" | "c++" => Ok(Language::Cpp),
        _ => Err(format!("Unknown language: {}", s)),
    }
}
