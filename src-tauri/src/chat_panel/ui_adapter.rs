//! 阶段 2（ui-embedding-design.md §3）：chat 面板后端 = 进程内 Tauri
//! commands + 事件，取代阶段 0 的内嵌 HTTP server（旧 `ui_server.rs`
//! 已删除）。REST 端点与命令 1:1 对照见 latte-rs-agents
//! `docs/bridge-api.ts`；协议无关逻辑全部复用 `latte-agent-ui-server`
//! 的 [`api`] 模块（与 axum server 同一份实现，路由语义不漂移）。
//!
//! - 状态：`map<workspace_root, Arc<UiBackend>>`，key 规则与旧
//!   `ui_server.rs` 一致（无工作区 → "default"，cwd None = 进程当前
//!   目录/app_data_dir）；get-or-spawn + 双重检查锁（parking_lot 同步
//!   map + tokio spawn_lock，临界区内无 await）。
//! - 事件：session 的 ChatEvent broadcast →
//!   `chat_event_to_frontend_json`（契约 C2，与 SSE 前端格式一致）→
//!   `app.emit("ui:chat_event", { session_id, event })`；self-loop →
//!   `app.emit("ui:self_loop_event", { event })`。接入点：容器 spawn
//!   （默认 session）与 `ui_sessions_create`（新 session）——所有
//!   session 的创建路径都覆盖，切 session 由前端按 `session_id`
//!   过滤事件载荷，不需要后端额外动作。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use latte_agent_core::controller::{ChatEvent, RoleInfo};
use latte_agent_core::event_json::chat_event_to_frontend_json;
use latte_agent_ui_server::api::{self, SaveRoleConfigRequest};
use latte_agent_ui_server::role_graph::RoleGraph;
use latte_agent_ui_server::{UiBackend, UiBackendConfig};
use tauri::Emitter;
use tokio::sync::broadcast;

use super::controller_runtime::load_cli_like_agent_config;

/// 无工作区时的 map key（对应 `cwd: None` 的 default 容器）。
const DEFAULT_KEY: &str = "default";

/// UI adapter 的 managed state：工作区根 → 后端容器。
pub struct UiAdapterState {
    /// key 见 [`workspace_key`]。同步 map（parking_lot）：读写临界区内
    /// 无 await，避免 tokio Mutex guard 跨 await 的持锁风险。
    backends: parking_lot::Mutex<HashMap<String, Arc<UiBackend>>>,
    /// spawn 串行化：get-or-spawn 的双重检查第二段在此锁内完成，
    /// 防止同一 key 并发 spawn 两份（双份 controller/状态分叉）。
    spawn_lock: tokio::sync::Mutex<()>,
}

