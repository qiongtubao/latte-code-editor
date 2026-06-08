// 多工作区（multi-workspace）状态管理
//
// 设计：
// - workspaces: Record<workspaceId, WorkspaceMeta>，每个 workspace 独立的元数据
// - activeWorkspaceId: 当前窗口激活的 workspace
// - windowMappings: window label -> active workspace id（多窗口支持）
// - 所有写操作都同步到后端 invoke，让后端做权威存储 + 持久化
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { OpenFolderResult } from "../api/commands";

/** 与后端 WorkspaceMeta 字段对齐 */
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
  active_panel: "editor" | "graph" | "split" | string;
  sidebar_panel: "explorer" | "search" | string;
}

export interface WorkspaceInfo {
  id: string;
  meta: WorkspaceMeta;
}

interface WorkspaceStore {
  workspaces: Record<string, WorkspaceMeta>;
  activeWorkspaceId: string | null;
  windowMappings: Record<string, string>;
  hydrated: boolean;

  // ===== actions =====
  hydrate: () => Promise<void>;
  /**
   * 打开文件夹：一次 invoke 拿到后端权威 workspace_id + 完整 OpenFolderResult。
   * 返回 OpenFolderResult 让调用方（Sidebar）能直接读 has_graph / entries 等字段做后续决策。
   */
  openFolder: (path: string) => Promise<OpenFolderResult>;
  /** 显式创建 workspace（不通过文件夹） */
  createWorkspace: (path: string) => Promise<WorkspaceInfo>;
  setActive: (workspaceId: string) => Promise<void>;
  closeWorkspace: (workspaceId: string) => Promise<void>;
  updateMeta: (
    workspaceId: string,
    patch: {
      open_tabs?: string[];
      active_tab?: string | null;
      ui_state?: UiState;
      name?: string;
    },
  ) => Promise<void>;
  detachToWindow: (workspaceId: string) => Promise<string>;

  getActive: () => WorkspaceInfo | null;
  listAll: () => WorkspaceInfo[];
}

const DEFAULT_UI_STATE: UiState = {
  sidebar_width: 240,
  outline_width: 180,
  editor_flex: 0.5,
  sidebar_open: true,
  active_panel: "split",
  sidebar_panel: "explorer",
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: {},
  activeWorkspaceId: null,
  windowMappings: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const list = await invoke<WorkspaceInfo[]>("list_workspaces");
      const workspaces: Record<string, WorkspaceMeta> = {};
      for (const w of list) workspaces[w.id] = w.meta;
      const active =
        list.length > 0
          ? list.slice().sort((a, b) => b.meta.last_used_at - a.meta.last_used_at)[0].id
          : null;
      set({ workspaces, activeWorkspaceId: active, hydrated: true });
    } catch (e) {
      console.error("[useWorkspaceStore] hydrate failed:", e);
      set({ hydrated: true });
    }
  },

  openFolder: async (path: string) => {
    // 后端 open_folder 返回 OpenFolderResult（含 workspace_id + workspace_meta）
    const result = await invoke<OpenFolderResult>("open_folder", { path });
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [result.workspace_id]: result.workspace_meta,
      },
      activeWorkspaceId: result.workspace_id,
    }));
    return result;
  },

  createWorkspace: async (path: string) => {
    const info = await invoke<WorkspaceInfo>("new_workspace", { projectRoot: path });
    set((s) => ({
      workspaces: { ...s.workspaces, [info.id]: info.meta },
      activeWorkspaceId: info.id,
    }));
    return info;
  },

  setActive: async (workspaceId: string) => {
    if (!get().workspaces[workspaceId]) return;
    try {
      await invoke("set_active_workspace", { workspaceId });
    } catch (e) {
      console.error("[useWorkspaceStore] setActive failed:", e);
    }
    set({ activeWorkspaceId: workspaceId });
  },

  closeWorkspace: async (workspaceId: string) => {
    try {
      await invoke("close_workspace", { workspaceId });
    } catch (e) {
      console.error("[useWorkspaceStore] closeWorkspace failed:", e);
    }
    set((s) => {
      const { [workspaceId]: _drop, ...rest } = s.workspaces;
      const isActive = s.activeWorkspaceId === workspaceId;
      return {
        workspaces: rest,
        activeWorkspaceId: isActive ? null : s.activeWorkspaceId,
      };
    });
  },

  updateMeta: async (workspaceId, patch) => {
    const prev = get().workspaces[workspaceId];
    if (!prev) return;
    const next: WorkspaceMeta = {
      ...prev,
      open_tabs: patch.open_tabs ?? prev.open_tabs,
      active_tab:
        patch.active_tab === undefined ? prev.active_tab : patch.active_tab,
      ui_state: patch.ui_state ?? prev.ui_state,
      name: patch.name ?? prev.name,
    };
    set((s) => ({ workspaces: { ...s.workspaces, [workspaceId]: next } }));
    try {
      await invoke("update_workspace_meta", {
        args: {
          workspace_id: workspaceId,
          open_tabs: patch.open_tabs,
          active_tab: patch.active_tab === undefined ? undefined : patch.active_tab,
          ui_state: patch.ui_state,
          name: patch.name,
        },
      });
    } catch (e) {
      console.error("[useWorkspaceStore] updateMeta failed:", e);
    }
  },

  detachToWindow: async (workspaceId: string) => {
    const newLabel = await invoke<string>("detach_workspace_to_window", {
      workspaceId,
    });
    set((s) => ({
      windowMappings: { ...s.windowMappings, [newLabel]: workspaceId },
    }));
    return newLabel;
  },

  getActive: () => {
    const s = get();
    if (!s.activeWorkspaceId) return null;
    const meta = s.workspaces[s.activeWorkspaceId];
    if (!meta) return null;
    return { id: s.activeWorkspaceId, meta };
  },

  listAll: () => {
    const s = get();
    return Object.entries(s.workspaces).map(([id, meta]) => ({ id, meta }));
  },
}));

export function defaultUiState(): UiState {
  return { ...DEFAULT_UI_STATE };
}
