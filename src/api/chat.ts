import { invoke } from "@tauri-apps/api/core";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxTokens: number;
  contextWindow: number;
  supportsVision: boolean;
  supportsThinking: boolean;
}

export interface RoleConfigResponse {
  defaultModel: string;
  roles: RoleInfo[];
  workflows: WorkflowInfo[];
  modelsPath: string;
  rolesPath: string;
}

export interface RoleInfo {
  id: string;
  name: string;
  icon: string;
  category: string;
  /** Back-compat: equals `modelChain[0]`. Used by the old single-dropdown UI. */
  defaultModelTier: string;
  /** Priority-ordered model chain (highest priority first). `chain[0]` is the primary. */
  modelChain: string[];
}

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  defaultRoles: string[];
  steps: string[];
  /** `"planned"` (sequential), `"swarm"` (planner-driven), or
   *   `"manager_led"` (interactive: manager role reads topic +
   *   pauses to ask the user via `chat:need_decision`). */
  kind: "planned" | "swarm";
  /** Runtime dispatch tag. Same as `kind` unless the workflow id
   *   starts with `manager_` (in which case this is `"manager_led"`).
   *   The chat panel uses `mode` to auto-switch to manager mode on
   *   selection. */
  mode: string;
  /** Role that drives the swarm (empty for planned workflows). */
  plannerRole: string;
  /** Roles the swarm may pick as workers (empty when all roles are eligible). */
  workerRoles: string[];
}

export interface StartDiscussionRequest {
  topic: string;
  workflow: string;
  customRoles: string[] | null;
  maxRounds: number | null;
}

export interface ContinueDiscussionRequest {
  sessionId: number;
  message: string;
}

/**
 * Request to update a role's priority-ordered model chain.
 * `chain[0]` is the primary; the rest are fallbacks tried in order
 * when earlier models fail. Empty chains are rejected by the backend.
 */
export interface SetRoleModelChainRequest {
  roleId: string;
  chain: string[];
}

/**
 * List available models from ~/.latte/models.yaml
 */
export async function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("chat_list_models");
}

/**
 * Get role configuration from ~/.latte-code-editor/roles.yaml
 */
export async function getRoleConfig(): Promise<RoleConfigResponse> {
  return invoke<RoleConfigResponse>("chat_get_role_config");
}

/**
 * Set model for a specific role. Convenience wrapper around
 * `setRoleModelChain([modelId])` — kept for callers that only need
 * a single primary model.
 */
export async function setRoleModel(
  roleId: string,
  modelId: string
): Promise<void> {
  return invoke("chat_set_role_model", { roleId, modelId });
}

/**
 * Set the priority-ordered model chain for a specific role.
 *
 * `chain[0]` is the primary; the rest are fallbacks tried in order
 * when earlier models fail (rate-limit, 5xx, transient network).
 * Empty chains are rejected by the backend.
 * Returns the persisted (deduplicated) chain.
 */
export async function setRoleModelChain(
  roleId: string,
  chain: string[]
): Promise<string[]> {
  return invoke<string[]>("chat_set_role_model_chain", {
    request: { roleId, chain } as SetRoleModelChainRequest,
  });
}

/**
 * Set default model
 */
export async function setDefaultModel(modelId: string): Promise<void> {
  return invoke("chat_set_default_model", { modelId });
}

/**
 * Open config file in editor
 */
export async function openConfig(configType: "models" | "roles"): Promise<string> {
  return invoke<string>("chat_open_config", { configType });
}

/**
 * List available workflows
 */
export async function listWorkflows(): Promise<WorkflowInfo[]> {
  return invoke<WorkflowInfo[]>("chat_list_workflows");
}

/**
 * List available roles
 */
export async function listRoles(): Promise<RoleInfo[]> {
  return invoke<RoleInfo[]>("chat_list_roles");
}

/**
 * Start a new discussion
 */
export async function startDiscussion(
  request: StartDiscussionRequest
): Promise<number> {
  return invoke<number>("chat_start_discussion", { request });
}



