import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerDebugEvent,
  debugEmit,
  replayLastAction,
  getLastActions,
  clearRegisteredEvents,
} from "./inject";
import { useDebugStore } from "./store";

describe("debugEmit / replayLastAction", () => {
  beforeEach(() => {
    useDebugStore.setState({ isOn: true, replayLocks: new Map() });
    getLastActions().length = 0;
    clearRegisteredEvents();
  });

  it("registered event fires with ctx", async () => {
    const fn = vi.fn();
    registerDebugEvent("lsp.start", fn, { dangerous: false });
    await debugEmit("lsp.start", { language: "rust" });
    expect(fn).toHaveBeenCalledWith({ language: "rust" });
  });

  it("dangerous event calls confirm hook and skips if not confirmed", async () => {
    const fn = vi.fn();
    const confirm = vi.fn().mockReturnValue(false);
    registerDebugEvent("workspace.delete", fn, { dangerous: true });
    await debugEmit("workspace.delete", { id: "ws-1" }, { confirm });
    expect(confirm).toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("dangerous event runs when confirmed", async () => {
    const fn = vi.fn();
    const confirm = vi.fn().mockReturnValue(true);
    registerDebugEvent("workspace.delete", fn, { dangerous: true });
    await debugEmit("workspace.delete", { id: "ws-1" }, { confirm });
    expect(fn).toHaveBeenCalled();
  });

  it("replayLastAction replays the most recent action", async () => {
    const fn = vi.fn();
    registerDebugEvent("file.open", fn);
    await debugEmit("file.open", { path: "/a/b.ts" });
    expect(fn).toHaveBeenCalledTimes(1);
    await debugEmit("file.open", { path: "/a/b.ts" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("replay is blocked when lock is held", async () => {
    const fn = vi.fn();
    registerDebugEvent("graph.requestReload", fn);
    useDebugStore.getState().tryAcquireLock("inject:graph.requestReload");
    await debugEmit("graph.requestReload", {});
    const calls = fn.mock.calls.length;
    await debugEmit("graph.requestReload", {});
    expect(fn.mock.calls.length).toBe(calls);
  });
});
