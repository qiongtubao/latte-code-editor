/**
 * LSP 状态管理（手动触发模式）
 *
 * 核心理念：默认零资源消耗，需要时显式触发
 */

import { create } from "zustand";
import {
  type LspStatusInfo,
  startLsp as apiStartLsp,
  stopLsp as apiStopLsp,
  hibernateLsp as apiHibernateLsp,
  wakeLsp as apiWakeLsp,
  stopAllLsp as apiStopAllLsp,
  getLspStatusWithMemory,
} from "../api/lsp";
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent } from "../utils/debug/inject";
import { useDebugStore } from "../utils/debug/store";

const log = createDebugLogger("lsp");

/**
 * LSP 设置（可配置）
 */
interface LspSettings {
  /** 自动休眠超时（秒），0 表示禁用 */
  autoHibernateTimeout: number;
  /** 是否在文件打开时自动启动 LSP */
  autoStartOnOpen: boolean;
  /** 内存监控间隔（毫秒）*/
  memoryMonitorInterval: number;
}

const DEFAULT_SETTINGS: LspSettings = {
  autoHibernateTimeout: 600, // 10 分钟
  autoStartOnOpen: false,   // 默认不自动启动
  memoryMonitorInterval: 5000, // 5 秒
};

interface LspStore {
  /** 所有 LSP 状态 */
  status: LspStatusInfo[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 设置 */
  settings: LspSettings;
  /** 内存监控定时器 */
  monitorTimer: number | null;

  /** 启动指定语言的 LSP */
  startLsp: (language: string) => Promise<void>;
  /** 停止指定语言的 LSP */
  stopLsp: (language: string) => Promise<void>;
  /** 休眠指定语言的 LSP */
  hibernateLsp: (language: string) => Promise<void>;
  /** 唤醒指定语言的 LSP */
  wakeLsp: (language: string) => Promise<void>;
  /** 停止所有 LSP */
  stopAll: () => Promise<void>;
  /** 刷新状态（包含内存） */
  refreshStatus: () => Promise<void>;
  /** 启动内存监控 */
  startMonitor: () => void;
  /** 停止内存监控 */
  stopMonitor: () => void;
  /** 更新设置 */
  updateSettings: (settings: Partial<LspSettings>) => void;
  /** 检查指定语言是否运行 */
  isRunning: (language: string) => boolean;
  /** 获取总内存占用（MB） */
  getTotalMemory: () => number;
}

/**
 * 通过快捷键或工具栏触发 LSP 启动
 * 这是手动模式的核心入口
 */
async function manualTriggerStart(language: string): Promise<void> {
  console.log(`[LSP] Manually triggering start for: ${language}`);
  await apiStartLsp(language);
  // 触发后立即刷新状态
  await useLspStore.getState().refreshStatus();
  // 启动内存监控
  useLspStore.getState().startMonitor();
}

export const useLspStore = create<LspStore>((set, get) => ({
  status: [],
  loading: false,
  error: null,
  settings: DEFAULT_SETTINGS,
  monitorTimer: null,
  startLsp: async (language: string) => {
    const lockKey = `lsp:start:${language}`;
    if (!useDebugStore.getState().tryAcquireLock(lockKey)) {
      log.warn("lsp.start.skipped", "locked", { language });
      return;
    }
    set({ loading: true, error: null });
    try {
      log.info("lsp.start", `starting ${language}`, { language });
      await manualTriggerStart(language);
      set({ loading: false });
      log.info("lsp.start.ok", `${language} running`, { language });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error, loading: false });
      log.error("lsp.start.error", String(e), { language });
    } finally {
      useDebugStore.getState().releaseLock(lockKey);
    }
  },
  stopLsp: async (language: string) => {
    const lockKey = `lsp:stop:${language}`;
    if (!useDebugStore.getState().tryAcquireLock(lockKey)) {
      log.warn("lsp.stop.skipped", "locked", { language });
      return;
    }
    set({ loading: true, error: null });
    try {
      log.info("lsp.stop", `stopping ${language}`, { language });
      await apiStopLsp(language);
      await get().refreshStatus();
      set({ loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error, loading: false });
    } finally {
      useDebugStore.getState().releaseLock(lockKey);
    }
  },
  hibernateLsp: async (language: string) => {
    try {
      log.info("lsp.hibernate", `hibernating ${language}`, { language });
      await apiHibernateLsp(language);
      await get().refreshStatus();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error });
    }
  },

  wakeLsp: async (language: string) => {
    try {
      log.info("lsp.wake", `waking ${language}`, { language });
      await apiWakeLsp(language);
      await get().refreshStatus();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error });
    }
  },

  stopAll: async () => {
    try {
      await apiStopAllLsp();
      await get().refreshStatus();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error });
    }
  },

  refreshStatus: async () => {
    try {
      const status = await getLspStatusWithMemory();
      set({ status, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error });
    }
  },

  startMonitor: () => {
    const timer = get().monitorTimer;
    if (timer !== null) return; // 已在运行

    const interval = get().settings.memoryMonitorInterval;
    const newTimer = window.setInterval(() => {
      get().refreshStatus();
    }, interval);
    set({ monitorTimer: newTimer });
  },

  stopMonitor: () => {
    const timer = get().monitorTimer;
    if (timer !== null) {
      window.clearInterval(timer);
      set({ monitorTimer: null });
    }
  },

  updateSettings: (newSettings) => {
    const settings = { ...get().settings, ...newSettings };
    set({ settings });
  },

  isRunning: (language: string) => {
    const status = get().status;
    return status.some(
      (s) => s.language === language && (s.state === "running" || s.state === "hibernated")
    );
  },

  getTotalMemory: () => {
    return get().status.reduce((sum, s) => sum + (s.memory_mb ?? 0), 0);
  },
}));

/**
 * 工具函数：检测文件语言
 */
export function detectFileLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    rs: "rust",
    py: "python",
    go: "go",
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    h: "cpp",
    hpp: "cpp",
  };
  return ext ? (langMap[ext] ?? null) : null;
}

// Register LSP events for debug injection.
registerDebugEvent("lsp.start", async (ctx) => {
  const language = typeof ctx.language === "string" ? ctx.language : "rust";
  await useLspStore.getState().startLsp(language);
});
registerDebugEvent("lsp.stop", async (ctx) => {
  const language = typeof ctx.language === "string" ? ctx.language : "rust";
  await useLspStore.getState().stopLsp(language);
}, { dangerous: true });
registerDebugEvent("lsp.hibernate", async (ctx) => {
  const language = typeof ctx.language === "string" ? ctx.language : "rust";
  await useLspStore.getState().hibernateLsp(language);
});
registerDebugEvent("lsp.wake", async (ctx) => {
  const language = typeof ctx.language === "string" ? ctx.language : "rust";
  await useLspStore.getState().wakeLsp(language);
});
