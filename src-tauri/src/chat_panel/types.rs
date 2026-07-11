use serde::{Deserialize, Serialize};

/// A single agent turn, sent as a streaming event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPayload {
    pub agent: String,
    pub role_id: String,
    pub icon: String,
    pub response: String,
    pub round: usize,
    pub step_id: String,
    pub turn_number: usize,
    /// Importance weight (0.0 = droppable, 1.0 = default, 5.0 = pinned).
    /// Editor UI lets the user adjust this. The summarizer uses it to
    /// decide which turns to keep verbatim vs. summarize vs. drop
    /// when the model-view byte cap is hit.
    #[serde(default = "default_weight")]
    pub weight: f32,
    /// Stable id so the frontend can target a specific message for
    /// delete / edit operations. Backend sets this to
    /// `{session_id}:{turn_number}`.
    #[serde(default)]
    pub message_id: String,
    /// Whether the user marked this message as pinned (weight >= 5.0).
    /// Pinned messages are never dropped by the summarizer.
    #[serde(default)]
    pub pinned: bool,
}

fn default_weight() -> f32 {
    1.0
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionPayload {
    pub rounds: Vec<RoundPayload>,
    pub consensus_reached: bool,
    pub summary: Option<String>,
    pub total_input_tokens: u32,
    pub total_output_tokens: u32,
    pub stub: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundPayload {
    pub number: usize,
    pub turns: Vec<TurnPayload>,
    pub consensus_reached: bool,
}

/// Request from frontend to start a discussion.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDiscussionRequest {
    pub topic: String,
    pub workflow: String,
    pub custom_roles: Option<Vec<String>>,
    pub max_rounds: Option<usize>,
}

/// Request to continue with a follow-up question.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueDiscussionRequest {
    pub session_id: usize,
    pub message: String,
}

/// Available workflows list item.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_roles: Vec<String>,
    pub steps: Vec<String>,
    /// `"planned"` (sequential), `"swarm"` (planner-driven), or
    /// `"manager_led"` (interactive: manager role reads topic +
    /// pauses to ask the user via `chat:need_decision`).
    pub kind: String,
    /// Runtime dispatch tag. `"planned"` / `"swarm"` mirror `kind`.
    /// `"manager_led"` is set when the workflow id starts with
    /// `manager_` (e.g. `manager_default`). Used by the chat panel
    /// to auto-switch to manager mode on selection.
    #[serde(default)]
    pub mode: String,
    /// Role that drives the swarm (empty for `planned` workflows).
    pub planner_role: String,
    /// Roles the swarm may pick as workers (empty when all roles are
    /// eligible).
    pub worker_roles: Vec<String>,
}
/// Role info for display in UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub category: String,
    /// Legacy single-model id (deprecated, kept for back-compat in UI).
    /// Equals the first entry of `model_chain` for display.
    pub default_model_tier: String,
    /// Priority-ordered model chain (highest priority first).
    /// The first entry is the primary; the rest are fallbacks tried
    /// in order when earlier models fail.
    pub model_chain: Vec<String>,
}

/// Model info for display in UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub max_tokens: u32,
    pub context_window: u32,
    pub supports_vision: bool,
    pub supports_thinking: bool,
}
/// Response for chat_get_role_config
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleConfigResponse {
    pub default_model: String,
    pub roles: Vec<RoleInfo>,
    pub workflows: Vec<WorkflowInfo>,
    pub models_path: String,
    pub roles_path: String,
}

/// Request from frontend to update a role's priority-ordered model chain.
///
/// `chain[0]` is the primary; the rest are fallbacks tried in order
/// when earlier models fail. An empty chain is rejected by the backend.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRoleModelChainRequest {
    pub role_id: String,
    pub chain: Vec<String>,
}