/**
 * Request to launch a planner-driven swarm. `name` matches a
 * `roles.yaml` workflow id with `kind: swarm` (e.g. `quick_task`).
 * `workspace` is optional — defaults to the env-var-pinned or cwd
 * workspace chosen by the runner.
 */
export interface StartSwarmRequest {
  topic: string;
  /** Defaults to `"quick_task"`. */
  name?: string;
  workspace?: string | null;
}

/**
 * One step emitted by the swarm planner. Workers receive their
 * `instruction` as part of the prompt, so the UI can show it as the
 * step header.
 */
export interface SwarmStepSpec {
  id: string;
  role: string;
  instruction: string;
}

/**
 * Streaming event for swarm-mode discussions. Tagged with `kind` so
 * the UI can route without parsing strings:
 * - `plan` — planner emitted `steps`; runner will iterate them.
 * - `step` — a worker just finished; `turn` mirrors the standard
 *   `chat:turn` payload.
 * - `summary` — synthesis finished; `content` is the final markdown.
 * - `file` — runner wrote `path` (kind `"plan"` / `"output"` /
 *   `"summary"`).
 * - `complete` — swarm finished successfully.
 * - `error` — planner or worker failed; `content` is the message.
 */
export interface SwarmEvent {
  kind: "plan" | "step" | "summary" | "file" | "complete" | "error";
  /** Echoes the swarm id so the UI can route when multiple swarms run. */
  swarmId: string;
  /** Only set for `plan`. */
  steps?: SwarmStepSpec[];
  /** Only set for `step` — mirrors `chat:turn`. */
  turn?: {
    agent: string;
    roleId: string;
    icon: string;
    response: string;
    round: number;
    stepId: string;
    turnNumber: number;
  };
  /** Only set for `summary` and `error`. */
  content?: string;
  /** Only set for `file`. */
  path?: string;
  /** Only set for `file`. */
  fileKind?: "plan" | "output" | "summary";
}

/**
 * Start a planner-driven swarm. Returns the session id immediately;
 * progress streams via the `chat:swarm_event` Tauri event.
 */
export async function startSwarm(
  request: StartSwarmRequest
): Promise<number> {
  return invoke<number>("chat_start_swarm", { request });
}

// ─── Manager-led workflow ────────────────────────────────────────────
//
// Interactive flow where a manager role reads the topic, decides what
// to do next, and pauses for user input via option buttons. Backend
// streams `chat:turn` for manager / worker bubbles and
// `chat:need_decision` for the option panel.

/**
 * One option offered by the manager when it pauses to ask the
 * user. `workerRole` is `null` for "conclude" / "skip" options
 * that don't dispatch a worker.
 */
export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  workerRole: string | null;
  /** Rough USD cost so the user can pick with eyes open. */
  estimatedCostUsd: number;
}

/**
 * Event payload the backend emits when the manager needs the user
 * to pick. The frontend renders these as option-button panels
 * under the most recent manager bubble.
 */
export interface DecisionRequest {
  sessionId: number;
  /** Short branch label so the user knows which heuristic fired
   *  (e.g. "🎨 设计任务" / "🪲 Bug 排查" / "🧭 通用" / "🔁 反射"). */
  branchLabel: string;
  question: string;
  reason: string;
  options: DecisionOption[];
  contextSummary: string;
}

/** User's choice posted back to `chat_user_decision`. */
export interface UserDecision {
  sessionId: number;
  optionId: string;
  freeText?: string | null;
}

/** One turn in the manager-led conversation (manager / worker / user). */
export interface ManagerTurn {
  turnNumber: number;
  roleId: string;
  roleName: string;
  icon: string;
  content: string;
  action?: ManagerAction | null;
  userDecision?: UserDecision | null;
  weight: number;
  pinned: boolean;
  tsMs: number;
}

/** Discriminated union matching the backend `ManagerAction`. */
export type ManagerAction =
  | {
      kind: "needDecision";
      question: string;
      reason: string;
      options: DecisionOption[];
    }
  | { kind: "assignWorker"; workerRole: string; instruction: string }
  | { kind: "finalize"; summary: string }
  | { kind: "conclude" };

