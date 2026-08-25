//! HIL (Human-In-Loop) Blackboard session runtime.
//!
//! Wraps `latte_agent_core::session::SessionManager` +
//! `latte_agent_core::workspace::WorkspaceManager` behind the Tauri
//! command surface that the editor's chat panel uses. The key
//! invariant: **the on-disk JSON at
//! `<worktree>/.latte/sessions/<id>.json` is the source of truth.**
//!
//! Every command reads the latest JSON, mutates the in-memory
//! `SessionManager`, calls `persist()`, and emits a `chat:hil_state`
//! event so the editor refreshes. Pause / resume / edit / delete all
//! round-trip through this file so a user can hand-edit it while the
//! session is paused — that's the v1 spec's "外科手术式回滚" requirement.
//!
//! The runtime is process-local (no LLM calls in v1 — the editor just
//! records the human's role in driving the session). A follow-up wires
//! the manager role through `latte_agent_core::agent::AgentRunner` and
//! uses `latte-agent-orchestrator::RoundScheduler` to drive multi-role
//! turns. For now the editor exposes the editable transcript
//! surface and routes user input to the named role's history.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use latte_agent_core::session::{
    RoleHistory, SessionManager, SessionRecord, SessionState,
};
use latte_agent_core::workspace::{Blackboard, WorkspaceManager};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::types::{
    HilContinueRequest, HilEditRequest, HilInjectRequest, HilMessage, HilRoleHistory,
    HilSendRequest, HilSessionState, HilStartRequest, HilTransitionRequest,
};

// ─── In-memory cache ──────────────────────────────────────────────
//
// One `SessionManager` per task_id. We need `&mut SessionManager`
// (no `Clone` upstream), so we park the whole map behind a single
// `Mutex` and lock it for the duration of each command. The critical
// section is small (a few `serde_json` round-trips on a tiny record)
// so contention isn't a concern in the editor's single-user
// process.

type CacheMap = HashMap<String, CachedEntry>;

static CACHE: std::sync::LazyLock<Mutex<CacheMap>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

struct CachedEntry {
    manager: SessionManager,
    worktree_root: PathBuf,
}

// ─── Public entry points (Tauri commands) ─────────────────────────

/// Start a new HIL session. Creates the worktree + `plan.md` via
/// `WorkspaceManager` (matching the CLI's `latte-agent run --task-id X`
/// behavior), instantiates a `SessionManager`, persists the empty
/// record, and returns the initial snapshot.
pub fn start_session(
    app: &AppHandle,
    req: HilStartRequest,
) -> Result<HilSessionState, String> {
    validate_task_id(&req.task_id)?;
    if req.initial_prompt.trim().is_empty() {
        return Err("initial_prompt 不能为空".into());
    }
    let cwd = resolve_cwd(req.cwd.as_deref())?;

    // 1. Create the worktree. If the task_id is in use we surface a
    //    friendly error so the editor can suggest the "open existing"
    //    path. `WorkspaceManager::create` is idempotent only at the
    //    "no worktree exists" boundary — repeated starts of the same
    //    task must use `chat_hil_get_state` (load) or
    //    `chat_hil_resume` (load + transition).
    let workspace = WorkspaceManager::create(&cwd, &req.task_id, &req.initial_prompt)
        .map_err(|e| format!(
            "创建 worktree 失败：{e}\n提示：{task_id} 已存在请改用「恢复会话」",
            task_id = req.task_id,
        ))?;

    // 2. Build the SessionManager. Empty role list is allowed — the
    //    editor can add roles later via `chat_hil_inject` /
    //    `chat_hil_send`. Default to `["manager"]` so the first
    //    pause/resume cycle has a sensible sink.
    let roles = if req.roles.is_empty() {
        vec!["manager".to_string()]
    } else {
        req.roles.clone()
    };

    let worktree_root = workspace.spec().worktree_root.clone();
    let blackboard_path = workspace.spec().blackboard_path.clone();
    let mut mgr = SessionManager::new(&req.task_id, worktree_root.clone(), roles);

    // 3. Replace the stub `plan.md` with the real initial prompt +
    //    role roster. WorkspaceManager::create wrote a minimal header;
    //    overwrite it now. We patch `plan_md` via a JSON round-trip —
    //    SessionManager has no public mutator for record fields.
    let bb = Blackboard::new(blackboard_path);
    let plan = format_plan_md(&req.task_id, &req.initial_prompt, mgr.record().roles.as_slice());
    bb.write(&plan).map_err(|e| format!("写入 plan.md 失败：{e}"))?;
    write_plan_md_field(&mut mgr, &plan)?;

    let state = build_state(&mgr, &worktree_root);
    {
        let mut cache = CACHE.lock();
        cache.insert(
            req.task_id.clone(),
            CachedEntry {
                manager: mgr,
                worktree_root: worktree_root.clone(),
            },
        );
    }
    emit_state(app, &state);
    Ok(state)
}

