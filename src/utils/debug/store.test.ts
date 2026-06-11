import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDebugStore } from "./store";

describe("useDebugStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useDebugStore.setState({
      isOn: false,
      sid: "",
      replayLocks: new Map(),
      skipDangerousConfirm: false,
    });
  });

  it("toggle flips isOn and persists to localStorage", () => {
    useDebugStore.getState().setOn(true);
    expect(useDebugStore.getState().isOn).toBe(true);
    expect(localStorage.getItem("latte.debug")).toBe("1");
    useDebugStore.getState().setOn(false);
    expect(useDebugStore.getState().isOn).toBe(false);
    expect(localStorage.getItem("latte.debug")).toBe("0");
  });

  it("hydrates from localStorage on init", () => {
    localStorage.setItem("latte.debug", "1");
    useDebugStore.getState().hydrate();
    expect(useDebugStore.getState().isOn).toBe(true);
  });

  it("replayLocks: acquire returns true then false while held; release allows reacquire", () => {
    const a = useDebugStore.getState().tryAcquireLock("lsp:start");
    expect(a).toBe(true);
    const b = useDebugStore.getState().tryAcquireLock("lsp:start");
    expect(b).toBe(false);
    useDebugStore.getState().releaseLock("lsp:start");
    const c = useDebugStore.getState().tryAcquireLock("lsp:start");
    expect(c).toBe(true);
  });

  it("replayLocks: force-release after 3s", () => {
    vi.useFakeTimers();
    useDebugStore.getState().tryAcquireLock("graph:rebuild");
    vi.advanceTimersByTime(3_100);
    const a = useDebugStore.getState().tryAcquireLock("graph:rebuild");
    expect(a).toBe(true);
    vi.useRealTimers();
  });
});
