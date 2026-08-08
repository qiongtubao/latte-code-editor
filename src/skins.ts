// skins — 编辑器皮肤注册表（chrome 换肤的单一数据源）。
//
// 一套皮肤 = chrome 语义 token（vars，驱动 Tailwind @theme inline 工具类）
// + 默认搭配的 CodeMirror 主题（cmTheme，setSkin 时联动切换，可再单改）
// + chat iframe 的 :root 变量映射（chatVars，经 chatBridge.setSkin 同源直写，
//   对应 latte-rs-agents UI styles.css 的变量，不改对方仓库）。
//
// applySkin 运行时把 vars 写到 documentElement，styles.css 的
// `@theme inline { --color-*: var(--*) }` 让所有 token 工具类即时跟随。
// 新增皮肤：在 SKINS 加一条（vars/chatVars 的 key 集合必须与现有皮肤一致，
// skins.test.ts 会断言），并在 useSettingsStore 的 SkinId 处同步类型。

import type { EditorTheme } from "./hooks/useSettingsStore";

export type SkinId = "vscode-dark" | "monokai" | "dracula" | "github-light" | "solarized-light";

export interface SkinDef {
  id: SkinId;
  label: string;
  colorScheme: "dark" | "light";
  /** 选皮肤时联动切换的 CodeMirror 主题。 */
  cmTheme: EditorTheme;
  /** chrome 语义 token（key 含 `--` 前缀），applySkin 写到 documentElement。 */
  vars: Record<string, string>;
  /** chat iframe :root 变量（latte-agent-ui styles.css 的变量名）。 */
  chatVars: Record<string, string>;
}