/// Append a new message to a role's history. The "send" path.
pub fn send_message(
    app: &AppHandle,
    req: HilSendRequest,
) -> Result<HilSessionState, String> {
    if req.content.trim().is_empty() {
        return Err("消息内容不能为空".into());
    }
    let mut cache = CACHE.lock();
    let entry = load_into(&mut cache, &req.task_id, req.cwd.as_deref())?;
    // Ensure the role exists. The HIL spec lets a session be
    // bootstrapped with an empty role list; lazily creating a role on
    // first send keeps the contract simple ("send to <role> works
    // even if you forgot to declare it").
    ensure_role(&mut entry.manager, &req.role_id)?;

    let role_enum = if req.is_user {
        latte_ai::models::Role::User
    } else {
        latte_ai::models::Role::Assistant
    };
    // 修复:Message 缺少 tool_call_id / tool_calls 字段,普通文本消息设为 None
    let msg = latte_ai::models::Message {
        role: role_enum,
        content: vec![latte_ai::models::ContentPart::text(req.content.clone())],
        // 函数调用相关字段:用户输入文本消息时无 tool_call,置 None
        tool_call_id: None,
        tool_calls: None,
    };
    entry
        .manager
        .append_to_role(&req.role_id, msg)
        .map_err(|e| format!("追加消息失败：{e}"))?;
    entry
        .manager
        .advance_turn()
        .map_err(|e| format!("推进 turn 计数器失败：{e}"))?;

    let state = build_state(&entry.manager, &entry.worktree_root);
    emit_state(app, &state);
    Ok(state)
}

/// Edit or delete an existing message. The "可修改聊天内容继续"
/// requirement: while a session is paused, the user can fix any
/// message in any role's history, then press "继续" to resume.
pub fn edit_message(
    app: &AppHandle,
    req: HilEditRequest,
) -> Result<HilSessionState, String> {
    let action = req.action.as_str();
    if action != "edit" && action != "delete" {
        return Err(format!("未知 action `{action}`（期望 edit | delete）"));
    }

    let mut cache = CACHE.lock();
    let entry = load_into(&mut cache, &req.task_id, req.cwd.as_deref())?;

    // SessionManager exposes no public mutator for in-place edits, so
    // we round-trip through serde_json. The on-disk file is the
    // source of truth; this preserves that contract.
    let mut record = entry.manager.record().clone();
    let role = record
        .roles
        .iter_mut()
        .find(|r| r.role_id == req.role_id)
        .ok_or_else(|| format!("role `{}` 不存在", req.role_id))?;

    if req.message_index >= role.messages.len() {
        return Err(format!(
            "message_index {} 超出范围（role `{}` 共有 {} 条）",
            req.message_index,
            req.role_id,
            role.messages.len()
        ));
    }
    match action {
        "edit" => {
            let new_content = req
                .new_content
                .as_deref()
                .ok_or_else(|| "edit action 需要 new_content".to_string())?;
            if new_content.trim().is_empty() {
                return Err("编辑后内容不能为空".into());
            }
            role.messages[req.message_index].content = vec![latte_ai::models::ContentPart::text(new_content.to_string())];
        }
        "delete" => {
            role.messages.remove(req.message_index);
        }
        _ => unreachable!(),
    }

    // Rebuild the SessionManager from the patched record and persist.
    let new_mgr =
        SessionManager::from_record(record, entry.worktree_root.clone());
    new_mgr
        .persist()
        .map_err(|e| format!("持久化失败：{e}"))?;

    let state = build_state(&new_mgr, &entry.worktree_root);
    entry.manager = new_mgr;
    emit_state(app, &state);
    Ok(state)
}