/** Full session snapshot. Persisted to state.json on every transition. */
export interface ManagerSessionState {
  sessionId: number;
  state:
    | "idle"
    | "planning"
    | "awaitingDecision"
    | "assigningWorker"
    | "workerRunning"
    | "reflecting"
    | "finalizing"
    | "done"
    | "failed";
  topic: string;
  managerRoleId: string;
  availableRoles: string[];
  maxTotalSteps: number;
  maxUserDecisions: number;
  stepsTaken: number;
  decisionsTaken: number;
  turns: ManagerTurn[];
  startedAtMs: number;
  finishedAtMs: number | null;
  summary: string | null;
}

/** Start a manager-led session. Returns the new session_id. */
export async function startManagerSession(
  topic: string,
  workflowId: string | null,
  workspace?: string | null
): Promise<number> {
  return invoke<number>("chat_start_manager_session", {
    topic,
    workflowId: workflowId ?? null,
    workspace: workspace ?? null,
  });
}

/** Post a user's choice (or free-text only) to the manager session. */
export async function submitUserDecision(
  decision: UserDecision
): Promise<void> {
  return invoke("chat_user_decision", { decision });
}

/** Push the session forward without picking an option. */
export async function submitUserContinue(
  sessionId: number,
  message?: string | null
): Promise<void> {
  return invoke("chat_user_continue", { sessionId, message: message ?? null });
}

/** Snapshot a manager session. `null` if not found in this process. */
export async function getManagerState(
  sessionId: number
): Promise<ManagerSessionState | null> {
  return invoke<ManagerSessionState | null>("chat_get_manager_state", {
    sessionId,
  });
}

/** Force-stop a manager session with a reason recorded in state. */
export async function abortManagerSession(
  sessionId: number,
  reason: string
): Promise<void> {
  return invoke("chat_abort_manager_session", { sessionId, reason });
}

/**
 * Streaming status payload from `chat:manager_status`. Emitted on
 * every manager state transition. The chat panel renders this as a
 * compact Chinese-labeled status card so the user can see what
 * model is being used, how many steps / decisions remain, how many
 * tokens the transcript has consumed, and whether the manager is
 * running in stub mode (keyword heuristic) or live LLM mode.
 *
 * All byte / token counts are estimates — fine for the UI, not for
 * billing.
 */
export interface ManagerStatus {
  sessionId: number;
  state:
    | "idle"
    | "planning"
    | "awaitingDecision"
    | "assigningWorker"
    | "workerRunning"
    | "reflecting"
    | "finalizing"
    | "done"
    | "failed";
  /** Chinese phase label — "规划中", "等待你的决策", ... */
  phaseLabel: string;
  managerRoleId: string;
  managerRoleName: string;
  managerIcon: string;
  /** First model in the manager's chain (primary). Empty in stub mode. */
  currentModel: string;
  modelChain: string[];
  isStubMode: boolean;
  availableWorkers: string[];
  stepsTaken: number;
  maxTotalSteps: number;
  decisionsTaken: number;
  maxUserDecisions: number;
  transcriptBytes: number;
  summaryBytes: number;
  tokensEstimated: number;
  elapsedMs: number;
  lastStepAtMs: number;
}
/**
 * Cancel discussion
 */
export async function cancelDiscussion(sessionId: number): Promise<void> {
  return invoke("chat_cancel", { sessionId });
}

// ─── Workflow editor ─────────────────────────────────────────────
//
// Workflow persistence lives behind these Tauri commands. The chat
// panel edits `WorkflowPayload` objects and posts them to
// `saveWorkflow`; the backend validates and writes back the
// canonical payload so the editor reflects the saved state.

/**
 * One step in a multi-role workflow. Editors send these in order;
 * the runner speaks each step's `roles` sequentially.
 */
export interface WorkflowStep {
  /** Chinese-friendly label shown in the editor (`"需求与验收"` etc.). */
  name: string;
  /** Role ids that speak in this step, in order. */
  roles: string[];
}