export const SKINS: Record<SkinId, SkinDef> = {
  "vscode-dark": {
    id: "vscode-dark",
    label: "VS Code Dark",
    colorScheme: "dark",
    cmTheme: "oneDark",
    vars: {
      "--surface": "#1e1e1e",
      "--surface-2": "#252526",
      "--surface-3": "#2d2d2d",
      "--control": "#3a3a3a",
      "--control-hover": "#4a4a4a",
      "--fg": "#d4d4d4",
      "--fg-2": "#9d9d9d",
      "--fg-3": "#6a6a6a",
      "--edge": "#3c3c3c",
      "--accent": "#007acc",
      "--accent-2": "#0098ff",
      "--ok": "#89d185",
      "--warn": "#cca700",
      "--err": "#f14c4c",
      "--ok-bg": "#1a3a1a",
      "--warn-bg": "#3d3418",
      "--err-bg": "#401d1d",
      "--selection": "#264f78",
      "--info": "#094771",
    },
    // 与 skins/chat-ui-vscode-dark.css 保持一致（该文件仍是 iframe 首帧默认皮肤）。
    chatVars: {
      "--bg": "#1e1e1e",
      "--bg-2": "#252526",
      "--bg-3": "#2d2d2d",
      "--fg": "#d4d4d4",
      "--fg-2": "#9d9d9d",
      "--border": "#3c3c3c",
      "--accent": "#007acc",
      "--accent-2": "#0098ff",
      "--ok": "#89d185",
      "--warn": "#cca700",
      "--err": "#f14c4c",
      "--tool-bubble": "#c586c0",
      "--status-bubble": "#4fc1ff",
      "--user-bubble": "#094771",
      "--bubble-bg": "#252526",
      "--bubble-shadow": "0 1px 4px rgba(0, 0, 0, 0.45)",
    },
  },

  monokai: {
    id: "monokai",
    label: "Monokai",
    colorScheme: "dark",
    cmTheme: "monokai",
    vars: {
      "--surface": "#272822",
      "--surface-2": "#2f302a",
      "--surface-3": "#3e3d32",
      "--control": "#49483e",
      "--control-hover": "#57584c",
      "--fg": "#f8f8f2",
      "--fg-2": "#b8b8a8",
      "--fg-3": "#75715e",
      "--edge": "#3e3d32",
      "--accent": "#66d9ef",
      "--accent-2": "#7ee3f8",
      "--ok": "#a6e22e",
      "--warn": "#e6db74",
      "--err": "#f92672",
      "--ok-bg": "#2e3d24",
      "--warn-bg": "#3d3822",
      "--err-bg": "#3d2428",
      "--selection": "#49483e",
      "--info": "#30525f",
    },
    chatVars: {
      "--bg": "#272822",
      "--bg-2": "#2f302a",
      "--bg-3": "#3e3d32",
      "--fg": "#f8f8f2",
      "--fg-2": "#b8b8a8",
      "--border": "#3e3d32",
      "--accent": "#66d9ef",
      "--accent-2": "#7ee3f8",
      "--ok": "#a6e22e",
      "--warn": "#e6db74",
      "--err": "#f92672",
      "--tool-bubble": "#ae81ff",
      "--status-bubble": "#66d9ef",
      "--user-bubble": "#30525f",
      "--bubble-bg": "#2f302a",
      "--bubble-shadow": "0 1px 4px rgba(0, 0, 0, 0.45)",
    },
  },

  dracula: {
    id: "dracula",
    label: "Dracula",
    colorScheme: "dark",
    cmTheme: "dracula",
    vars: {
      "--surface": "#282a36",
      "--surface-2": "#2f3241",
      "--surface-3": "#383a4a",
      "--control": "#44475a",
      "--control-hover": "#565b71",
      "--fg": "#f8f8f2",
      "--fg-2": "#a8b0ca",
      "--fg-3": "#6272a4",
      "--edge": "#44475a",
      "--accent": "#bd93f9",
      "--accent-2": "#caa8fc",
      "--ok": "#50fa7b",
      "--warn": "#f1fa8c",
      "--err": "#ff5555",
      "--ok-bg": "#24402c",
      "--warn-bg": "#3f3d2c",
      "--err-bg": "#402830",
      "--selection": "#44475a",
      "--info": "#3b3355",
    },
    chatVars: {
      "--bg": "#282a36",
      "--bg-2": "#2f3241",
      "--bg-3": "#383a4a",
      "--fg": "#f8f8f2",
      "--fg-2": "#a8b0ca",
      "--border": "#44475a",
      "--accent": "#bd93f9",
      "--accent-2": "#caa8fc",
      "--ok": "#50fa7b",
      "--warn": "#f1fa8c",
      "--err": "#ff5555",
      "--tool-bubble": "#ff79c6",
      "--status-bubble": "#8be9fd",
      "--user-bubble": "#3b3355",
      "--bubble-bg": "#2f3241",
      "--bubble-shadow": "0 1px 4px rgba(0, 0, 0, 0.45)",
    },
  },

  "github-light": {
    id: "github-light",
    label: "GitHub Light",
    colorScheme: "light",
    cmTheme: "githubLight",
    vars: {
      "--surface": "#ffffff",
      "--surface-2": "#f6f8fa",
      "--surface-3": "#eaeef2",
      "--control": "#eaeef2",
      "--control-hover": "#d1d9e0",
      "--fg": "#1f2328",
      "--fg-2": "#59636e",
      "--fg-3": "#8a9199",
      "--edge": "#d1d9e0",
      "--accent": "#0969da",
      "--accent-2": "#0550ae",
      "--ok": "#1a7f37",
      "--warn": "#9a6700",
      "--err": "#d1242f",
      "--ok-bg": "#dafbe1",
      "--warn-bg": "#fff8c5",
      "--err-bg": "#ffebe9",
      "--selection": "#b6d4f7",
      "--info": "#ddf4ff",
    },
    chatVars: {
      "--bg": "#ffffff",
      "--bg-2": "#f6f8fa",
      "--bg-3": "#eaeef2",
      "--fg": "#1f2328",
      "--fg-2": "#59636e",
      "--border": "#d1d9e0",
      "--accent": "#0969da",
      "--accent-2": "#0550ae",
      "--ok": "#1a7f37",
      "--warn": "#9a6700",
      "--err": "#d1242f",
      "--tool-bubble": "#8250df",
      "--status-bubble": "#0969da",
      "--user-bubble": "#ddf4ff",
      "--bubble-bg": "#f6f8fa",
      "--bubble-shadow": "0 1px 4px rgba(0, 0, 0, 0.15)",
    },
  },

  "solarized-light": {
    id: "solarized-light",
    label: "Solarized Light",
    colorScheme: "light",
    cmTheme: "solarizedLight",
    vars: {
      "--surface": "#fdf6e3",
      "--surface-2": "#eee8d5",
      "--surface-3": "#e4ddc8",
      "--control": "#d6d1bf",
      "--control-hover": "#c9c3af",
      "--fg": "#657b83",
      "--fg-2": "#93a1a1",
      "--fg-3": "#b5c0c0",
      "--edge": "#d6d1bf",
      "--accent": "#268bd2",
      "--accent-2": "#1f6fa8",
      "--ok": "#859900",
      "--warn": "#b58900",
      "--err": "#dc322f",
      "--ok-bg": "#e4ead2",
      "--warn-bg": "#ece5c2",
      "--err-bg": "#f0ddd0",
      "--selection": "#e3dcc4",
      "--info": "#e6dfbe",
    },
    chatVars: {
      "--bg": "#fdf6e3",
      "--bg-2": "#eee8d5",
      "--bg-3": "#e4ddc8",
      "--fg": "#657b83",
      "--fg-2": "#93a1a1",
      "--border": "#d6d1bf",
      "--accent": "#268bd2",
      "--accent-2": "#1f6fa8",
      "--ok": "#859900",
      "--warn": "#b58900",
      "--err": "#dc322f",
      "--tool-bubble": "#6c71c4",
      "--status-bubble": "#2aa198",
      "--user-bubble": "#e6dfbe",
      "--bubble-bg": "#eee8d5",
      "--bubble-shadow": "0 1px 4px rgba(0, 0, 0, 0.15)",
    },
  },
};

export function getSkin(id: SkinId): SkinDef {
  return SKINS[id];
}

/**
 * 把皮肤的 chrome token 写到 <html> 上（styles.css 的 @theme inline 引用这些
 * 变量，所有 token 工具类即时跟随），并同步 color-scheme / data-skin。
 * chatVars 不在这里处理——chat iframe 由 chatBridge.setSkin 负责。
 */
export function applySkin(id: SkinId): void {
  const skin = SKINS[id];
  const el = document.documentElement;
  for (const [key, value] of Object.entries(skin.vars)) {
    el.style.setProperty(key, value);
  }
  el.style.colorScheme = skin.colorScheme;
  el.dataset.skin = id;
  // canvas 渲染器（图谱）等监听此事件触发重绘。
  window.dispatchEvent(new Event("latte-skin-changed"));
}

/**
 * 读当前皮肤 token 的计算值（canvas/WebGPU 渲染器等拿不到 Tailwind 类的
 * 场景用）。name 含 `--` 前缀；变量未设置时返回 fallback。
 */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