/// Inject a message targeted at one role from outside the REPL.
/// Equivalent to the CLI's `latte-agent inject --task-id X --role Y
/// --message "..."`.
pub fn inject_message(
    app: &AppHandle,
    req: HilInjectRequest,
) -> Result<HilSessionState, String> {
    let mut cache = CACHE.lock();
    let entry = load_into(&mut cache, &req.task_id, req.cwd.as_deref())?;
    ensure_role(&mut entry.manager, &req.role_id)?;
    let now = iso8601_utc_now();
    // 修复:Message 缺少 tool_call_id / tool_calls 字段,普通文本消息设为 None
    let msg = latte_ai::models::Message {
        role: latte_ai::models::Role::User,
        content: vec![latte_ai::models::ContentPart::text(format!("[HUMAN @ {}]\n{}", now, req.message))],
        // 函数调用相关字段:HIL 注入消息为纯文本,无 tool_call
        tool_call_id: None,
        tool_calls: None,
    };
    entry
        .manager
        .append_to_role(&req.role_id, msg)
        .map_err(|e| format!("注入消息失败：{e}"))?;

    let state = build_state(&entry.manager, &entry.worktree_root);
    emit_state(app, &state);
    Ok(state)
}

/// Resume + send in one call. The editor's "继续" button posts this
/// when there's a typed message; empty content just resumes.
pub fn continue_session(
    app: &AppHandle,
    req: HilContinueRequest,
) -> Result<HilSessionState, String> {
    let mut cache = CACHE.lock();
    let entry = load_into(&mut cache, &req.task_id, req.cwd.as_deref())?;
    if req.content.trim().is_empty() {
        entry
            .manager
            .resume()
            .map_err(|e| format!("恢复失败：{e}"))?;
    } else {
        ensure_role(&mut entry.manager, &req.role_id)?;
        entry
            .manager
            .resume_with_message(&req.role_id, &req.content)
            .map_err(|e| format!("恢复并追加消息失败：{e}"))?;
    }
    let state = build_state(&entry.manager, &entry.worktree_root);
    emit_state(app, &state);
    Ok(state)
}

/// Pause / resume / abort in one command. Routes on `action`.
pub fn transition(
    app: &AppHandle,
    req: HilTransitionRequest,
) -> Result<HilSessionState, String> {
    let mut cache = CACHE.lock();
    let entry = load_into(&mut cache, &req.task_id, req.cwd.as_deref())?;
    match req.action.as_str() {
        "pause" => {
            let reason = req
                .reason
                .as_deref()
                .unwrap_or("editor: 用户手动暂停")
                .to_string();
            entry
                .manager
                .pause(&reason)
                .map_err(|e| format!("暂停失败：{e}"))?;
        }
        "resume" => {
            // Optional inline message: if the user supplied one, route
            // through `resume_with_message`; otherwise plain `resume`.
            if let (Some(role), Some(msg)) =
                (req.role_id.as_deref(), req.message.as_deref())
            {
                if !msg.trim().is_empty() {
                    ensure_role(&mut entry.manager, role)?;
                    entry
                        .manager
                        .resume_with_message(role, msg)
                        .map_err(|e| format!("恢复并注入消息失败：{e}"))?;
                } else {
                    entry
                        .manager
                        .resume()
                        .map_err(|e| format!("恢复失败：{e}"))?;
                }
            } else {
                entry
                    .manager
                    .resume()
                    .map_err(|e| format!("恢复失败：{e}"))?;
            }
        }
        "abort" => {
            entry
                .manager
                .mark_done()
                .map_err(|e| format!("中止失败：{e}"))?;
        }
        other => {
            return Err(format!(
                "未知 action `{other}`（期望 pause | resume | abort）"
            ))
        }
    }
    let state = build_state(&entry.manager, &entry.worktree_root);
    emit_state(app, &state);
    Ok(state)
}

