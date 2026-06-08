// Workspace 管理 API 包装
import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceMeta {
  name: string;
  project_root: string;
  open_tabs: string[];
  active_tab: string | null;
  ui_state: UiState;
  last_used_at: number;
}

export interface UiState {
  sidebar_width: number;
  outline_width: number;
  editor_flex: number;
  sidebar_open: boolean;
  active_panel: string;
  sidebar_panel: string;
}

export interface WorkspaceInfo {
  id: string;
  meta: WorkspaceMeta;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  return invoke<void>("set_active_workspace", { workspaceId });
}

export async function closeWorkspace(workspaceId: string): Promise<void> {
  return invoke<void>("close_workspace", { workspaceId });
}

export interface UpdateMetaArgs {
  workspace_id: string;
  open_tabs?: string[];
  active_tab?: string | null;
  ui_state?: UiState;
  name?: string;
}

export async function updateWorkspaceMeta(args: UpdateMetaArgs): Promise<void> {
  return invoke<void>("update_workspace_meta", { args });
}

export async function newWorkspace(projectRoot: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("new_workspace", { projectRoot });
}

export async function detachWorkspaceToWindow(workspaceId: string): Promise<string> {
  return invoke<string>("detach_workspace_to_window", { workspaceId });
}

// =============================================================================
// Quick Open：文件名模糊搜索
// =============================================================================

/** Quick Open 单条匹配 */
export interface FileMatch {
  path: string;
  score: number;
}

/**
 * 按子序列模糊匹配在工作区下找文件
 * - 纯前端：query + 回调由 QuickOpenModal 控制
 * - maxResults 默认 50，UI 按需截断
 */
export async function findFiles(
  query: string,
  maxResults = 50,
): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("find_files", { query, maxResults });
}
