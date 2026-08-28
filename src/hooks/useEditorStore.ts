import { create } from "zustand";
import type { FileResult } from "../api/commands";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { refreshFile } from "../api/fileRefresh";
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent } from "../utils/debug/inject";

const log = createDebugLogger("editor");
export type TabState = "code" | "markdown" | "large-file" | "loading" | "empty";

export interface TabFile {
  result: FileResult;
  currentContent: string;
}

interface WorkspaceEditor {
  tabs: TabFile[];
  activeIndex: number;
  cursorWord: string;
  targetLine: number | null;
  targetColumn: number | null;
  markdownMode: "preview" | "source";
}

function emptyEditor(): WorkspaceEditor {
  return {
    tabs: [],
    activeIndex: 0,
    cursorWord: "",
    targetLine: null,
    targetColumn: null,
    markdownMode: "preview",
  };
}

interface EditorStore {
  byWorkspace: Record<string, WorkspaceEditor>;

  tabs: TabFile[];
  activeIndex: number;
  openFile: FileResult | null;
  currentContent: string;
  tabState: TabState;
  modified: boolean;
  filePath: string | null;
  cursorWord: string;
  targetLine: number | null;
  targetColumn: number | null;
  markdownMode: "preview" | "source";

  openFileOrSwitch: (file: FileResult, targetLine?: number | null) => void;
  setContent: (content: string) => void;
  setModified: (modified: boolean) => void;
  setCursorWord: (word: string) => void;
  switchTab: (index: number) => void;
  setTargetLine: (line: number | null, column?: number | null) => void;
  closeTab: (index: number) => void;
  evictWorkspace: (workspaceId: string) => void;
  reset: () => void;
  refreshCurrentFile: () => Promise<void>;
  toggleMarkdownMode: () => void;
  setMarkdownMode: (mode: "preview" | "source") => void;
}

interface DerivedFields {
  openFile: FileResult | null;
  currentContent: string;
  tabState: TabState;
  modified: boolean;
  filePath: string | null;
  activeIndex: number;
  markdownMode: "preview" | "source";
}

function deriveActive(state: WorkspaceEditor): DerivedFields {
  if (state.tabs.length === 0) {
    return {
      openFile: null, currentContent: "", tabState: "empty",
      modified: false, filePath: null, activeIndex: 0, markdownMode: "preview",
    };
  }
  const safeIdx = state.activeIndex < state.tabs.length
    ? state.activeIndex
    : state.tabs.length - 1;
  const active = state.tabs[safeIdx];
  return {
    openFile: active.result,
    currentContent: active.currentContent,
    tabState: active.result.is_large_file ? "large-file" : 
              active.result.path.endsWith(".md") ? "markdown" : "code",
    modified: active.result.is_modified,
    filePath: active.result.path,
    activeIndex: safeIdx,
    markdownMode: state.markdownMode,
  };
}

function projectFrom(
  byWorkspace: Record<string, WorkspaceEditor>,
  wsId: string | null,
): Partial<EditorStore> {
  if (!wsId) {
    return {
      tabs: [], activeIndex: 0, openFile: null, currentContent: "",
      tabState: "empty", modified: false, filePath: null,
      cursorWord: "", targetLine: null, targetColumn: null, markdownMode: "preview",
    };
  }
  const ws = byWorkspace[wsId] ?? emptyEditor();
  const derived = deriveActive(ws);
  return {
    tabs: ws.tabs, activeIndex: derived.activeIndex,
    cursorWord: ws.cursorWord, targetLine: ws.targetLine, targetColumn: ws.targetColumn,
    openFile: derived.openFile, currentContent: derived.currentContent,
    tabState: derived.tabState, modified: derived.modified, filePath: derived.filePath,
    markdownMode: derived.markdownMode,
  };
}

function mutate(
  byWorkspace: Record<string, WorkspaceEditor>,
  wsId: string, ws: WorkspaceEditor,
): Partial<EditorStore> {
  const next = { ...byWorkspace, [wsId]: ws };
  return { byWorkspace: next, ...projectFrom(next, wsId) };
}

function persistTabs(state: WorkspaceEditor) {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!wsId) return;
  // updateMeta 内部已 try/catch；持久化失败不应阻塞编辑器状态更新
  void useWorkspaceStore.getState().updateMeta(wsId, {
    open_tabs: state.tabs.map((t) => t.result.path),
    active_tab: state.tabs[state.activeIndex]?.result.path ?? null,
  });
}

