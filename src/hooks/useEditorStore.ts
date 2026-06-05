import { create } from "zustand";
import type { FileResult } from "../api/commands";

export type TabState = "code" | "large-file" | "loading" | "empty";

/** A tracked open file with its current content */
export interface TabFile {
  result: FileResult;
  currentContent: string;
}

interface EditorStore {
  /** All open files (tabs) */
  tabs: TabFile[];
  /** Index of active tab */
  activeIndex: number;

  /** Derived state (from active tab) */
  openFile: FileResult | null;
  currentContent: string;
  tabState: TabState;
  modified: boolean;
  filePath: string | null;

  /** Current word at cursor (for go-to-definition) */
  /** Line to jump to after file opens */
  targetLine: number | null;
  cursorWord: string;
  /** Open or switch to a file */
  openFileOrSwitch: (file: FileResult) => void;
  /** Update content of active tab */
  setContent: (content: string) => void;
  setModified: (modified: boolean) => void;
  /** Switch to tab by index */
  setCursorWord: (word: string) => void;
  switchTab: (index: number) => void;
  /** Close tab by index */
  setTargetLine: (line: number | null) => void;
  closeTab: (index: number) => void;
  reset: () => void;
}

function deriveActive(tabs: TabFile[], activeIndex: number) {
  if (tabs.length === 0) {
    return {
      openFile: null,
      currentContent: "",
      tabState: "empty" as TabState,
      modified: false,
      filePath: null,
    };
  }
  const active = tabs[activeIndex] ?? tabs[tabs.length - 1];
  const idx = active === tabs[activeIndex] ? activeIndex : tabs.length - 1;
  return {
    openFile: active.result,
    currentContent: active.currentContent,
    tabState: active.result.is_large_file ? ("large-file" as TabState) : ("code" as TabState),
    modified: active.result.is_modified,
    filePath: active.result.path,
    activeIndex: idx,
  };
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  tabs: [],
  activeIndex: 0,
  openFile: null,
  currentContent: "",
  tabState: "empty",
  modified: false,
  filePath: null,

  cursorWord: "",
  targetLine: null,
  openFileOrSwitch: (file) => {
    const { tabs } = get();
    const existing = tabs.findIndex((t) => t.result.path === file.path);

    let newTabs: TabFile[];
    let newIndex: number;

    if (existing >= 0) {
      // Update content and switch to existing tab
      newTabs = tabs.map((t, i) =>
        i === existing
          ? { result: file, currentContent: file.content }
          : t,
      );
      newIndex = existing;
    } else {
      // Add new tab
      newTabs = [
        ...tabs,
        { result: file, currentContent: file.content },
      ];
      newIndex = newTabs.length - 1;
    }

    set({
      tabs: newTabs,
      ...deriveActive(newTabs, newIndex),
    });
  },

  setContent: (content) => {
    const { tabs, activeIndex } = get();
    if (tabs.length === 0) return;

    const newTabs = tabs.map((t, i) =>
      i === activeIndex
        ? { ...t, currentContent: content, result: { ...t.result, is_modified: true } }
        : t,
    );

    set({
      tabs: newTabs,
      currentContent: content,
      modified: true,
    });
  },

  setModified: (modified) => {
    const { tabs, activeIndex } = get();
    if (tabs.length === 0) return;


    const newTabs = tabs.map((t, i) =>
      i === activeIndex
        ? { ...t, result: { ...t.result, is_modified: modified } }
        : t,
    );
    set({ tabs: newTabs, modified });
  },

  setCursorWord: (word) => set({ cursorWord: word }),

  setTargetLine: (line) => set({ targetLine: line }),

  switchTab: (index) => {
    const { tabs } = get();
    if (index < 0 || index >= tabs.length) return;
    set({ ...deriveActive(tabs, index) });
  },

  closeTab: (index) => {
    const { tabs } = get();
    if (index < 0 || index >= tabs.length) return;

    const newTabs = tabs.filter((_, i) => i !== index);
    if (newTabs.length === 0) {
      set({
        tabs: [],
        openFile: null,
        currentContent: "",
        tabState: "empty",
        modified: false,
        filePath: null,
        activeIndex: 0,
      });
      return;
    }

    // If closing active or before active, adjust index
    let newIndex = get().activeIndex;
    if (index <= newIndex && newIndex > 0) {
      newIndex--;
    } else if (index < newIndex) {
      newIndex--;
    }
    // Clamp
    if (newIndex >= newTabs.length) newIndex = newTabs.length - 1;

    set({
      tabs: newTabs,
      ...deriveActive(newTabs, newIndex),
    });
  },

  reset: () =>
    set({
      tabs: [],
      activeIndex: 0,
      openFile: null,
      currentContent: "",
      tabState: "empty",
      modified: false,
      filePath: null,
    }),
}));
