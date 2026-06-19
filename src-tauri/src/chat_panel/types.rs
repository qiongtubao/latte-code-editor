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
