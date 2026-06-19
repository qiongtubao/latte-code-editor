//! Manager-led interactive workflow runtime.
//!
//! **Flow** (stub mode, no LLM):
//!
//! 1. User sends a topic via `chat_start_manager_session`.
//! 2. Backend emits a `chat:turn` event for the manager role with a
//!    structured `ManagerAction` (parsed from JSON) and — if the
//!    action is `NeedDecision` — emits a `chat:need_decision` event
//!    so the UI shows option buttons.
//! 3. User clicks an option → `chat_user_decision` arrives → state
//!    moves to `AssigningWorker` (or `Finalizing`).
//! 4. Backend emits a worker `chat:turn` event with stub content.
//! 5. Loop: manager reflects → asks another question OR dispatches
//!    another worker OR finalizes.
//!
//! The runtime is **process-local**: each `chat_start_manager_session`
//! call creates a fresh `ManagerSessionState` stored in a
//! `HashMap<usize, Arc<Mutex<ManagerSessionState>>>` keyed by
//! `session_id`. Tauri restart clears it — the persisted
//! `state.json` + `transcript.jsonl` provide the recovery path
//! (resume support is a follow-up; not in v0).
//!
//! **Why stub mode in v0**: lets the user click through the full
//! interactive UX (option buttons, manager bubbles, worker turns)
//! without an API key. The LLM path will plug in behind
//! `parse_manager_json` and `next_action_for_topic` later — both
//! functions have the same shape, so swapping is mechanical.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::global_config::{load_global_models, load_roles_config};
use super::types::{
    DecisionOption, DecisionRequest, ManagerAction, ManagerSessionState, ManagerState,
    ManagerTurn, TurnPayload, UserDecision,
};

/// In-memory registry of active sessions. Persisted snapshots live
/// under `<ws>/.manager_<id>/state.json` (see `persist_state`).
static SESSIONS: OnceLock<Mutex<HashMap<usize, Arc<Mutex<ManagerSessionState>>>>>
    = OnceLock::new();
/// this with a structured-output call to the manager role.

