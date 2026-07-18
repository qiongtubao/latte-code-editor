//! 内嵌 `latte-agent-ui-server`（ui-embedding-design.md §6 阶段 0 + 工作区隔离）。
//!
//! 按工作区多实例：每个活动工作区一个进程内 HTTP+SSE server
//! （127.0.0.1 随机端口，`UiServerConfig.cwd = 工作区根`），agent 工具
//! 路径 / role_graph / 角色编辑器都以工作区根为锚。侧栏
//! `ChatAgentPanel` 的 iframe 指向当前工作区对应的 server；切换工作区
//! 换 URL（iframe 重载），各工作区的 chat 状态各自保留、可切回。
//!
//! 从简之处：
//! - 不做单工作区 stop/淘汰：server 一旦 spawn 活到进程结束（工作区
//!   数量有限，句柄只占一个端口 + 一个 tokio task），需要淘汰语义时
//!   再对 `UiServerHandle::shutdown` 做 map 清理。
//! - 无工作区（`workspace_root = None`）走固定 key "default"，
//!   `cwd: None` = 进程当前目录（app_data_dir），行为同最初的单实例版。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use latte_agent_ui_server::{spawn, UiServerConfig, UiServerHandle};
use tauri::Manager;

use super::controller_runtime::load_cli_like_agent_config;

/// 无工作区时的 map key（对应 `cwd: None` 的 default server）。
const DEFAULT_KEY: &str = "default";

/// 运行中的 server 条目。`_handle` 仅保活（drop 不停 server，见
/// `UiServerHandle` 文档；进程退出统一回收）。
struct ServerEntry {
    addr: SocketAddr,
    _handle: UiServerHandle,
}

/// 内嵌 server 的 managed state：工作区根 → server。
pub struct UiServerState {
    /// key 见 [`server_key`]。同步 map（parking_lot）：读写临界区内无
    /// await，避免 tokio Mutex guard 跨 await 的持锁风险。
    servers: parking_lot::Mutex<HashMap<String, ServerEntry>>,
    /// spawn 串行化：get-or-spawn 的双重检查第二段在此锁内完成，
    /// 防止同一 key 并发 spawn 两份（占用两个端口、丢一份状态）。
    spawn_lock: tokio::sync::Mutex<()>,
}

impl UiServerState {
    pub fn new() -> Self {
        Self {
            servers: parking_lot::Mutex::new(HashMap::new()),
            spawn_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn ready_addr(&self, key: &str) -> Option<SocketAddr> {
        self.servers.lock().get(key).map(|e| e.addr)
    }
}

/// map key：工作区根路径原样为 key（同一路径字符串 ↔ 同一 server）；
/// 无工作区 → "default"。
fn server_key(workspace_root: Option<&str>) -> String {
    match workspace_root {
        Some(root) if !root.is_empty() => root.to_string(),
        _ => DEFAULT_KEY.to_string(),
    }
}

/// 工作区根 → 项目级配置目录（与 controller_runtime 的约定一致）。
fn latte_subdirs(root: &Path) -> (PathBuf, PathBuf) {
    (root.join(".latte").join("agents.d"), root.join(".latte").join("models.d"))
}

/// 前端获取（必要时按需起）当前工作区的 chat UI server base URL
/// （`http://127.0.0.1:<port>`）。get-or-spawn：命中直接返回已有 addr。
#[tauri::command]
pub async fn chat_ui_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<UiServerState>>,
    workspace_root: Option<String>,
) -> Result<String, String> {
    let key = server_key(workspace_root.as_deref());
    // 双重检查 1：已就绪直接返回（无锁等待）。
    if let Some(addr) = state.ready_addr(&key) {
        return Ok(format!("http://{addr}"));
    }
    // spawn 串行化；持锁期间完成第二次检查 + spawn + 登记。
    let _guard = state.spawn_lock.lock().await;
    // 双重检查 2：等锁期间可能已有别的调用 spawn 完成。
    if let Some(addr) = state.ready_addr(&key) {
        return Ok(format!("http://{addr}"));
    }
    let handle = spawn_one(&app, workspace_root.as_deref()).await?;
    let addr = handle.addr;
    state
        .servers
        .lock()
        .insert(key.clone(), ServerEntry { addr, _handle: handle });
    tracing::info!(event = "chat_ui_server.spawned", key = %key, addr = %addr);
    Ok(format!("http://{addr}"))
}

/// 起一个 server：配置加载与 `controller_runtime` 同款（项目
/// `.latte/{agents,models}.d` + global 三层合并）；有工作区时
/// `cwd = 工作区根`，否则 `cwd: None`（进程当前目录，同 CLI）。
async fn spawn_one(
    app: &tauri::AppHandle,
    workspace_root: Option<&str>,
) -> Result<UiServerHandle, String> {
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
    spawn(UiServerConfig {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        static_dir: resolve_static_dir(app),
        agent_config,
        model_resolver: resolver,
        role: None,
        tier: None,
        model_id: None,
        cwd,
        agents_config: project_agents.to_string_lossy().into_owned(),
    })
    .await
    .map_err(|e| format!("spawn ui server: {e:#}"))
}

/// static_dir 候选（先到先得）：
///   1. env `LATTE_CHAT_UI_DIR`（开发/调试用覆盖）；
///   2. dev 锚点 `<repo>/public/chat-ui`（sync-chat-ui.sh 产物，
///      以 build 时 CARGO_MANIFEST_DIR 定位）；
///   3. prod：bundle resources 里的 `chat-ui`（tauri.conf.json
///      `bundle.resources` 条目）。
fn resolve_static_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("LATTE_CHAT_UI_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
        tracing::warn!(event = "chat_ui_server.bad_env_dir", path = %p.display());
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
        .join("chat-ui");
    if dev.is_dir() {
        return Some(dev);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("chat-ui");
        if bundled.is_dir() {
            return Some(bundled);
        }
    }
    tracing::warn!(event = "chat_ui_server.no_static_dir");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_key_maps_workspace_and_default() {
        // 工作区根原样为 key；None / 空串 → default。
        assert_eq!(server_key(Some("/home/u/proj")), "/home/u/proj");
        assert_eq!(server_key(None), "default");
        assert_eq!(server_key(Some("")), "default");
        // 不同工作区 → 不同 key（隔离的前提）。
        assert_ne!(server_key(Some("/a")), server_key(Some("/b")));
        assert_ne!(server_key(Some("/a")), server_key(None));
    }

    #[test]
    fn latte_subdirs_matches_controller_runtime_layout() {
        let (agents, models) = latte_subdirs(Path::new("/ws"));
        assert_eq!(agents, PathBuf::from("/ws/.latte/agents.d"));
        assert_eq!(models, PathBuf::from("/ws/.latte/models.d"));
    }
}