impl UiAdapterState {
    pub fn new() -> Self {
        Self {
            backends: parking_lot::Mutex::new(HashMap::new()),
            spawn_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn ready(&self, key: &str) -> Option<Arc<UiBackend>> {
        self.backends.lock().get(key).cloned()
    }
}

/// map key：工作区根路径原样为 key（同一路径字符串 ↔ 同一容器）；
/// 无工作区 → "default"。
fn workspace_key(workspace_root: Option<&str>) -> String {
    match workspace_root {
        Some(root) if !root.is_empty() => root.to_string(),
        _ => DEFAULT_KEY.to_string(),
    }
}

/// 工作区根 → 项目级配置目录（与 controller_runtime 的约定一致）。
fn latte_subdirs(root: &Path) -> (PathBuf, PathBuf) {
    (root.join(".latte").join("agents.d"), root.join(".latte/models.d"))
}

/// get-or-spawn：命中直接返回已有容器；未命中串行化创建并登记。
async fn get_or_spawn(
    app: &tauri::AppHandle,
    state: &UiAdapterState,
    workspace_root: Option<&str>,
) -> Result<Arc<UiBackend>, String> {
    let key = workspace_key(workspace_root);
    // 双重检查 1：已就绪直接返回（无锁等待）。
    if let Some(b) = state.ready(&key) {
        return Ok(b);
    }
    // spawn 串行化；持锁期间完成第二次检查 + spawn + 登记。
    let _guard = state.spawn_lock.lock().await;
    // 双重检查 2：等锁期间可能已有别的调用 spawn 完成。
    if let Some(b) = state.ready(&key) {
        return Ok(b);
    }
    let backend = spawn_one(app, workspace_root).await?;
    state.backends.lock().insert(key.clone(), backend.clone());
    tracing::info!(event = "ui_adapter.spawned", key = %key);
    Ok(backend)
}

/// 创建一个容器：配置加载与 `controller_runtime` 同款（项目
/// `.latte/{agents,models}.d` + global 三层合并）；有工作区时
/// `cwd = 工作区根`，否则 `cwd: None`（进程当前目录，同 CLI）。
/// 随后 bootstrap 默认 session 并接上它的事件转发。
async fn spawn_one(
    app: &tauri::AppHandle,
    workspace_root: Option<&str>,
) -> Result<Arc<UiBackend>, String> {
    let (cwd, project_agents, project_models) = match workspace_root {
        Some(root) if !root.is_empty() => {
            let root = PathBuf::from(root);
            if !root.is_dir() {
                return Err(format!("workspace root is not a directory: {}", root.display()));
            }
            let (agents, models) = latte_subdirs(&root);
            (Some(root), agents, models)
        }
        _ => {
            let cwd = std::env::current_dir().map_err(|e| format!("current_dir: {e}"))?;
            let (agents, models) = latte_subdirs(&cwd);
            (None, agents, models)
        }
    };
    let (agent_config, resolver) = load_cli_like_agent_config(
        Some(project_agents.as_path()),
        Some(project_models.as_path()),
    )?;
    let backend = UiBackend::new(UiBackendConfig {
        agent_config,
        model_resolver: resolver,
        role: None,
        tier: None,
        model_id: None,
        cwd,
        agents_config: project_agents.to_string_lossy().into_owned(),
    })
    .map_err(|e| format!("create ui backend: {e:#}"))?;
    let session_id = backend
        .bootstrap_default_session()
        .await
        .map_err(|e| format!("bootstrap default session: {e}"))?;
    // 默认 session 的事件转发（容器内之后新建的 session 在
    // `ui_sessions_create` 里接）。
    let rx = api::subscribe_session(&backend, &session_id).map_err(|e| e.message)?;
    spawn_chat_event_forwarder(app, session_id, rx);
    Ok(Arc::new(backend))
}

// ─── 事件转发 ─────────────────────────────────────────────────────

/// session 的 ChatEvent broadcast → 前端 JSON（C2）→
/// `app.emit("ui:chat_event", { session_id, event })`。
/// controller  abort/drop 后 channel 关闭，任务自然结束。
fn spawn_chat_event_forwarder(
    app: &tauri::AppHandle,
    session_id: String,
    rx: broadcast::Receiver<ChatEvent>,
) {
    let app = app.clone();
    tokio::spawn(async move {
        let mut rx = rx;
        loop {
            match rx.recv().await {
                Ok(ev) => match chat_event_to_frontend_json(&ev) {
                    Ok(json) => {
                        let event = serde_json::from_str::<serde_json::Value>(&json)
                            .unwrap_or(serde_json::Value::Null);
                        let _ = app.emit(
                            "ui:chat_event",
                            serde_json::json!({
                                "session_id": &session_id,
                                "event": event,
                            }),
                        );
                    }
                    Err(e) => {
                        tracing::warn!(event = "ui_adapter.event_convert_failed", error = %e)
                    }
                },
                // 丢事件只记日志（HTTP SSE 侧是推一个 "error" 事件）；
                // 前端可用 ui_sessions_history 重新拉全量回放。
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(event = "ui_adapter.broadcast_lag", skipped = n)
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// self-loop 进度 → `app.emit("ui:self_loop_event", { event })`。
/// 在 `ui_self_loop_start` 里用 start 返回的 receiver 启动（start 之
/// 前就绪，不会丢 "started"）。
fn spawn_self_loop_forwarder(app: &tauri::AppHandle, rx: broadcast::Receiver<api::SelfLoopEvent>) {
    let app = app.clone();
    tokio::spawn(async move {
        let mut rx = rx;
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let _ = app.emit("ui:self_loop_event", serde_json::json!({ "event": ev }));
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(event = "ui_adapter.self_loop_lag", skipped = n)
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

// ─── Sessions ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn ui_sessions_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<Vec<api::SessionSummary>, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    Ok(api::list_sessions(&b))
}

#[tauri::command]
pub async fn ui_sessions_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<api::SessionInfo, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    let info = api::create_session(&b).await.map_err(|e| e.message)?;
    // 新 session 的事件转发接入点。
    let rx = api::subscribe_session(&b, &info.session_id).map_err(|e| e.message)?;
    spawn_chat_event_forwarder(&app, info.session_id.clone(), rx);
    Ok(info)
}

#[tauri::command]
pub async fn ui_sessions_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
) -> Result<api::SessionInfo, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::get_session(&b, &session_id).map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_sessions_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
) -> Result<(), String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::delete_session(&b, &session_id)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_sessions_set_label(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
    label: String,
) -> Result<(), String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::set_session_label(&b, &session_id, &label).map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_sessions_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::session_history(&b, &session_id).map_err(|e| e.message)
}

// ─── Roles ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ui_roles_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<Vec<RoleInfo>, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    Ok(api::list_roles(&b))
}

#[tauri::command]
pub async fn ui_roles_config_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<api::RolesConfigResponse, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::get_roles_config(&b).await.map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_roles_config_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    config: SaveRoleConfigRequest,
) -> Result<api::RoleConfigEntry, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::save_role_config(&b, config).map_err(|e| e.message)
}

// ─── Chat ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ui_chat_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::chat_send(&b, Some(&session_id), &message)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_chat_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
    command: String,
) -> Result<(), String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::chat_command(&b, Some(&session_id), &command)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_chat_role(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
    role_id: String,
) -> Result<(), String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::chat_switch_role(&b, Some(&session_id), &role_id)
        .await
        .map_err(|e| e.message)
}

