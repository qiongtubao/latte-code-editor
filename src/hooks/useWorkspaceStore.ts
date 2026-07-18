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
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent } from "../utils/debug/inject";
import { useDebugStore } from "../utils/debug/store";

const log = createDebugLogger("workspace");

/** 与后端 WorkspaceMeta 字段对齐 */
export interface WorkspaceMeta {
  name: string;
  project_root: string;
  open_tabs: string[];
  active_tab: string | null;
  ui_state: UiState;
  last_used_at: number;
  chat_state?: PersistedWorkspaceChat | null;
}

export interface PersistedChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: number;
  agentIcon?: string;
  agentName?: string;
}

export interface PersistedChatActivityEvent {
  id: string;
  kind: string;
  roleId?: string;
  title: string;
  detail?: string;
  timestamp: number;
}

export interface PersistedSwarmStepSpec {
  id: string;
  role: string;
  instruction: string;
}

export interface PersistedSwarmFile {
  path: string;
  kind: "plan" | "output" | "summary";
}

export interface PersistedWorkspaceChat {
  mode: "discuss" | "swarm" | "manager";
  messages: PersistedChatMessage[];
  activityEvents: PersistedChatActivityEvent[];
  status: "idle" | "running" | "completed" | "error";
  selectedWorkflow: string;
  activeSwarmId: string | null;
  swarmPlan: PersistedSwarmStepSpec[];
  swarmFiles: PersistedSwarmFile[];
  swarmSummary: string | null;
  errorMessage: string | null;
  lastUserTopic: string | null;
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
      chat_state?: PersistedWorkspaceChat | null;
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
      let list = await invoke<WorkspaceInfo[]>("list_workspaces");
      // init_workspaces (backend async spawn) might not have finished yet;
      // retry once if we got an empty list on first call.
      if (list.length === 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 500);
        await promise;
        list = await invoke<WorkspaceInfo[]>("list_workspaces");
      }
      const workspaces: Record<string, WorkspaceMeta> = {};
      for (const w of list) workspaces[w.id] = w.meta;
      const active =
        list.length > 0
          ? list.slice().sort((a, b) => b.meta.last_used_at - a.meta.last_used_at)[0].id
          : null;
      set({ workspaces, activeWorkspaceId: active, hydrated: true });
      // Important: sync backend window→workspace mapping.
      // Without this, the backend may still use a different active workspace
      // for the current window label (e.g. from init_workspaces), which breaks
      // workspace-scoped chat routing.
      if (active) {
        try {
          await invoke("set_active_workspace", { workspaceId: active });
        } catch (e) {
          console.error(
            "[useWorkspaceStore] hydrate sync set_active_workspace failed:",
            e,
          );
        }
      }
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
    if (!get().workspaces[workspaceId]) {
      log.warn("ws.activate.unknown", "unknown workspace", { workspaceId });
      return;
    }
    log.info("ws.activate", "setting active", { workspaceId });
    try {
      await invoke("set_active_workspace", { workspaceId });
    } catch (e) {
      log.error("ws.activate.error", String(e), { workspaceId });
      console.error("[useWorkspaceStore] setActive failed:", e);
    }
    set({ activeWorkspaceId: workspaceId });
    log.info("ws.activate.ok", "active", { workspaceId });
  },
  closeWorkspace: async (workspaceId: string) => {
    const lockKey = `workspace:close:${workspaceId}`;
    if (!useDebugStore.getState().tryAcquireLock(lockKey)) {
      log.warn("ws.close.skipped", "locked", { workspaceId });
      return;
    }
    try {
      log.info("ws.close", "closing", { workspaceId });
      const { cancelWorkspaceDiscussion } = await import("../api/chat");
      await cancelWorkspaceDiscussion(workspaceId).catch((e) => {
        console.error("[useWorkspaceStore] cancel workspace chat failed:", e);
      });
      await invoke("close_workspace", { workspaceId });
    } catch (e) {
      log.error("ws.close.error", String(e), { workspaceId });
      console.error("[useWorkspaceStore] closeWorkspace failed:", e);
    }
    const [{ useEditorStore }, { useGraphStore }] = await Promise.all([
      import("./useEditorStore"),
      import("./useGraphStore"),
    ]);
    useEditorStore.getState().evictWorkspace(workspaceId);
    useGraphStore.getState().evictWorkspace(workspaceId);
    set((s) => {
      const { [workspaceId]: _drop, ...rest } = s.workspaces;
      const isActive = s.activeWorkspaceId === workspaceId;
      return {
        workspaces: rest,
        activeWorkspaceId: isActive ? null : s.activeWorkspaceId,
      };
    });
    useDebugStore.getState().releaseLock(lockKey);
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
      chat_state:
        patch.chat_state === undefined ? prev.chat_state : patch.chat_state,
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
          chat_state:
            patch.chat_state === undefined ? undefined : patch.chat_state,
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

// Register workspace events for debug injection.
registerDebugEvent("workspace.activate", async (ctx) => {
  const id = typeof ctx.workspaceId === "string" ? ctx.workspaceId : "";
  if (id) await useWorkspaceStore.getState().setActive(id);
});
registerDebugEvent("workspace.delete", async (ctx) => {
  const id = typeof ctx.workspaceId === "string" ? ctx.workspaceId : "";
  if (id) await useWorkspaceStore.getState().closeWorkspace(id);
}, { dangerous: true });
registerDebugEvent("workspace.hydrate", async () => {
  await useWorkspaceStore.getState().hydrate();
});

export function defaultUiState(): UiState {
  return { ...DEFAULT_UI_STATE };
}
