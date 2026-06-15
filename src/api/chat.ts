import { invoke } from "@tauri-apps/api/core";

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

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  defaultRoles: string[];
  steps: string[];
}

export interface RoleInfo {
  id: string;
  name: string;
  icon: string;
  category: string;
  defaultModelTier: string;
}

export async function listWorkflows(): Promise<WorkflowInfo[]> {
  return invoke<WorkflowInfo[]>("chat_list_workflows");
}

export async function listRoles(): Promise<RoleInfo[]> {
  return invoke<RoleInfo[]>("chat_list_roles");
}

export async function startDiscussion(req: StartDiscussionRequest): Promise<number> {
  return invoke<number>("chat_start_discussion", { request: req });
}

export async function continueDiscussion(req: ContinueDiscussionRequest): Promise<void> {
  return invoke<void>("chat_continue", { request: req });
}

export async function cancelDiscussion(sessionId: number): Promise<void> {
  return invoke<void>("chat_cancel", { sessionId });
}