/// One step emitted by the swarm planner — names a worker role and a
/// concrete instruction for that role to execute. Workers don't see
/// the planner's full plan; they only see their own `instruction` plus
/// the conversation history up to that point.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmStepSpec {
    /// Identifier the planner assigned (e.g. "step-1", "design").
    pub id: String,
    /// Worker role id (must exist in `roles.yaml`).
    pub role: String,
    /// Plain-text instruction for the worker.
    pub instruction: String,
}

/// Streaming event for swarm-mode discussions. Tagged with `kind` so
/// the UI can route without parsing strings.
///
/// Kinds:
/// - `plan` — planner finished and emitted the step list. `steps` is
///   populated; the runner will iterate them next.
/// - `step` — a worker just finished a step. Mirrors the standard
///   `TurnPayload` plus `step_id` so the UI can group by plan node.
/// - `summary` — synthesis step finished. `content` is the final
///   human-readable summary.
/// - `file` — the runner wrote a file into the workspace
///   (`.swarm_<name>/`). `path` + `kind` ("plan" | "output" | "summary").
/// - `complete` — swarm finished successfully.
/// - `error` — planner or worker failed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmEvent {
    pub kind: String,
    /// Swarm id (`"quick_task"` by default). Echoed so the UI can
    /// route even if multiple swarms run back-to-back.
    pub swarm_id: String,
    /// Planner's emitted steps (only set for `plan`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<SwarmStepSpec>>,
    /// Worker turn (only set for `step`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnPayload>,
    /// Markdown content (only set for `summary` and `error`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// File path the runner wrote (only set for `file`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// File kind ("plan" | "output" | "summary") for `file` events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_kind: Option<String>,
}
/// One step in a multi-role workflow (used by the workflow editor UI).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepPayload {
    pub name: String,
    pub roles: Vec<String>,
}

/// Full workflow payload for the editor / save commands.
///
/// The frontend edits this and posts it back to `chat_save_workflow`.
/// Step `roles` mirror `WorkflowDef::roles` as a flat fallback when
/// `steps` is empty.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPayload {
    pub id: String,
    pub name: String,
    /// `"planned"` (sequential) or `"swarm"` (planner-driven).
    pub kind: String,
    /// Roles for legacy / quick workflows. Ignored when `steps` is
    /// non-empty.
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub steps: Vec<WorkflowStepPayload>,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
    #[serde(default)]
    pub planner_role: String,
    #[serde(default)]
    pub worker_roles: Vec<String>,
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,
    /// Manager-led only: role id that drives the workflow.
    #[serde(default)]
    pub manager_role: String,
    /// Manager-led only: strict candidate pool the manager picks from.
    #[serde(default)]
    pub initial_workers: Vec<String>,
    /// Manager-led only: hard cap on total manager turns.
    #[serde(default)]
    pub max_total_steps: u32,
    /// Manager-led only: hard cap on `chat:need_decision` count.
    #[serde(default)]
    pub max_user_decisions: u32,
}

fn default_max_rounds() -> usize {
    1
}
fn default_max_steps() -> usize {
    5
}

/// Result of a save / delete command. Lets the frontend re-render
/// without an extra fetch round-trip.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMutationResult {
    /// Updated workflow (post-save). `None` for delete.
    pub workflow: Option<WorkflowPayload>,
    /// `true` if the workflow was removed.
    pub deleted: bool,
}