/// Access the global session registry. Initializes on first call —
/// `parking_lot::Mutex::new` isn't const, so we can't use
fn sessions() -> &'static Mutex<HashMap<usize, Arc<Mutex<ManagerSessionState>>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn stub_action_for_topic(
    topic: &str,
    decisions_taken: u32,
    steps_taken: u32,
    available_roles: &[String],
) -> ManagerAction {
    let lower = topic.to_ascii_lowercase();
    if decisions_taken >= 4 || steps_taken >= 8 {
        // Budget exhausted → finalize.
        return ManagerAction::Finalize {
            summary: format!(
                "Stub-mode summary for `{topic}`. Reached decision/step budget — wrap up here."
            ),
        };
    }
    // Categorize the topic by keyword. Each branch returns (label,
    // question, options). The label is shown in the decision
    // bubble header so the user knows which heuristic fired and
    // can override if the heuristic was wrong.
    let (branch_label, q, opts) =
        if lower.contains("设计") || lower.contains("design") || lower.contains("架构") {
            (
                "🎨 设计任务",
                "下一步让谁先动手？",
                vec![
                    option("pm_only", "只让产品经理写需求", "先把范围、验收标准钉死再谈架构", Some("pm"), 0.005),
                    option("arch_only", "只让系统架构师画方案", "已经有大致想法，直接出架构草图", Some("architect"), 0.008),
                    option("pm_then_arch", "PM → 架构师 顺序两轮", "严谨路径：先需求后方案", Some("pm"), 0.018),
                    option("all_three", "PM + 架构师 + 测试工程师 并行", "一次出三份方案，但费用高", None, 0.045),
                ],
            )
        } else if lower.contains("bug") || lower.contains("fix") || lower.contains("错误") {
            (
                "🪲 Bug 排查",
                "怎么排查这个 bug？",
                vec![
                    option("repro_first", "先让测试工程师复现", "拿到稳定的复现步骤再动手", Some("tester"), 0.005),
                    option("devops_logs", "先看 devops 日志 / 监控", "从运维侧找异常更快", Some("devops"), 0.004),
                    option("code_dive", "直接让软件工程师读代码", "可能是个明显的逻辑错误", Some("programmer"), 0.006),
                    option("security_check", "怀疑安全相关 → 安全审计员先看", "涉及权限 / 输入校验时优先", Some("security"), 0.008),
                ],
            )
        } else if lower.contains("解释") || lower.contains("explain") || lower.contains("文档") {
            (
                "📝 文档 / 解释",
                "要写成什么样的文档？",
                vec![
                    option("tech_writer", "让技术写作写中文说明", "面向团队内部阅读", Some("tech_writer"), 0.004),
                    option("architect", "让架构师写 ADR / 设计文档", "需要技术决策依据", Some("architect"), 0.008),
                    option("video", "不写了，先口头解释 (Conclude)", "口头说清楚就行", None, 0.0),
                ],
            )
        } else {
            (
                "🧭 通用",
                "我不太确定怎么拆解这个任务 —— 你想怎么开始？",
                vec![
                    option("ask_pm", "先让产品经理理清需求", "任务多半隐含没说明的需求", Some("pm"), 0.005),
                    option("ask_arch", "先让架构师看可行性", "技术风险高的先排除", Some("architect"), 0.008),
                    option("just_do", "直接让软件工程师开干", "需求清晰，重在实现", Some("programmer"), 0.006),
                ],
            )
        };

    // Every decision must include the generic escape hatch — never
    // trap the user in a topical choice. Cost-free (no LLM call).
    let mut opts = opts;
    opts.push(option(
        "user_continue",
        "我说了算（让 manager 自己定 / 跳过）",
        "不要上面这些选项，让 manager 自己决定下一步",
        None,
        0.0,
    ));

    // Validate roles: any option pointing at a missing role gets
    // filtered out so the UI never offers a dead end.
    let opts: Vec<DecisionOption> = opts
        .into_iter()
        .filter(|o| match &o.worker_role {
            None => true,
            Some(r) => available_roles.iter().any(|ar| ar == r),
        })
        .collect();
    let opts = if opts.is_empty() {
        // No eligible roles → just propose to conclude.
        vec![option(
            "conclude_only",
            "无可用角色，先收尾",
            "当前没有可调度的角色，结束会话",
            None,
            0.0,
        )]
    } else {
        opts
    };

    ManagerAction::NeedDecision {
        branch_label: branch_label.to_string(),
        question: q.to_string(),
        reason: format!(
            "Stub-mode heuristic: branch={}, topic='{}', decisions_taken={}, steps_taken={}",
            branch_label, topic, decisions_taken, steps_taken
        ),
        options: opts,
    }
}

fn option(
    id: &str,
    label: &str,
    description: &str,
    worker_role: Option<&str>,
    estimated_cost_usd: f32,
) -> DecisionOption {
    DecisionOption {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        worker_role: worker_role.map(String::from),
        estimated_cost_usd,
    }
}

/// Stub worker response: a short templated paragraph the user can
/// see in the chat bubble. Real LLM path runs `run_discussion` with
/// `custom_roles = [step.role]` and surfaces the result.
fn stub_worker_response(role: &str, topic: &str, instruction: &str) -> String {
    format!(
        "## {role} 视角（stub）\n\n**话题**：{topic}\n\n**指令**：{instruction}\n\n（未配置 API key —— 这是 stub 响应。设置 `~/.latte/models.yaml` 后会切到真实模型。）"
    )
}

fn stub_reflection(_role: &str, topic: &str) -> ManagerAction {
    // After a worker runs, the manager usually wants to ask another
    // question. In stub mode we cycle through the available roles
    // so the user can see the full UI shape.
    // Post-worker reflection: every decision gets the generic
    // escape hatch appended so the user can always say "manager
    // 自己定 / 跳过".
    let mut reflection_opts = vec![
        option(
            "ask_another",
            "再请一个角色补充视角",
            "比如再让 reviewer 或 tester 看看",
            Some("reviewer"),
            0.006,
        ),
        option(
            "wrap_up",
            "够了，开始收尾",
            "整理成 summary",
            None,
            0.004,
        ),
        option(
            "user_continue",
            "我说了算（让 manager 自己定 / 跳过）",
            "不要上面这些选项，让 manager 自己决定下一步",
            None,
            0.0,
        ),
    ];
    // Filter out worker options whose role isn't actually available.
    let roles = load_roles_config();
    reflection_opts.retain(|o| match &o.worker_role {
        None => true,
        Some(r) => roles.roles.contains_key(r),
    });
    ManagerAction::NeedDecision {
        branch_label: "🔁 反射".to_string(),
        question: "已经收到 worker 的回复。下一步？".into(),
        reason: format!("stub-mode 反射：已收到 `{topic}` 的工作输出"),
        options: reflection_opts,
    }
}

