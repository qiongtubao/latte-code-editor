import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SKINS, type SkinId } from "../skins";

export type EditorTheme = "monokai" | "dracula" | "oneDark" | "solarizedLight" | "githubLight";
export type GraphRendererKind = "auto" | "webgpu" | "canvas2d";

export type { SkinId };

export interface SettingsState {
  // Appearance
  /** chrome 皮肤；setSkin 会联动把 theme 切到皮肤搭配的代码主题。 */
  skin: SkinId;
  // Editor
  theme: EditorTheme;
  fontSize: number;
  tabSize: number;
  lineNumbers: boolean;
  wordWrap: boolean;
  autoSave: boolean;
  autoSaveDelay: number; // ms
  // Graph
  graphRenderer: GraphRendererKind;
  // Docs
  docsInputDir: string;
  docsOutputDir: string;
  // Actions
  setSkin: (s: SkinId) => void;
  setTheme: (t: EditorTheme) => void;
  setFontSize: (s: number) => void;
  setTabSize: (s: number) => void;
  setLineNumbers: (v: boolean) => void;
  setWordWrap: (v: boolean) => void;
  setAutoSave: (v: boolean) => void;
  setGraphRenderer: (k: GraphRendererKind) => void;
  setDocsInputDir: (d: string) => void;
  setDocsOutputDir: (d: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      skin: "vscode-dark",
      theme: "monokai",
      fontSize: 13,
      tabSize: 4,
      lineNumbers: true,
      wordWrap: false,
      autoSave: false,
      autoSaveDelay: 2000,
      graphRenderer: "auto",
      docsInputDir: "docs",
      docsOutputDir: ".latte-review/reports",
      setSkin: (s) => set({ skin: s, theme: SKINS[s].cmTheme }),
      setTheme: (t) => set({ theme: t }),
      setFontSize: (s) => set({ fontSize: s }),
      setTabSize: (s) => set({ tabSize: s }),
      setLineNumbers: (v) => set({ lineNumbers: v }),
      setWordWrap: (v) => set({ wordWrap: v }),
      setAutoSave: (v) => set({ autoSave: v }),
      setGraphRenderer: (k) => set({ graphRenderer: k }),
      setDocsInputDir: (d) => set({ docsInputDir: d }),
      setDocsOutputDir: (d) => set({ docsOutputDir: d }),
    }),
    { name: "latte-settings" },
  ),
);
