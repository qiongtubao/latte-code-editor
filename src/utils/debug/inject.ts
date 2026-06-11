import { useDebugStore } from "./store";
import { createDebugLogger } from "./logger";

const log = createDebugLogger("debug");

export interface RegisterOpts {
  dangerous?: boolean;
}

type Handler = (ctx: Record<string, unknown>) => void | Promise<void>;
export type Confirm = (
  event: string,
  ctx: Record<string, unknown>,
) => boolean | Promise<boolean>;

interface Registration {
  event: string;
  handler: Handler;
  dangerous: boolean;
}
const registry = new Map<string, Registration[]>();

export function clearRegisteredEvents(): void {
  registry.clear();
  lastActions.length = 0;
}

export function registerDebugEvent(
  event: string,
  handler: Handler,
  opts: RegisterOpts = {},
): void {
  const list = registry.get(event) ?? [];
  list.push({ event, handler, dangerous: !!opts.dangerous });
  registry.set(event, list);
}

export function listDebugEvents(): { event: string; dangerous: boolean }[] {
  return [...registry.values()]
    .flat()
    .map((r) => ({ event: r.event, dangerous: r.dangerous }));
}

interface LastAction {
  event: string;
  ctx: Record<string, unknown>;
  at: number;
}
const lastActions: LastAction[] = [];
const MAX_LAST_ACTIONS = 20;

export function getLastActions(): LastAction[] {
  return lastActions;
}

export interface EmitOpts {
  confirm?: Confirm;
}

export async function debugEmit(
  event: string,
  ctx: Record<string, unknown> = {},
  opts: EmitOpts = {},
): Promise<void> {
  const lockKey = `inject:${event}`;
  const got = useDebugStore.getState().tryAcquireLock(lockKey);
  if (!got) {
    log.warn("debug.replay.skipped", "locked", {
      action: event,
      reason: "locked",
    });
    return;
  }
  try {
    const regs = registry.get(event) ?? [];
    if (regs.length === 0) {
      log.warn("debug.inject.unknown_event", `no handler for ${event}`, {
        event,
      });
      return;
    }
    for (const r of regs) {
      if (r.dangerous && !useDebugStore.getState().skipDangerousConfirm) {
        const ok = opts.confirm
          ? await opts.confirm(event, ctx)
          : false;
        log.warn("debug.inject.dangerous", "dangerous event emit attempt", {
          event,
          confirmed: ok,
          ctx,
        });
        if (!ok) {
          log.info("debug.inject.rejected", "user cancelled", { event });
          return;
        }
      }
      await r.handler(ctx);
    }
    lastActions.unshift({ event, ctx, at: Date.now() });
    if (lastActions.length > MAX_LAST_ACTIONS) lastActions.length = MAX_LAST_ACTIONS;
    log.info("debug.inject.executed", "injected", { event, ctx });
  } finally {
    useDebugStore.getState().releaseLock(lockKey);
  }
}

export function replayLastAction(): void {
  const top = lastActions[0];
  if (!top) {
    log.info("debug.replay.empty", "no actions to replay", {});
    return;
  }
  // Re-emit the same event with the same ctx. debugEmit acquires its own lock.
  void debugEmit(top.event, top.ctx);
}
