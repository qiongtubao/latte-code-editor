import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { createDebugLogger } from "../utils/debug/logger";

const log = createDebugLogger("ipc", { throttleMs: 0 });

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const t0 = performance.now();
  log.debug("ipc.invoke", cmd, { cmd, args });
  try {
    const result = await tauriInvoke<T>(cmd, args);
    log.info(
      "ipc.response",
      cmd,
      { cmd, ms: Math.round(performance.now() - t0) },
    );
    return result;
  } catch (e) {
    log.error("ipc.error", cmd, { cmd, error: String(e) });
    throw e;
  }
}