// ─── Manager-led workflow ────────────────────────────────────────────
//
// Single user → manager role orchestrates a multi-role discussion,
// pausing to ask the user for decisions when the path isn't clear.
// Distinct from `planned` (sequential auto-runs) and `swarm` (planner
// upfront); the manager is interactive throughout.

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagerState {
    Idle,
    Planning,
    AwaitingDecision,
    AssigningWorker,
    WorkerRunning,
    Reflecting,
    Finalizing,
    Done,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ManagerAction {
    NeedDecision {
        /// Short label shown in the decision bubble header (e.g.
        /// "🎨 设计任务" / "🪲 Bug 排查" / "🧭 通用"). Lets the
        /// user see which heuristic the manager fired and whether
        /// to override it.
        branch_label: String,
        question: String,
        reason: String,
        options: Vec<DecisionOption>,
    },
    AssignWorker {
        worker_role: String,
        instruction: String,
    },
    Finalize { summary: String },
    Conclude,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub worker_role: Option<String>,
    #[serde(default)]
    pub estimated_cost_usd: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRequest {
    pub session_id: usize,
    /// Short label shown in the decision bubble header — same value
    /// as `ManagerAction::NeedDecision::branch_label`.
    pub branch_label: String,
    pub question: String,
    pub reason: String,
    pub options: Vec<DecisionOption>,
    pub context_summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDecision {
    pub session_id: usize,
    pub option_id: String,
    #[serde(default)]
    pub free_text: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerTurn {
    pub turn_number: usize,
    pub role_id: String,
    pub role_name: String,
    pub icon: String,
    pub content: String,
    pub action: Option<ManagerAction>,
    pub user_decision: Option<UserDecision>,
    pub weight: f32,
    pub pinned: bool,
    pub ts_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerSessionState {
    pub session_id: usize,
    pub state: ManagerState,
    pub topic: String,
    pub manager_role_id: String,
    pub available_roles: Vec<String>,
    pub max_total_steps: u32,
    pub max_user_decisions: u32,
    pub steps_taken: u32,
    pub decisions_taken: u32,
    pub turns: Vec<ManagerTurn>,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub summary: Option<String>,
}

/// Streaming status payload for manager-led workflows. Emitted via
/// `chat:manager_status` whenever the manager transitions state
/// (planning → awaiting decision → worker running → reflecting →
/// finalizing → done). The chat panel renders it as a compact
/// "📊 状态" panel — Chinese labels, no jargon.
///
/// All values are derived from `ManagerSessionState` at the moment
/// of emission; we don't store this struct separately. Token /
/// transcript byte counts are estimates (chars / 3) — fine for UI,
/// not for billing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerStatus {
    pub session_id: usize,
    pub state: ManagerState,
    /// Phase label in Chinese — "规划", "等待决策", "派单",
    /// "Worker 运行中", "反思", "收尾", "完成", "失败".
    pub phase_label: String,
    pub manager_role_id: String,
    pub manager_role_name: String,
    pub manager_icon: String,
    /// First model in the manager's chain (primary). Empty if no
    /// model is configured (stub mode + no API key).
    pub current_model: String,
    /// Full priority-ordered chain. Empty in stub mode.
    pub model_chain: Vec<String>,
    /// `true` when no LLM call was made (keyword heuristic) or when
    /// the manager role's primary model has no API key.
    pub is_stub_mode: bool,
    /// Roles the manager may pick as workers. Empty = fall back to
    /// all available roles.
    pub available_workers: Vec<String>,
    pub steps_taken: u32,
    pub max_total_steps: u32,
    pub decisions_taken: u32,
    pub max_user_decisions: u32,
    /// Estimated total transcript bytes (all turns summed).
    pub transcript_bytes: u32,
    /// Byte length of the current / final summary.
    pub summary_bytes: u32,
    /// Rough token estimate (transcript_bytes / 3). 4 chars / token
    /// is the rough English rule; Chinese averages 1.5 char / token
    /// so we split the difference at 3.
    pub tokens_estimated: u32,
    /// Total elapsed time since session start, in milliseconds.
    pub elapsed_ms: u64,
    /// Timestamp of the most recent turn. 0 if no turns yet.
    pub last_step_at_ms: u64,
}


// ─── HIL (Human-In-Loop) Blackboard session ─────────────────────
//
// Tauri-side projection of `latte_agent_core::session::SessionRecord`.
// The editor frontend edits messages in this shape and posts them back
// through `chat_hil_edit_message`. The backend re-uses the agent-core
// `SessionManager` for atomic persistence (write-tmp + rename) so the
// on-disk JSON is always the source of truth.

/// One message in a role's history. Mirrors
/// `latte_ai::models::Message` but with camelCase serde so the JSON
/// is human-editable (the spec calls this out for "外科手术式
/// 回滚"). `index` is the position in the role's history; the editor
/// uses it as the row id for in-place edits.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilMessage {
    pub index: usize,
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

/// One role's full history. The frontend renders this as an
/// editable transcript (each row can be edited in place or deleted).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilRoleHistory {
    pub role_id: String,
    pub messages: Vec<HilMessage>,
}

/// Full HIL session snapshot — what `chat_hil_get_state` returns and
/// what the editor renders. Mirrors the JSON the `SessionManager`
/// writes under `.latte/sessions/<id>.json` so an operator can
/// hand-edit the file while the session is paused.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilSessionState {
    pub session_id: String,
    pub task_id: String,
    /// "created" | "running" | "paused" | "resumed" | "done" | "failed"
    pub state: String,
    pub plan_md: String,
    pub active_checkpoint_id: u32,
    pub current_turn: u32,
    pub roles: Vec<HilRoleHistory>,
    pub paused_at: Option<String>,
    pub pause_reason: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub session_json_path: String,
    pub worktree_root: String,
}

/// Request to start a new HIL session. `cwd` defaults to the active
/// workspace; if the cwd is not a git repo the backend returns a
/// friendly error. `roles` defaults to `["manager"]` when empty.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilStartRequest {
    pub task_id: String,
    pub initial_prompt: String,
    #[serde(default)]
    pub roles: Vec<String>,
    pub cwd: Option<String>,
}

/// Request to append a new message to a role's history (the regular
/// "send" path). The backend stamps it with `now` and persists.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilSendRequest {
    pub task_id: String,
    pub role_id: String,
    pub content: String,
    /// `true` → message attributed to the human user (default).
    /// `false` → attributed to assistant, for pre-populating a role
    /// with example turns.
    #[serde(default = "hil_default_true")]
    pub is_user: bool,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilEditRequest {
    pub task_id: String,
    pub role_id: String,
    pub message_index: usize,
    pub action: String,
    pub new_content: Option<String>,
    pub cwd: Option<String>,
}

/// Request to inject a message targeted at one role from outside the
/// REPL. The CLI equivalent is
/// `latte-agent inject --role <id> --message <m>`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilInjectRequest {
    pub task_id: String,
    pub role_id: String,
    pub message: String,
    pub cwd: Option<String>,
}