/**
 * Full editable workflow payload. `id` is the stable map key used in
 * `roles.yaml`. `kind` is `"planned"` (sequential) or `"swarm"`
 * (planner-driven). When `steps` is non-empty the runner ignores
 * `roles` and runs `steps` instead.
 */
export interface WorkflowPayload {
  id: string;
  name: string;
  kind: "planned" | "swarm" | "manager_led";
  /** Flat fallback role list — used when `steps` is empty. */
  roles: string[];
  steps: WorkflowStep[];
  maxRounds: number;
  /** Swarm-only: role that drives the planner. Empty when unset. */
  plannerRole: string;
  /** Swarm-only: roles the planner may pick. Empty = all roles. */
  workerRoles: string[];
  /** Swarm-only: cap on planner-emitted worker steps. */
  maxSteps: number;
  /** Manager-led: which role acts as the manager (defaults to "manager"). */
  managerRole: string;
  /** Manager-led: roles offered to the manager as initial candidates. */
  initialWorkers: string[];
  /** Manager-led: hard cap on total turns. */
  maxTotalSteps: number;
  /** Manager-led: cap on user-driven decision rounds. */
  maxUserDecisions: number;
}
/** Result of a save / delete command. */
export interface WorkflowMutationResult {
  workflow: WorkflowPayload | null;
  deleted: boolean;
}

/** Upsert one workflow. */
export async function saveWorkflow(
  payload: WorkflowPayload,
): Promise<WorkflowMutationResult> {
  return invoke<WorkflowMutationResult>("chat_save_workflow", { payload });
}

/** Delete a workflow by id. Refuses built-in presets. */
export async function deleteWorkflow(
  id: string,
): Promise<WorkflowMutationResult> {
  return invoke<WorkflowMutationResult>("chat_delete_workflow", { id });
}
/**
 * Fetch the full editable payload for one workflow. The chat panel
 * dropdown uses the slimmer `getRoleConfig` summary; the editor
 * needs the per-step breakdown this returns.
 */
export async function getWorkflowFull(id: string): Promise<WorkflowPayload> {
  return invoke<WorkflowPayload>("chat_get_workflow_full", { id });
}

/** List every workflow's full editable payload. */
export async function listWorkflowsFull(): Promise<WorkflowPayload[]> {
  return invoke<WorkflowPayload[]>("chat_list_workflows_full");
}

/**
 * Wipe the user `roles.yaml` and rebuild it from the current
 * defaults — gets the Chinese-named roles and `quick_task` swarm
 * preset to existing users whose `roles.yaml` predates the
 * Chinese-name migration. Returns the fresh config so the caller
 * can `setState(config)` and skip a follow-up `getRoleConfig`.
 */
export async function resetRolesToDefaults(): Promise<RoleConfigResponse> {
  return invoke<RoleConfigResponse>("chat_reset_roles_to_defaults");
}

// ─── HIL (Human-In-Loop) Blackboard session ─────────────────────
//
// Tauri bindings for the editable, pausable chat session backed by
// `latte-rs-agents/latte-agent-core::session::SessionManager`. The
// backend stores every change atomically to
// `<worktree>/.latte/sessions/<id>.json`; the editor reads that
// file (via `chat_hil_get_state`) and edits messages in place.
// The "可修改聊天内容继续" requirement maps to
// `editHilMessage` + `continueHilSession`.

/** One message in a role's history. Mirrors
 *  `latte_agent_core::session::RoleHistory.messages` projected to
 *  the editor. `index` is the position in the role's history
 *  (0-based) — the editor uses it as the row id for in-place
 *  edits. */
export interface HilMessage {
  index: number;
  role: "user" | "assistant" | "system" | string;
  content: string;
  timestamp?: string | null;
}

/** One role's full history. The editor renders this as an
 *  editable transcript. */
export interface HilRoleHistory {
  roleId: string;
  messages: HilMessage[];
}

/** Full HIL session snapshot — what `chat_hil_get_state` returns
 *  and what the editor renders. Mirrors the JSON written by
 *  `SessionManager` to `.latte/sessions/<id>.json`. */
