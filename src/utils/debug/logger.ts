import { useDebugStore } from "./store";

const VERBOSE_KEY = "latte.debug.verbose";
function isVerbose(): boolean {
  if (useDebugStore.getState().verbose) return true;
  try {
    return localStorage.getItem(VERBOSE_KEY) === "1";
  } catch {
    return false;
  }
}

const SECRET_KEYS = new Set([
  "password",
  "apiKey",
  "token",
  "secret",
  "authorization",
]);

const lastByKey = new Map<string, number>();

function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) out[k] = "***";
    else out[k] = redact(v);
  }
  return out;
}

export interface LoggerOpts {
  sampleRate?: number; // 0..1; default 1 (always)
  throttleMs?: number; // default 100
}

export interface DebugLogger {
  debug: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
  info: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
  warn: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
  error: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
}

export function createDebugLogger(
  module: string,
  opts: LoggerOpts = {},
): DebugLogger {
  const { sampleRate = 1, throttleMs = 100 } = opts;
  const make = (level: "debug" | "info" | "warn" | "error") =>
    (event: string, msg: string, ctx: Record<string, unknown> = {}) => {
      const { isOn } = useDebugStore.getState();
      if (!isOn && level !== "error") return;
      // Suppress `debug` level unless verbose mode is on. Verbose is opt-in
      // (via `localStorage["latte.debug.verbose"] === "1"` or the DebugBar
      // toggle) so the default experience stays quiet.
      if (level === "debug" && !isVerbose()) return;
      if (level !== "error" && sampleRate < 1 && Math.random() > sampleRate) return;
      const traceId =
        typeof ctx.traceId === "string" ? (ctx.traceId as string) : event;
      const throttleKey = `${level}:${event}:${traceId}`;
      const last = lastByKey.get(throttleKey);
      const now = Date.now();
      if (last !== undefined && now - last < throttleMs) return;
      lastByKey.set(throttleKey, now);

      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        side: "front",
        module,
        event,
        msg,
        ctx: redact(ctx),
        sid: useDebugStore.getState().sid,
      });
      const tag = `latte:${line}`;
      if (level === "error") console.error(tag);
      else if (level === "warn") console.warn(tag);
      else if (level === "debug") console.debug(tag);
      else console.info(tag);
      // Fire-and-forget forward to backend (wired in Phase 2).
      forwardToBackend(tag).catch(() => {});
    };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
}

async function forwardToBackend(_line: string): Promise<void> {
  // Wired in Phase 2 via `invoke("debug_log_from_front", { line })`.
  return;
}