// ─── Traces / Subsessions / Role Graph ────────────────────────────

#[tauri::command]
pub async fn ui_traces_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<Vec<api::TraceSummary>, String> {
    // traces 锚点是 LATTE_HOME/HOME 而非工作区，但仍走 get-or-spawn
    // 以统一"无工作区 → default 容器"的懒加载语义。
    let _b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    Ok(api::list_traces())
}

#[tauri::command]
pub async fn ui_traces_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let _b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::read_trace(&session_id).map_err(|e| e.message)
}

#[tauri::command]
pub async fn ui_subsessions_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    sub_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    Ok(api::get_subsession(&b, &sub_id))
}

#[tauri::command]
pub async fn ui_role_graph(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<RoleGraph, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::role_graph(&b).await.map_err(|e| e.message)
}

// ─── Self-Loop ────────────────────────────────────────────────────

#[tauri::command]
pub async fn ui_self_loop_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
    task: String,
    max_iterations: Option<u32>,
) -> Result<serde_json::Value, String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    let (resp, rx) = api::self_loop_start(&b, task, max_iterations)
        .await
        .map_err(|e| e.message)?;
    // start 返回的 receiver 在 node 子进程 spawn 前就绪，"started"
    // 及之后的事件都不会丢。
    spawn_self_loop_forwarder(&app, rx);
    Ok(resp)
}

#[tauri::command]
pub async fn ui_self_loop_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiAdapterState>>,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let b = get_or_spawn(&app, &state, workspace_root.as_deref()).await?;
    api::self_loop_stop(&b);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_key_maps_workspace_and_default() {
        // 工作区根原样为 key；None / 空串 → default。
        assert_eq!(workspace_key(Some("/home/u/proj")), "/home/u/proj");
        assert_eq!(workspace_key(None), "default");
        assert_eq!(workspace_key(Some("")), "default");
        // 不同工作区 → 不同 key（隔离的前提）。
        assert_ne!(workspace_key(Some("/a")), workspace_key(Some("/b")));
        assert_ne!(workspace_key(Some("/a")), workspace_key(None));
    }

    #[test]
    fn latte_subdirs_matches_controller_runtime_layout() {
        let (agents, models) = latte_subdirs(Path::new("/ws"));
        assert_eq!(agents, PathBuf::from("/ws/.latte/agents.d"));
        assert_eq!(models, PathBuf::from("/ws/.latte/models.d"));
    }
}