export interface HilSessionState {
  sessionId: string;
  taskId: string;
  /** "created" | "running" | "paused" | "resumed" | "done" | "failed". */
  state: string;
  planMd: string;
  activeCheckpointId: number;
  currentTurn: number;
  roles: HilRoleHistory[];
  pausedAt?: string | null;
  pauseReason?: string | null;
  startedAt: string;
  updatedAt: string;
  /** Absolute path to the on-disk JSON; the editor renders it as
   *  a "在编辑器中打开" affordance. */
  sessionJsonPath: string;
  worktreeRoot: string;
}

/** Compact summary used by the "open existing" dropdown. */
export interface HilSessionSummary {
  taskId: string;
  sessionId: string;
  state: string;
  updatedAt: string;
  pausedAt?: string | null;
  worktreeRoot: string;
}

/** Start a new HIL session. Creates the worktree, writes
 *  `plan.md`, instantiates a `SessionManager`, and returns the
 *  initial snapshot. */
export async function startHilSession(request: {
  taskId: string;
  initialPrompt: string;
  roles?: string[];
  cwd?: string | null;
}): Promise<HilSessionState> {
  return invoke<HilSessionState>("chat_hil_start", { request });
}

/** Append a message to a role's history. */
export async function sendHilMessage(request: {
  taskId: string;
  roleId: string;
  content: string;
  isUser?: boolean;
  cwd?: string | null;
}): Promise<HilSessionState> {
  return invoke<HilSessionState>("chat_hil_send", { request });
}

/** Edit or delete one message in a role's history. The
 *  "可修改聊天内容继续" affordance — while the session is
 *  paused, the user can fix any message, then press 继续. */
export async function editHilMessage(request: {
  taskId: string;
  roleId: string;
  messageIndex: number;
  /** "edit" | "delete". */
  action: "edit" | "delete";
  newContent?: string | null;
  cwd?: string | null;
}): Promise<HilSessionState> {
  return invoke<HilSessionState>("chat_hil_edit_message", { request });
}

/** Inject a message targeted at one role from outside the REPL. */
export async function injectHilMessage(request: {
  taskId: string;
  roleId: string;
  message: string;
  cwd?: string | null;
}): Promise<HilSessionState> {
  return invoke<HilSessionState>("chat_hil_inject", { request });
}

/** Resume + send in one call. Empty content just resumes. */
export async function continueHilSession(request: {
  taskId: string;
  roleId: string;
  content: string;
  cwd?: string | null;
}): Promise<HilSessionState> {
  return invoke<HilSessionState>("chat_hil_continue", { request });
}

/** Pause / resume / abort. `action` is
 *  `"pause" | "resume" | "abort"`. For `pause` `reason` is
 *  optional; for `resume` `roleId` + `message` are optional
 *  (inline injection). */
export async function transitionHilSession(request: {
  taskId: string;
 action: "pause" | "resume" | "abort";
  reason?: string | null;
  roleId?: string | null;
  message?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
}): Promise<HilSessionState> {
  return invoke<HilSessionState>("chat_hil_transition", { request });
}

/** Fetch a session's full state. Returns `null` if no JSON
 *  exists for the task_id. */
export async function getHilState(
  taskId: string,
  cwd?: string | null,
): Promise<HilSessionState | null> {
  return invoke<HilSessionState | null>("chat_hil_get_state", {
    taskId,
    cwd: cwd ?? null,
  });
}

/** List all on-disk HIL sessions. */
export async function listHilSessions(
  cwd?: string | null,
): Promise<HilSessionSummary[]> {
  return invoke<HilSessionSummary[]>("chat_hil_list_sessions", {
    cwd: cwd ?? null,
  });
}

// ─── Single-role chat stream (latte-agent chat CLI in HTML) ─────────

/** One chat message in the history sent from the frontend. */
export interface ChatHistoryEntry {
  role: string;
  content: string;
}

/** Payload for the `chat_stream` command. */
export interface StreamRequest {
  roleId: string;
  content: string;
  /** Previous conversation turns. */
  history: ChatHistoryEntry[];
}

