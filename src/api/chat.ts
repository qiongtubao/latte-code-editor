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
 * Cancel discussion
 */
export async function cancelDiscussion(sessionId: number): Promise<void> {
  return invoke("chat_cancel", { sessionId });
}
