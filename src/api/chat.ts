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
 * Continue discussion with follow-up
 */
export async function continueDiscussion(
  request: ContinueDiscussionRequest
): Promise<void> {
  return invoke("chat_continue", { request });
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
  workspace?: string | null
): Promise<number> {
  return invoke<number>("chat_start_manager_session", {
    topic,
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
  kind: "planned" | "swarm";
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