/// Pause / resume / abort share the same payload — only `action`
/// differs. The frontend posts one of these and the backend routes on
/// `action`. Optional fields are only consumed by the matching
/// handler.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilTransitionRequest {
    pub task_id: String,
    pub action: String,
    pub reason: Option<String>,
    pub role_id: Option<String>,
    pub message: Option<String>,
    pub cwd: Option<String>,
}

/// Resume + send in one call. The editor uses this when the user
/// presses "继续" with a typed message; it's equivalent to
/// `latte-agent resume --task-id X --message "..."`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HilContinueRequest {
    pub task_id: String,
    pub role_id: String,
    pub content: String,
    pub cwd: Option<String>,
}

fn hil_default_true() -> bool {
    true
}
// ─── ChatController Tauri adapter types ────────────────────────────
//
// Serializable versions of `latte_agent_core::controller::*` types
// that the Tauri IPC layer can deserialize from the frontend, plus
// the event payload emitted via `chat:controller_event`.

/// Request to spawn a new ChatController session.
/// The Tauri command will construct the full `ControllerConfig` from
/// these serializable fields plus backend-built AgentConfig/ModelResolver.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerSpawnRequest {
    /// Session id for this controller. Must be unique.
    pub session_id: String,
    /// `Some(id)` → multi-role HIL mode on existing worktree.
    /// `None` → single-role mode (no SessionManager).
    pub task_id: Option<String>,
    /// Role IDs. `len() == 1` → single-role, `> 1` → multi-role HIL.
    pub roles: Vec<String>,
    /// Initial prompt (used only when creating a fresh HIL session).
    pub initial_prompt: Option<String>,
    /// Maximum rounds (multi-role mode). Default 10.
    #[serde(default = "ctrl_default_max_rounds")]
    pub max_rounds: u32,
    /// Session token budget for Supervisor. 0 = disabled.
    #[serde(default)]
    pub session_token_budget: u32,
    /// Pinned model id (overrides tier-based resolution).
    pub primary_model_id: Option<String>,
    /// Initial model tier override.
    pub initial_tier: Option<String>,
    /// Current working directory (for worktree resolution).
    pub cwd: Option<std::path::PathBuf>,
}