/// Fetch a session's full state. `None` if no JSON exists for the
/// task_id in this repo.
pub fn get_state(
    app: &AppHandle,
    task_id: &str,
    cwd: Option<&str>,
) -> Result<Option<HilSessionState>, String> {
    validate_task_id(task_id)?;
    // Try cache first.
    {
        let cache = CACHE.lock();
        if let Some(entry) = cache.get(task_id) {
            return Ok(Some(build_state(&entry.manager, &entry.worktree_root)));
        }
    }
    // Fall back to scanning disk.
    let cwd = resolve_cwd(cwd)?;
    let repo_root = match WorkspaceManager::resolve_repo_root(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let worktree_root = repo_root
        .join(".latte")
        .join("worktrees")
        .join(task_id);
    if !worktree_root.exists() {
        return Ok(None);
    }
    let Some((record, _json_path)) = find_latest_session(&worktree_root, task_id)? else {
        return Ok(None);
    };
    let mgr = SessionManager::from_record(record, worktree_root.clone());
    let state = build_state(&mgr, &worktree_root);
    {
        let mut cache = CACHE.lock();
        cache.insert(
            task_id.to_string(),
            CachedEntry {
                manager: mgr,
                worktree_root: worktree_root.clone(),
            },
        );
    }
    emit_state(app, &state);
    Ok(Some(state))
}

/// List task ids with on-disk sessions. Used to populate the
/// "open existing" dropdown in the editor.
pub fn list_sessions(cwd: Option<&str>) -> Result<Vec<HilSessionSummary>, String> {
    let cwd = resolve_cwd(cwd)?;
    let repo_root = match WorkspaceManager::resolve_repo_root(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let worktrees_dir = repo_root.join(".latte").join("worktrees");
    if !worktrees_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&worktrees_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let task_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let Some((record, _)) = find_latest_session(&path, &task_id)? else {
            continue;
        };
        out.push(HilSessionSummary {
            task_id: record.task_id,
            session_id: record.session_id,
            state: session_state_str(&record.state).to_string(),
            updated_at: record.updated_at,
            paused_at: record.paused_at,
            worktree_root: path.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

// ─── Internals ────────────────────────────────────────────────────

/// Minimal summary for the "open existing" dropdown.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HilSessionSummary {
    pub task_id: String,
    pub session_id: String,
    pub state: String,
    pub updated_at: String,
    pub paused_at: Option<String>,
    pub worktree_root: String,
}

/// Lazily add a role to the session. Re-builds the `SessionManager`
/// from a patched `SessionRecord` and persists — the only safe way
/// to mutate `roles` without upstream changes. Returns Ok even if the
/// role already existed (idempotent).
fn ensure_role(mgr: &mut SessionManager, role_id: &str) -> Result<(), String> {
    if mgr.record().roles.iter().any(|r| r.role_id == role_id) {
        return Ok(());
    }
    let mut record = mgr.record().clone();
    // 修复:RoleHistory 新增 paused / pause_reason / paused_at 字段,新建 role 默认为未暂停
    record.roles.push(RoleHistory {
        role_id: role_id.to_string(),
        messages: Vec::new(),
        last_turn: 0,
        // 新建 role 时 paused 置 false,无暂停原因和暂停时间
        paused: false,
        pause_reason: None,
        paused_at: None,
    });
    let new_mgr =
        SessionManager::from_record(record, mgr.worktree_root().to_path_buf());
    new_mgr
        .persist()
        .map_err(|e| format!("创建 role `{role_id}` 失败：{e}"))?;
    *mgr = new_mgr;
    Ok(())
}

/// Patch `plan_md` on a freshly-built `SessionManager` (the only
/// field that lacks a public mutator and is set immediately after
/// `SessionManager::new`). Serializes the record back to JSON and
/// re-parses — the disk file is the source of truth so we go through
/// the same code path as `persist()`.
fn write_plan_md_field(mgr: &mut SessionManager, content: &str) -> Result<(), String> {
    let mut record = mgr.record().clone();
    record.plan_md = content.to_string();
    let new_mgr =
        SessionManager::from_record(record, mgr.worktree_root().to_path_buf());
    new_mgr
        .persist()
        .map_err(|e| format!("持久化 plan_md 失败：{e}"))?;
    *mgr = new_mgr;
    Ok(())
}

fn build_state(mgr: &SessionManager, worktree_root: &Path) -> HilSessionState {
    let record = mgr.record();
    let roles: Vec<HilRoleHistory> = record
        .roles
        .iter()
        .map(|r| HilRoleHistory {
            role_id: r.role_id.clone(),
            messages: r
                .messages
                .iter()
                .enumerate()
                .map(|(i, m)| HilMessage {
                    index: i,
                    role: format!("{:?}", m.role).to_lowercase(),
                    content: m.as_text(),
                    timestamp: None,
                })
                .collect(),
        })
        .collect();
    HilSessionState {
        session_id: record.session_id.clone(),
        task_id: record.task_id.clone(),
        state: session_state_str(&record.state).to_string(),
        plan_md: record.plan_md.clone(),
        active_checkpoint_id: record.active_checkpoint_id,
        current_turn: record.current_turn,
        roles,
        paused_at: record.paused_at.clone(),
        pause_reason: record.pause_reason.clone(),
        started_at: record.started_at.clone(),
        updated_at: record.updated_at.clone(),
        session_json_path: mgr.session_path().to_string_lossy().into_owned(),
        worktree_root: worktree_root.to_string_lossy().into_owned(),
    }
}

fn session_state_str(s: &SessionState) -> &'static str {
    match s {
        SessionState::Created => "created",
        SessionState::Running => "running",
        SessionState::Paused => "paused",
        SessionState::Resumed => "resumed",
        SessionState::Done => "done",
        SessionState::Failed => "failed",
    }
}

fn emit_state(app: &AppHandle, state: &HilSessionState) {
    let _ = app.emit("chat:hil_state", state);
}

/// Read the latest session JSON for a task_id under
/// `<worktree>/.latte/sessions/`. Returns the parsed record and the
/// on-disk path so the caller can persist via the same file.
fn find_latest_session(
    worktree_root: &Path,
    task_id: &str,
) -> Result<Option<(SessionRecord, PathBuf)>, String> {
    let sessions_dir = worktree_root.join(".latte").join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }
    let mut best: Option<(std::time::SystemTime, SessionRecord, PathBuf)> = None;
    for entry in std::fs::read_dir(&sessions_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let record: SessionRecord = match serde_json::from_str(&raw) {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "[hil] skip unparsable session {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
        };
        if record.task_id != task_id {
            continue;
        }
        match &best {
            Some((t, _, _)) if *t >= modified => {}
            _ => best = Some((modified, record, path.clone())),
        }
    }
    Ok(best.map(|(_, r, p)| (r, p)))
}

/// Resolve the worktree root for a task_id without touching the
/// cache. Used to find a missing-cache entry on the first call.
fn resolve_worktree_root(task_id: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let cwd = resolve_cwd(cwd)?;
    let repo_root = WorkspaceManager::resolve_repo_root(&cwd)
        .map_err(|e| format!("{e}（请在 git 仓库内打开会话）"))?;
    let worktree_root = repo_root
        .join(".latte")
        .join("worktrees")
        .join(task_id);
    Ok(worktree_root)
}

/// Return a `&mut CachedEntry` for the task_id, loading from disk if
/// the cache doesn't have one. Caller must hold the cache lock.
fn load_into<'a>(
    cache: &'a mut CacheMap,
    task_id: &str,
    cwd: Option<&str>,
) -> Result<&'a mut CachedEntry, String> {
    validate_task_id(task_id)?;
    if !cache.contains_key(task_id) {
        let worktree_root = resolve_worktree_root(task_id, cwd)?;
        if !worktree_root.exists() {
            return Err(format!(
                "未找到 task_id `{task_id}` 的 worktree（{dir} 不存在）",
                dir = worktree_root.display()
            ));
        }
        let (record, _json_path) = find_latest_session(&worktree_root, task_id)?
            .ok_or_else(|| format!("task_id `{task_id}` 下没有任何 session JSON"))?;
        let mgr = SessionManager::from_record(record, worktree_root.clone());
        cache.insert(
            task_id.to_string(),
            CachedEntry {
                manager: mgr,
                worktree_root,
            },
        );
    }
    // Safe: we just inserted under task_id if missing.
    Ok(cache.get_mut(task_id).expect("just inserted"))
}

fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    match cwd {
        Some(p) if !p.is_empty() => Ok(PathBuf::from(p)),
        _ => std::env::current_dir().map_err(|e| format!("获取当前目录失败：{e}")),
    }
}

fn validate_task_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("task_id 不能为空".into());
    }
    if id.len() > 64 {
        return Err("task_id 过长（最多 64 字符）".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("task_id 含有非法字符，仅允许字母数字、`-`、`_`".into());
    }
    Ok(())
}

fn format_plan_md(task_id: &str, initial_prompt: &str, roles: &[RoleHistory]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Task: {}\n\n", task_id));
    out.push_str("## Roles\n\n");
    for r in roles {
        out.push_str(&format!("- `{}`\n", r.role_id));
    }
    out.push_str("\n## Initial prompt\n\n");
    out.push_str(initial_prompt);
    out.push('\n');
    out
}

/// Local copy of `latte_agent_core::trace::iso8601_utc_now` (which
/// is `pub(crate)` and not visible to us). Same proleptic-Gregorian
/// algorithm — the format is what `SessionRecord` stores in
/// `started_at` / `updated_at` / `paused_at`, so we keep the wire
/// format identical.
fn iso8601_utc_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

fn epoch_to_ymdhms(secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = (secs % 60) as u32;
    let mins = (secs / 60) as u32;
    let mi = mins % 60;
    let hours = mins / 60;
    let h = hours % 24;
    let mut days = (hours / 24) as i64;
    let mut year = 1970i64;
    loop {
        let leap = is_leap(year);
        let dy = if leap { 366 } else { 365 };
        if days >= dy {
            days -= dy;
            year += 1;
        } else {
            break;
        }
    }
    let month_lens = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 {
        let ml = if month == 1 && is_leap(year) { 29 } else { month_lens[month] };
        if days >= ml {
            days -= ml;
            month += 1;
        } else {
            break;
        }
    }
    (year as u32, month as u32 + 1, days as u32 + 1, h, mi, s)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
