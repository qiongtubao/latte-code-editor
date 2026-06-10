import { create } from "zustand";
import type { FileResult } from "../api/commands";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { refreshFile } from "../api/fileRefresh";

export type TabState = "code" | "large-file" | "loading" | "empty";

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
}

function emptyEditor(): WorkspaceEditor {
  return {
    tabs: [],
    activeIndex: 0,
    cursorWord: "",
    targetLine: null,
    targetColumn: null,
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

  openFileOrSwitch: (file: FileResult) => void;
  setContent: (content: string) => void;
  setModified: (modified: boolean) => void;
  setCursorWord: (word: string) => void;
  switchTab: (index: number) => void;
  setTargetLine: (line: number | null, column?: number | null) => void;
  closeTab: (index: number) => void;
  evictWorkspace: (workspaceId: string) => void;
  reset: () => void;
  refreshCurrentFile: () => Promise<void>;
}

interface DerivedFields {
  openFile: FileResult | null;
  currentContent: string;
  tabState: TabState;
  modified: boolean;
  filePath: string | null;
  activeIndex: number;
}

function deriveActive(state: WorkspaceEditor): DerivedFields {
  if (state.tabs.length === 0) {
    return {
      openFile: null, currentContent: "", tabState: "empty",
      modified: false, filePath: null, activeIndex: 0,
    };
  }
  const safeIdx = state.activeIndex < state.tabs.length
    ? state.activeIndex
    : state.tabs.length - 1;
  const active = state.tabs[safeIdx];
  return {
    openFile: active.result,
    currentContent: active.currentContent,
    tabState: active.result.is_large_file ? "large-file" : "code",
    modified: active.result.is_modified,
    filePath: active.result.path,
    activeIndex: safeIdx,
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
      cursorWord: "", targetLine: null, targetColumn: null,
    };
  }
  const ws = byWorkspace[wsId] ?? emptyEditor();
  const derived = deriveActive(ws);
  return {
    tabs: ws.tabs, activeIndex: derived.activeIndex,
    cursorWord: ws.cursorWord, targetLine: ws.targetLine, targetColumn: ws.targetColumn,
    openFile: derived.openFile, currentContent: derived.currentContent,
    tabState: derived.tabState, modified: derived.modified, filePath: derived.filePath,
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
  useWorkspaceStore.getState().updateMeta(wsId, {
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
    cursorWord: "", targetLine: null, targetColumn: null,

    openFileOrSwitch: (file) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) { console.warn("[useEditorStore] openFileOrSwitch without active workspace"); return; }
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
        const newWs: WorkspaceEditor = { ...ws, tabs: newTabs, activeIndex: newIndex };
        queueMicrotask(() => persistTabs(newWs));
        return mutate(s.byWorkspace, wsId, newWs);
      });
    },

    setContent: (content) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        if (ws.tabs.length === 0) return s;
        const newTabs = ws.tabs.map((t, i) => i === ws.activeIndex ? { ...t, currentContent: content, result: { ...t.result, is_modified: true } } : t);
        return mutate(s.byWorkspace, wsId, { ...ws, tabs: newTabs });
      });
    },

    setModified: (modified) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        if (ws.tabs.length === 0) return s;
        const newTabs = ws.tabs.map((t, i) => i === ws.activeIndex ? { ...t, result: { ...t.result, is_modified: modified } } : t);
        return mutate(s.byWorkspace, wsId, { ...ws, tabs: newTabs });
      });
    },

    setCursorWord: (word) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        return mutate(s.byWorkspace, wsId, { ...ws, cursorWord: word });
      });
    },

    setTargetLine: (line, column) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyEditor();
        return mutate(s.byWorkspace, wsId, { ...ws, targetLine: line, targetColumn: column ?? null });
      });
    },

    switchTab: (index) => {
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

    closeTab: (index) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
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

    evictWorkspace: (workspaceId) => {
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
          const newTabs = ws.tabs.map((t, i) => 
            i === ws.activeIndex 
              ? { result: { ...t.result, ...result, is_modified: false }, currentContent: result.content }
              : t
          );
          return mutate(s.byWorkspace, wsId, { ...ws, tabs: newTabs });
        });
      } catch (e) {
        console.error("[refreshCurrentFile] Failed to refresh file:", e);
      }
    },
  };
});