fn ctrl_default_max_rounds() -> u32 {
    10
}

/// Kind tag for the `ControllerEventPayload` discriminator.
/// Maps one-to-one with `ChatEvent` variants.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ControllerEventKind {
    RoleTurn,
    Status,
    Prompt,
    Paused,
    Resumed,
    RoundStarted,
    RoundEnded,
    Done,
    Error,
    RoleList,
    ContextCleared,
    SessionInfo,
    ToolUse,
    ToolResult,
    ToolError,
    RoleStarted,
    RoleFinished,
    DelegateStarted,
    DelegateFinished,
}

impl From<&latte_agent_core::controller::ChatEvent> for ControllerEventKind {
    fn from(event: &latte_agent_core::controller::ChatEvent) -> Self {
        use latte_agent_core::controller::ChatEvent;
        match event {
            ChatEvent::RoleTurn { .. } => Self::RoleTurn,
            ChatEvent::Status { .. } => Self::Status,
            ChatEvent::Prompt { .. } => Self::Prompt,
            ChatEvent::Paused { .. } => Self::Paused,
            ChatEvent::Resumed => Self::Resumed,
            ChatEvent::RoundStarted { .. } => Self::RoundStarted,
            ChatEvent::RoundEnded { .. } => Self::RoundEnded,
            ChatEvent::Done => Self::Done,
            ChatEvent::Error { .. } => Self::Error,
            ChatEvent::ToolUse { .. } => Self::ToolUse,
            ChatEvent::ToolResult { .. } => Self::ToolResult,
            ChatEvent::ToolError { .. } => Self::ToolError,
            ChatEvent::RoleList { .. } => Self::RoleList,
            ChatEvent::ContextCleared => Self::ContextCleared,
            ChatEvent::SessionInfo { .. } => Self::SessionInfo,
            ChatEvent::RoleStarted { .. } => Self::RoleStarted,
            ChatEvent::RoleFinished { .. } => Self::RoleFinished,
            ChatEvent::DelegateStarted { .. } => Self::DelegateStarted,
            ChatEvent::DelegateFinished { .. } => Self::DelegateFinished,
        }
    }
}
/// NOTE: Instead of `#[serde(flatten)]` over the enum (which produces a
/// nested `{Error: {message}}` shape), we implement a custom serializer
/// that extracts the variant's fields into the parent object.
#[derive(Clone, Debug)]
pub struct ControllerEventPayload {
    /// Session id this event belongs to.
    pub session_id: String,
    /// Discriminator tag for lightweight frontend routing.
    pub kind: ControllerEventKind,
    /// The inner event data (fields depend on kind).
    pub event: latte_agent_core::controller::ChatEvent,
}