/** Response from a single-role chat turn. */
export interface StreamReply {
  role_id: string;
  content: string;
}

/** Send one chat turn and return the model's full response. */
export async function chatStream(
  request: StreamRequest
): Promise<StreamReply> {
  return invoke<StreamReply>("chat_stream", { request });
}

// ─── ChatController (single-role / multi-role event-driven) ────────
//
// Lightweight API that wraps the Tauri `chat_controller_*` commands.
// Events stream via `chat:controller_event` — subscribe with `listen`.
// Each session is identified by a client-chosen `sessionId` string.
// Unlike manager/swarm modes, this does NOT use numeric session IDs
// from the backend — the caller picks a unique string.

/** Request to spawn a ChatController session. */
export interface ControllerSpawnRequest {
  sessionId: string;
  taskId?: string | null;
  roles: string[];
  initialPrompt?: string | null;
  maxRounds?: number;
  sessionTokenBudget?: number;
  primaryModelId?: string | null;
  initialTier?: string | null;
  cwd?: string | null;
}

/** Kind tag discriminator for ControllerEventPayload. */
export type ControllerEventKind =
  | "roleTurn"
  | "status"
  | "prompt"
  | "paused"
  | "resumed"
  | "roundStarted"
  | "roundEnded"
  | "done"
  | "error"
  | "roleList"
  | "contextCleared"
  | "sessionInfo"
  | "toolUse"
  | "toolResult";

/** A single event from the ChatController driver. */
export interface ControllerEventPayload {
  sessionId: string;
  kind: ControllerEventKind;
  // The raw ChatEvent JSON — fields depend on `kind`.
  // Frontend should switch on `kind` to access typed fields.
  [key: string]: unknown;
}

/** Spawn a new ChatController session. */
export async function spawnController(
  request: ControllerSpawnRequest
): Promise<void> {
  return invoke("chat_controller_spawn", { request });
}

/** Submit text input to an active controller session. */
export async function submitControllerInput(
  sessionId: string,
  text: string
): Promise<void> {
  return invoke("chat_controller_submit", { sessionId, text });
}

/** Pause an active controller session. */
export async function pauseController(sessionId: string): Promise<void> {
  return invoke("chat_controller_pause", { sessionId });
}

/** Resume a paused controller session. */
export async function resumeController(sessionId: string): Promise<void> {
  return invoke("chat_controller_resume", { sessionId });
}

/** Abort an active controller session. */
export async function abortController(sessionId: string): Promise<void> {
  return invoke("chat_controller_abort", { sessionId });
}

// ─── Unified SessionStore (persistent sessions) ─────────────────────
//
// Manages all chat sessions in `~/.latte/chat-sessions/*.json`.
// Provides listing, viewing, editing, and deleting.
// Sessions are auto-persisted when using `spawnController`.

export interface StoredMessage {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system_event" | "round_start" | "round_end" | "paused" | "resumed";
  content?: string;
  role_id?: string;
  tool_name?: string;
  args?: string;
  result?: string;
  event_type?: string;
  message?: string;
  round?: number;
  reason?: string;
  timestamp: string;
  tokens?: number;
}

export interface SessionSummary {
  sessionId: string;
  state: string;
  chatType: string;
  roleIds: string[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface StoredSession {
  sessionId: string;
  state: string;
  chatType: string;
  roleIds: string[];
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
}

/** List all persisted chat sessions (summary only, no messages). */
export async function listSessions(): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("chat_session_list");
}

/** Get a single session by id (includes full message list). */
export async function getSession(sessionId: string): Promise<StoredSession> {
  return invoke<StoredSession>("chat_session_get", { sessionId });
}

/** Delete a session by id. */
export async function deleteSession(sessionId: string): Promise<void> {
  return invoke("chat_session_delete", { sessionId });
}

/** Edit a message in a session's history. Only user/assistant messages can be edited. */
export async function editSessionMessage(
  sessionId: string,
  index: number,
  newContent: string,
): Promise<void> {
  return invoke("chat_session_edit_message", { sessionId, index, newContent });
}