/// Convert a manager action into the chat-bubble content shown in
/// the message list. Worker runs and decisions are surfaced
/// separately via `chat:turn` (worker bubble) and `chat:need_decision`
/// (option buttons).
fn action_to_bubble_text(action: &ManagerAction) -> String {
    match action {
        ManagerAction::NeedDecision { branch_label, question, reason, options } => format!(
            "[{branch_label}]\n\n**{question}**\n\n_{reason}_\n\n{}",
            options
                .iter()
                .map(|o| format!(
                    "- **{}** — {}（约 ${:.3}）",
                    o.label,
                    o.description,
                    o.estimated_cost_usd
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        ManagerAction::AssignWorker { worker_role, instruction } => format!(
            "→ 派单给 **{worker_role}**：{instruction}"
        ),
        ManagerAction::Finalize { summary } => format!("✨ **收尾**：\n\n{summary}"),
        ManagerAction::Conclude => "✅ 任务已收敛，无需再分配。" .to_string(),
    }
}

/// Persist session state to `<ws>/.manager_<id>/state.json` so the
/// session can be resumed (future) or audited.
fn persist_state(state: &ManagerSessionState, workspace: &Path) -> Result<(), String> {
    let dir = workspace.join(format!(".manager_{}", state.session_id));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create manager dir: {e}"))?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize state: {e}"))?;
    std::fs::write(dir.join("state.json"), json)
        .map_err(|e| format!("write state.json: {e}"))?;
    Ok(())
}

fn ensure_workspace(workspace: Option<&str>) -> PathBuf {
    if let Some(p) = workspace {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("LATTE_WORKSPACE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn next_session_id() -> usize {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(1);
    N.fetch_add(1, Ordering::SeqCst)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_turn(app: &AppHandle, payload: &TurnPayload) {
    let _ = app.emit("chat:turn", payload);
}

fn emit_decision(app: &AppHandle, req: &DecisionRequest) {
    let _ = app.emit("chat:need_decision", req);
}

/// Public entry: start a manager-led session for `topic`. Returns
/// the new session_id. Emits one `chat:turn` for the manager
/// (containing the first decision) and one `chat:need_decision`
/// event for the UI to render option buttons.
///
/// In stub mode this always works. With API keys configured this
/// would call the manager LLM; v0 is stub-only by design so the
/// user can click through immediately.
pub async fn start_manager_session(
    app: &AppHandle,
    topic: &str,
    workspace: Option<&str>,
) -> Result<usize, String> {
    if topic.trim().is_empty() {
        return Err("话题不能为空".to_string());
    }

    let roles_config = load_roles_config();
    let available_roles: Vec<String> = roles_config
        .roles
        .keys()
        .filter(|id| id.as_str() != "manager")
        .cloned()
        .collect();

    let session_id = next_session_id();
    let workspace = ensure_workspace(workspace);

    let state = ManagerSessionState {
        session_id,
        state: ManagerState::Planning,
        topic: topic.to_string(),
        manager_role_id: "manager".into(),
        available_roles: available_roles.clone(),
        max_total_steps: 8,
        max_user_decisions: 5,
        steps_taken: 0,
        decisions_taken: 0,
        turns: Vec::new(),
        started_at_ms: now_ms(),
        finished_at_ms: None,
        summary: None,
    };

    let state_arc = Arc::new(Mutex::new(state));
    {
        let mut registry = sessions().lock();
        registry.insert(session_id, state_arc.clone());
    }

    // Persist + emit first decision.
    take_manager_turn(app, &state_arc, &workspace, topic, 0, |s| {
        stub_action_for_topic(topic, s.decisions_taken, s.steps_taken, &available_roles)
    })?;

    Ok(session_id)
}

/// Called internally to compute and emit the manager's next
/// `chat:turn` + (optionally) `chat:need_decision`. Updates state,
/// persists, and emits events.
fn take_manager_turn<F>(
    app: &AppHandle,
    state_arc: &Arc<Mutex<ManagerSessionState>>,
    workspace: &Path,
    body: &str,
    turn_number: usize,
    action_fn: F,
) -> Result<(), String>
where
    F: FnOnce(&ManagerSessionState) -> ManagerAction,
{
    let (action, manager_bubble, decision) = {
        let mut s = state_arc.lock();
        let action = action_fn(&s);
        let bubble = action_to_bubble_text(&action);
        let decision = match &action {
            ManagerAction::NeedDecision {
                branch_label,
                question,
                reason,
                options,
            } => Some(DecisionRequest {
                session_id: s.session_id,
                branch_label: branch_label.clone(),
                question: question.clone(),
                reason: reason.clone(),
                options: options.clone(),
                context_summary: render_context_summary(&s.turns),
            }),
            _ => None,
        };
        let turn = ManagerTurn {
            turn_number,
            role_id: s.manager_role_id.clone(),
            role_name: "工程经理".into(),
            icon: "👔".into(),
            content: bubble.clone(),
            action: Some(action.clone()),
            user_decision: None,
            weight: 2.0, // manager messages default to high weight
            pinned: false,
            ts_ms: now_ms(),
        };
        s.turns.push(turn);
        // Promote state based on the action.
        s.state = match &action {
            ManagerAction::NeedDecision { .. } => ManagerState::AwaitingDecision,
            ManagerAction::AssignWorker { .. } => ManagerState::AssigningWorker,
            ManagerAction::Finalize { .. } => ManagerState::Finalizing,
            ManagerAction::Conclude => ManagerState::Done,
        };
        if matches!(s.state, ManagerState::Done | ManagerState::Finalizing) {
            s.finished_at_ms = Some(now_ms());
        }
        if matches!(s.state, ManagerState::Finalizing) {
            if let ManagerAction::Finalize { summary } = &action {
                s.summary = Some(summary.clone());
            }
        }
        // Snapshot for the manager bubble below.
        let payload = build_manager_turn_payload(&s, turn_number, &bubble);
        (action, payload, decision)
    };

    emit_turn(app, &manager_bubble);
    if let Some(d) = decision {
        emit_decision(app, &d);
    }

    // If the action was AssignWorker, immediately fire that worker
    // turn (in stub mode — real LLM would call run_discussion).
    if let ManagerAction::AssignWorker { worker_role, instruction } = &action {
        run_worker_stub(app, state_arc, workspace, worker_role, instruction, turn_number + 1)?;
    }

    persist_state(&state_arc.lock(), workspace).ok();
    Ok(())
}

fn build_manager_turn_payload(
    s: &ManagerSessionState,
    turn_number: usize,
    bubble: &str,
) -> TurnPayload {
    TurnPayload {
        agent: "工程经理".into(),
        role_id: s.manager_role_id.clone(),
        icon: "👔".into(),
        response: bubble.to_string(),
        round: 0,
        step_id: format!("manager_decision_{turn_number}"),
        turn_number,
        weight: 2.0,
        message_id: format!("{}:manager:{}", s.session_id, turn_number),
        pinned: false,
    }
}

fn render_context_summary(turns: &[ManagerTurn]) -> String {
    let last_few: Vec<&ManagerTurn> = turns.iter().rev().take(3).collect();
    last_few
        .into_iter()
        .rev()
        .map(|t| {
            let head = t.content.lines().next().unwrap_or("").to_string();
            format!("• {}", if head.len() > 80 { format!("{}…", &head[..80]) } else { head })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_worker_stub(
    app: &AppHandle,
    state_arc: &Arc<Mutex<ManagerSessionState>>,
    workspace: &Path,
    worker_role: &str,
    instruction: &str,
    turn_number: usize,
) -> Result<(), String> {
    let roles_config = load_roles_config();
    let role_def = roles_config.roles.get(worker_role);
    let (role_name, icon) = match role_def {
        Some(r) => (r.name.clone(), r.icon.clone()),
        None => (worker_role.to_string(), "💬".to_string()),
    };
    let topic = state_arc.lock().topic.clone();
    let response = stub_worker_response(worker_role, &topic, instruction);

    let payload = TurnPayload {
        agent: role_name.clone(),
        role_id: worker_role.to_string(),
        icon: icon.clone(),
        response: response.clone(),
        round: 0,
        step_id: format!("worker_{turn_number}"),
        turn_number,
        weight: 1.0,
        message_id: format!("{}:worker:{}", state_arc.lock().session_id, turn_number),
        pinned: false,
    };

    // Record worker turn in session state.
    {
        let mut s = state_arc.lock();
        s.steps_taken += 1;
        s.turns.push(ManagerTurn {
            turn_number,
            role_id: worker_role.to_string(),
            role_name: role_name.clone(),
            icon: icon.clone(),
            content: response,
            action: None,
            user_decision: None,
            weight: 1.0,
            pinned: false,
            ts_ms: now_ms(),
        });
        // After worker runs, manager reflects.
        s.state = ManagerState::Reflecting;
    }

    emit_turn(app, &payload);
    persist_state(&state_arc.lock(), workspace).ok();

    // Chain the reflection step.
    take_manager_turn(app, state_arc, workspace, &topic, turn_number + 1, |s| {
        stub_reflection(worker_role, &s.topic)
    })
}

/// Handle the user's choice. Resumes the state machine from
/// `AwaitingDecision` (or `Reflecting` if the user picked from a
/// reflection).
pub async fn submit_user_decision(
    app: &AppHandle,
    decision: UserDecision,
) -> Result<(), String> {
    let (action_for_chosen_option, session_topic, next_turn_number) = {
        let registry = sessions().lock();
        let state_arc = registry
            .get(&decision.session_id)
            .ok_or_else(|| format!("session {} 未找到", decision.session_id))?
            .clone();

        let mut s = state_arc.lock();
        let last_decision_turn = s
            .turns
            .iter()
            .rev()
            .find(|t| matches!(t.action, Some(ManagerAction::NeedDecision { .. })))
            .ok_or_else(|| "当前没有等待中的决策请求".to_string())?;
        let options = match &last_decision_turn.action {
            Some(ManagerAction::NeedDecision { options, .. }) => options.clone(),
            _ => unreachable!(),
        };
        let chosen = options
            .iter()
            .find(|o| o.id == decision.option_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "选项 `{}` 不存在（有效选项：{}）",
                    decision.option_id,
                    options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>().join(", ")
                )
            })?;

        // Record the user's pick on the most recent manager turn
        // (i.e. on the decision request bubble).
        let mut s_mut = s;
        if let Some(last) = s_mut.turns.last_mut() {
            if matches!(last.action, Some(ManagerAction::NeedDecision { .. })) {
                last.user_decision = Some(UserDecision {
                    session_id: decision.session_id,
                    option_id: decision.option_id.clone(),
                    free_text: decision.free_text.clone(),
                });
            }
        }
        s_mut.decisions_taken += 1;

        // Decide what happens next based on the option the user
        // picked.
        let next_action = match chosen.worker_role.as_deref() {
            None => ManagerAction::Conclude,
            Some(role) => {
                let instruction = decision
                    .free_text
                    .clone()
                    .unwrap_or_else(|| format!("处理 `{}`", s_mut.topic));
                ManagerAction::AssignWorker {
                    worker_role: role.to_string(),
                    instruction,
                }
            }
        };
        let topic = s_mut.topic.clone();
        let next_turn = s_mut.turns.len();
        (next_action, topic, next_turn)
    };

    let registry = sessions().lock();
    let state_arc = registry
        .get(&decision.session_id)
        .ok_or_else(|| format!("session {} 未找到", decision.session_id))?
        .clone();
    drop(registry);

    let workspace = ensure_workspace(None);
    take_manager_turn(app, &state_arc, &workspace, &session_topic, next_turn_number, |_| {
        action_for_chosen_option.clone()
    })
}

/// User pushes the session forward without picking an option (e.g.
/// "just go ahead") or with their own instruction.
pub async fn submit_user_continue(
    app: &AppHandle,
    session_id: usize,
    message: Option<String>,
) -> Result<(), String> {
    let registry = sessions().lock();
    let state_arc = registry
        .get(&session_id)
        .ok_or_else(|| format!("session {session_id} 未找到"))?
        .clone();
    drop(registry);

    let workspace = ensure_workspace(None);

    // If user provides a free-text message, treat it as a topic
    // amendment + force the manager to re-plan. Otherwise, ask the
    // manager to continue without user picking.
    let (topic, next_turn) = {
        let s = state_arc.lock();
        (s.topic.clone(), s.turns.len())
    };

    let action = match message.as_deref() {
        Some(text) if !text.trim().is_empty() => {
            // Append as a context note and re-plan.
            {
                let mut s_mut = state_arc.lock();
                let note = format!("[用户补充] {}", text);
                if let Some(last) = s_mut.turns.last_mut() {
                    last.content.push_str(&format!("\n\n{}", note));
                }
                s_mut.topic.push_str(&format!("\n[补充] {}", text));
            }
            stub_action_for_topic(&topic, 0, 0, &state_arc.lock().available_roles)
        }
        _ => ManagerAction::NeedDecision {
            branch_label: "🧭 通用".into(),
            question: "下一步？".into(),
            reason: "用户主动推进，但 manager 没有明确指令".into(),
            options: vec![
                option("auto_continue", "manager 自己定", "按 manager 决策继续", Some("manager"), 0.003),
                option("force_pm", "强制 PM 出手", "覆盖 manager 的判断", Some("pm"), 0.005),
                option("force_programmer", "强制软件工程师出手", "跳过 PM/Arch 直接实现", Some("programmer"), 0.006),
                option("conclude", "收尾", "任务到此为止", None, 0.0),
            ],
        },
    };
    take_manager_turn(app, &state_arc, &workspace, &topic, next_turn, |_| action)
}

/// Fetch a snapshot of the session state (used for resume / fork /
/// frontend reconciliation on reconnect).
pub fn get_session_state(session_id: usize) -> Option<ManagerSessionState> {
    let registry = sessions().lock();
    registry.get(&session_id).map(|arc| arc.lock().clone())
}

/// List all live sessions. Mostly useful for debugging / tests.
pub fn list_sessions() -> Vec<usize> {
    let registry = sessions().lock();
    registry.keys().copied().collect()
}

/// Manually terminate a session (used by tests and by the UI's
/// "stop" button).
pub fn abort_session(session_id: usize, reason: &str) -> Result<(), String> {
    let registry = sessions().lock();
    let state_arc = registry
        .get(&session_id)
        .ok_or_else(|| format!("session {session_id} 未找到"))?
        .clone();
    drop(registry);

    let mut s = state_arc.lock();
    s.state = ManagerState::Failed;
    s.finished_at_ms = Some(now_ms());
    if let Some(last) = s.turns.last_mut() {
        last.content.push_str(&format!("\n\n⚠️ 会话中止：{reason}"));
    }
    Ok(())
}

/// Compute a deterministic stub action for tests (avoids touching
/// the global SESSIONS registry).
pub fn stub_decision_for_tests(
    topic: &str,
    decisions_taken: u32,
    steps_taken: u32,
    available_roles: &[String],
) -> ManagerAction {
    stub_action_for_topic(topic, decisions_taken, steps_taken, available_roles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_budget_exhaustion_finalizes() {
        let action = stub_action_for_topic(
            "设计一个登录页",
            4,
            0,
            &["pm".into(), "architect".into()],
        );
        assert!(matches!(action, ManagerAction::Finalize { .. }));
    }

    #[test]
    fn stub_design_topic_offers_known_roles() {
        let action =
            stub_action_for_topic("设计登录页", 0, 0, &["pm".into(), "architect".into()]);
        match action {
            ManagerAction::NeedDecision { options, .. } => {
                let ids: Vec<&str> = options.iter().map(|o| o.id.as_str()).collect();
                assert!(ids.contains(&"pm_only"));
                assert!(ids.contains(&"arch_only"));
            }
            other => panic!("expected NeedDecision, got {other:?}"),
        }
    }

    #[test]
    fn stub_filters_unknown_roles() {
        let action = stub_action_for_topic(
            "设计登录页",
            0,
            0,
            &["pm".into()], // architect missing
        );
        match action {
            ManagerAction::NeedDecision { options, .. } => {
                // arch_only requires a role that doesn't exist, so
                // it's filtered out. We should still have pm_only.
                assert!(options.iter().any(|o| o.id == "pm_only"));
                assert!(!options.iter().any(|o| o.id == "arch_only"));
            }
            other => panic!("expected NeedDecision, got {other:?}"),
        }
    }

    #[test]
    fn stub_bug_topic_includes_tester() {
        let action = stub_action_for_topic(
            "fix the login bug",
            0,
            0,
            &["tester".into(), "programmer".into()],
        );
        match action {
            ManagerAction::NeedDecision { options, .. } => {
                assert!(options.iter().any(|o| o.worker_role.as_deref() == Some("tester")));
            }
            other => panic!("expected NeedDecision, got {other:?}"),
        }
    }
    #[test]
    fn stub_zero_roles_falls_back_to_conclude() {
        let action = stub_action_for_topic("任何话题", 0, 0, &[]);
        match action {
            ManagerAction::NeedDecision { options, .. } => {
                assert_eq!(options.len(), 1);
                assert!(options[0].worker_role.is_none());
            }
            other => panic!("expected NeedDecision, got {other:?}"),
        }
    }

    #[test]
    fn each_branch_returns_distinct_label() {
        // The branch_label tells the user which heuristic fired so
        // they can override if the manager guessed wrong.
        let design = stub_action_for_topic(
            "设计登录页",
            0,
            0,
            &["pm".into(), "architect".into()],
        );
        let bug = stub_action_for_topic(
            "fix login bug",
            0,
            0,
            &["tester".into(), "programmer".into()],
        );
        let docs = stub_action_for_topic(
            "解释一下",
            0,
            0,
            &["tech_writer".into(), "architect".into()],
        );
        let generic = stub_action_for_topic(
            "随便聊聊",
            0,
            0,
            &["pm".into()],
        );
        let (d, b, doc, g) = (
            extract_label(&design),
            extract_label(&bug),
            extract_label(&docs),
            extract_label(&generic),
        );
        assert_eq!(d, "🎨 设计任务");
        assert_eq!(b, "🪲 Bug 排查");
        assert_eq!(doc, "📝 文档 / 解释");
        assert_eq!(g, "🧭 通用");
    }

    #[test]
    fn every_decision_includes_user_continue_escape_hatch() {
        // The user must always be able to say "manager 自己定 / 跳过"
        // regardless of which branch fired. This is the core fix for
        // the "没有显示出通用" UX bug — the generic escape hatch is
        // present even in topical branches.
        let all_roles = vec![
            "pm".into(),
            "architect".into(),
            "programmer".into(),
            "tester".into(),
            "devops".into(),
            "tech_writer".into(),
        ];
        for topic in &[
            "设计登录页",
            "fix login bug",
            "解释一下",
            "随便聊聊",
            "Hello",
        ] {
            let action = stub_action_for_topic(topic, 0, 0, &all_roles);
            let opts = match action {
                ManagerAction::NeedDecision { options, .. } => options,
                _ => panic!("{topic} did not produce NeedDecision"),
            };
            assert!(
                opts.iter().any(|o| o.id == "user_continue"),
                "{topic}: must always offer the user_continue escape hatch, got {opts:?}"
            );
            let escape = opts.iter().find(|o| o.id == "user_continue").unwrap();
            assert!(escape.worker_role.is_none(), "escape hatch shouldn't dispatch a worker");
            assert_eq!(escape.estimated_cost_usd, 0.0, "escape hatch is cost-free");
        }
    }

    fn extract_label(action: &ManagerAction) -> String {
        match action {
            ManagerAction::NeedDecision { branch_label, .. } => branch_label.clone(),
            _ => panic!("expected NeedDecision, got {action:?}"),
        }
    }
}
