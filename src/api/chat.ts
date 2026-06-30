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
   *   `"manager_led"` (controller chat starts from the manager role). */
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

export interface ControllerRoleInfo {
  id: string;
  name: string;
  icon: string;
}

export type ChatEvent =
  | { RoleTurn: { role_id: string; content: string; is_complete: boolean } }
  | { Status: { message: string } }
  | { Prompt: { icon: string; role_id: string; model_id: string } }
  | { Paused: { reason: string } }
  | { Resumed: null }
  | { RoundStarted: { round: number } }
  | { RoundEnded: { round: number } }
  | { RoleStarted: { role_id: string; detail: string } }
  | { RoleFinished: { role_id: string; detail: string } }
  | { DelegateStarted: { from_role: string; to_role: string; task: string } }
  | { DelegateFinished: { from_role: string; to_role: string; status: string; summary: string } }
  | { Done: null }
  | { Error: { message: string } }
  | { RoleList: { roles: ControllerRoleInfo[] } }
  | { ContextCleared: null }
  | { SessionInfo: { task_id: string; state: string; turn: number; roles: ControllerRoleInfo[] } }
  | { ToolUse: { role_id: string; tool_name: string; args: string } }
  | { ToolResult: { role_id: string; tool_name: string; result: string } }
  | { ToolError: { role_id: string; tool_name: string; error: string } };

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
export type ChatConfigTarget =
  | "models"
  | "roles"
  | `workflow:${string}`
  | `role:${string}`;

export async function openConfig(configType: ChatConfigTarget): Promise<string> {
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