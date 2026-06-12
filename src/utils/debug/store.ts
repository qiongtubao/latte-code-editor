import { create } from "zustand";

interface DebugState {
  isOn: boolean;
  /** When true, also emit `level=debug` events (high-volume). Default off. */
  verbose: boolean;
  sid: string;
  replayLocks: Map<string, number>; // key -> acquiredAtMs
  skipDangerousConfirm: boolean;
  setOn: (v: boolean) => void;
  setVerbose: (v: boolean) => void;
  hydrate: () => void;
  tryAcquireLock: (key: string) => boolean;
  releaseLock: (key: string) => void;
}

const LOCK_TIMEOUT_MS = 3_000;
const STORAGE_KEY = "latte.debug";

function newSid(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readEnvOn(): boolean {
  // Vite injects import.meta.env.* at build time. The variable name is
  // mirrored from src-tauri's `LATTE_DEBUG` env var; the value reaches the
  // frontend only when explicitly exposed via `vite.config.ts` `define` or
  // when the user opens DevTools. The shortcut path remains the primary
  // toggle, this is a convenience for development builds.
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.LATTE_DEBUG === "1";
}

export const useDebugStore = create<DebugState>((set, get) => ({
  isOn: false,
  verbose: localStorage.getItem("latte.debug.verbose") === "1",
  sid: newSid(),
  replayLocks: new Map(),
  skipDangerousConfirm: false,
  setOn: (v) => {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    set({ isOn: v });
  },
  setVerbose: (v) => {
    localStorage.setItem("latte.debug.verbose", v ? "1" : "0");
    set({ verbose: v });
  },
  hydrate: () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const on = stored === "1" || readEnvOn();
    set({ isOn: on });
  },
  tryAcquireLock: (key) => {
    const now = Date.now();
    const locks = new Map(get().replayLocks);
    const held = locks.get(key);
    if (held !== undefined) {
      if (now - held < LOCK_TIMEOUT_MS) return false;
      // Stale lock — force-release.
      locks.delete(key);
    }
    locks.set(key, now);
    set({ replayLocks: locks });
    return true;
  },
  releaseLock: (key) => {
    const locks = new Map(get().replayLocks);
    locks.delete(key);
    set({ replayLocks: locks });
  },
}));