export const useEditorStore = create<EditorStore>((set) => {
  useWorkspaceStore.subscribe(() => {
    const wsId = useWorkspaceStore.getState().activeWorkspaceId;
    set((s) => projectFrom(s.byWorkspace, wsId));
  });

  return {
    byWorkspace: {},
    tabs: [], activeIndex: 0, openFile: null, currentContent: "",
    tabState: "empty", modified: false, filePath: null,
    cursorWord: "", targetLine: null, targetColumn: null, markdownMode: "preview",
    openFileOrSwitch: (file, targetLine = null) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) { console.warn("[useEditorStore] openFileOrSwitch without active workspace"); return; }
      log.info("file.open", "opening file", { path: file.path, workspaceId: wsId });
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        const existing = ws.tabs.findIndex((t) => t.result.path === file.path);
        let newTabs: TabFile[];
        let newIndex: number;
        if (existing >= 0) {
          newTabs = ws.tabs.map((t, i) => i === existing ? { result: file, currentContent: file.content } : t);
          newIndex = existing;
        } else {
          newTabs = [...ws.tabs, { result: file, currentContent: file.content }];
          newIndex = newTabs.length - 1;
        }
        // 原子地同时设置 targetLine + 切换 tab：避免中间帧抖动到错误位置
        const newWs: WorkspaceEditor = { ...ws, tabs: newTabs, activeIndex: newIndex, targetLine };
        queueMicrotask(() => persistTabs(newWs));
        return mutate(s.byWorkspace, wsId, newWs);
      });
    },

    setContent: (content: string) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      log.debug("file.content", "content updated", { workspaceId: wsId, len: content.length });
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        if (ws.tabs.length === 0) return s;
        const newTabs = ws.tabs.map((t, i) => i === ws.activeIndex ? { ...t, currentContent: content, result: { ...t.result, is_modified: true } } : t);
        return mutate(s.byWorkspace, wsId, { ...ws, tabs: newTabs });
      });
    },

    setModified: (modified: boolean) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        if (ws.tabs.length === 0) return s;
        const newTabs = ws.tabs.map((t, i) => i === ws.activeIndex ? { ...t, result: { ...t.result, is_modified: modified } } : t);
        return mutate(s.byWorkspace, wsId, { ...ws, tabs: newTabs });
      });
    },

    setCursorWord: (word: string) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        return mutate(s.byWorkspace, wsId, { ...ws, cursorWord: word });
      });
    },

    setTargetLine: (line: number | null, column?: number | null) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        return mutate(s.byWorkspace, wsId, { ...ws, targetLine: line, targetColumn: column ?? null });
      });
    },

    switchTab: (index: number) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        if (index < 0 || index >= ws.tabs.length) return s;
        const newWs: WorkspaceEditor = { ...ws, activeIndex: index };
        queueMicrotask(() => persistTabs(newWs));
        return mutate(s.byWorkspace, wsId, newWs);
      });
    },
    closeTab: (index: number) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      log.info("file.close", "closing tab", { workspaceId: wsId, index });
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        if (index < 0 || index >= ws.tabs.length) return s;
        const newTabs = ws.tabs.filter((_, i) => i !== index);
        let newIndex = ws.activeIndex;
        if (index <= newIndex && newIndex > 0) newIndex--;
        if (newIndex >= newTabs.length) newIndex = Math.max(0, newTabs.length - 1);
        const newWs: WorkspaceEditor = { ...ws, tabs: newTabs, activeIndex: newIndex };
        queueMicrotask(() => persistTabs(newWs));
        return mutate(s.byWorkspace, wsId, newWs);
      });
    },

    evictWorkspace: (workspaceId: string) => {
      set((s) => {
        const { [workspaceId]: _drop, ...rest } = s.byWorkspace;
        const wsId = useWorkspaceStore.getState().activeWorkspaceId;
        return { byWorkspace: rest, ...projectFrom(rest, wsId) };
      });
    },

    reset: () => set({ byWorkspace: {} }),

    refreshCurrentFile: async () => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;

      const state = useEditorStore.getState();
      const ws = state.byWorkspace[wsId] ?? emptyEditor();

      if (ws.tabs.length === 0 || !ws.tabs[ws.activeIndex]) return;

      const currentTab = ws.tabs[ws.activeIndex];
      const filePath = currentTab.result.path;

      try {
        const result = await refreshFile(filePath);
        set((s) => {
          const ws = s.byWorkspace[wsId] ?? emptyEditor();
          // 按 filePath 匹配，不能按 activeIndex：await 期间用户可能切了 tab，
          // 那时 ws.activeIndex 已指向别的文件，会把文件 A 的内容写进文件 B。
          // 若该 tab 在等待期间被关掉，则没有任何 tab 匹配，自然成为 no-op。
          const newTabs = ws.tabs.map((t) =>
            t.result.path === filePath
              ? { result: { ...t.result, ...result, is_modified: false }, currentContent: result.content }
              : t
          );
          return mutate(s.byWorkspace, wsId, { ...ws, tabs: newTabs });
        });
      } catch (e) {
        console.error("[refreshCurrentFile] Failed to refresh file:", e);
      }
    },

    toggleMarkdownMode: () => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        const newMode = ws.markdownMode === "preview" ? "source" : "preview";
        return mutate(s.byWorkspace, wsId, { ...ws, markdownMode: newMode });
      });
    },
    setMarkdownMode: (mode) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        return mutate(s.byWorkspace, wsId, { ...ws, markdownMode: mode });
      });
    },
  };
});

// Register editor events for debug injection.
registerDebugEvent("file.open", async (ctx) => {
  const path = typeof ctx.path === "string" ? ctx.path : "";
  if (!path) return;
  try {
    const file = await import("../api/commands").then((m) => m.openFile(path));
    useEditorStore.getState().openFileOrSwitch(file);
  } catch (e) {
    log.error("file.open.error", String(e), { path });
  }
});
registerDebugEvent("file.save", async (ctx) => {
  // Save is a "dangerous" op: it overwrites the on-disk file.
  // We do not attempt to implement full save semantics here; the warning and
  // audit log are the contract.
  const path = typeof ctx.path === "string" ? ctx.path : "";
  if (!path) return;
  log.warn("file.save.attempt", "save requested via debug inject", { path });
}, { dangerous: true });
registerDebugEvent("file.delete", async (ctx) => {
  const path = typeof ctx.path === "string" ? ctx.path : "";
  if (!path) return;
  log.warn("file.delete.attempt", "delete requested via debug inject", { path });
}, { dangerous: true });