impl serde::Serialize for ControllerEventPayload {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        // session_id (camelCase)
        map.serialize_entry("sessionId", &self.session_id)?;
        // kind (camelCase via ControllerEventKind's Serialize)
        let kind_str = match self.kind {
            ControllerEventKind::RoleTurn => "roleTurn",
            ControllerEventKind::Status => "status",
            ControllerEventKind::Prompt => "prompt",
            ControllerEventKind::Paused => "paused",
            ControllerEventKind::Resumed => "resumed",
            ControllerEventKind::RoundStarted => "roundStarted",
            ControllerEventKind::RoundEnded => "roundEnded",
            ControllerEventKind::Done => "done",
            ControllerEventKind::Error => "error",
            ControllerEventKind::RoleList => "roleList",
            ControllerEventKind::ContextCleared => "contextCleared",
            ControllerEventKind::SessionInfo => "sessionInfo",
            ControllerEventKind::ToolUse => "toolUse",
            ControllerEventKind::ToolResult => "toolResult",
            ControllerEventKind::ToolError => "toolError",
            ControllerEventKind::RoleStarted => "roleStarted",
            ControllerEventKind::RoleFinished => "roleFinished",
            ControllerEventKind::DelegateStarted => "delegateStarted",
            ControllerEventKind::DelegateFinished => "delegateFinished",
        };
        map.serialize_entry("kind", kind_str)?;
        // Flatten the variant fields
        use latte_agent_core::controller::ChatEvent;
        match &self.event {
            ChatEvent::RoleTurn { role_id, content, is_complete } => {
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("content", content)?;
                map.serialize_entry("isComplete", is_complete)?;
            }
            ChatEvent::Status { message } => {
                map.serialize_entry("message", message)?;
            }
            ChatEvent::Prompt { icon, role_id, model_id } => {
                map.serialize_entry("icon", icon)?;
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("modelId", model_id)?;
            }
            ChatEvent::Paused { reason } => {
                map.serialize_entry("reason", reason)?;
            }
            ChatEvent::Resumed => {}
            ChatEvent::RoundStarted { round } => {
                map.serialize_entry("round", round)?;
            }
            ChatEvent::RoundEnded { round } => {
                map.serialize_entry("round", round)?;
            }
            ChatEvent::Done => {}
            ChatEvent::Error { message } => {
                map.serialize_entry("message", message)?;
            }
            ChatEvent::RoleList { roles } => {
                map.serialize_entry("roles", roles)?;
            }
            ChatEvent::ContextCleared => {}
            ChatEvent::SessionInfo { task_id, state, turn, roles } => {
                map.serialize_entry("taskId", task_id)?;
                map.serialize_entry("state", state)?;
                map.serialize_entry("turn", turn)?;
                map.serialize_entry("roles", roles)?;
            }
            ChatEvent::ToolUse { role_id, tool_name, args } => {
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("toolName", tool_name)?;
                map.serialize_entry("args", args)?;
            }
            ChatEvent::ToolResult { role_id, tool_name, result } => {
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("toolName", tool_name)?;
                map.serialize_entry("result", result)?;
            }
            ChatEvent::ToolError { role_id, tool_name, error } => {
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("toolName", tool_name)?;
                map.serialize_entry("error", error)?;
            }
            ChatEvent::RoleStarted { role_id, detail } => {
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("detail", detail)?;
            }
            ChatEvent::RoleFinished { role_id, detail } => {
                map.serialize_entry("roleId", role_id)?;
                map.serialize_entry("detail", detail)?;
            }
            ChatEvent::DelegateStarted { from_role, to_role, task, sub_id } => {
                map.serialize_entry("fromRole", from_role)?;
                map.serialize_entry("toRole", to_role)?;
                map.serialize_entry("task", task)?;
                map.serialize_entry("subId", sub_id)?;
            }
            ChatEvent::DelegateFinished { from_role, to_role, status, summary, sub_id } => {
                map.serialize_entry("fromRole", from_role)?;
                map.serialize_entry("toRole", to_role)?;
                map.serialize_entry("status", status)?;
                map.serialize_entry("summary", summary)?;
                map.serialize_entry("subId", sub_id)?;
            }
        }
        map.end()
    }
}


