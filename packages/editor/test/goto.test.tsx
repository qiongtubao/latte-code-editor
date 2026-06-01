import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGoToDef, type GoToLocation } from "../src/useGoToDef.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { vi.clearAllMocks(); });

describe("useGoToDef", () => {
  it("returns a location on click", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ file: "src/a.ts", line: 10, col: 0 });
    const { result } = renderHook(() => useGoToDef());
    const loc = await act(async () => result.current.onSymbolClick("foo"));
    expect(loc).not.toBeNull();
    expect((loc as GoToLocation | null)?.file).toBe("src/a.ts");
    expect((loc as GoToLocation | null)?.line).toBe(10);
    expect(invoke).toHaveBeenCalledWith("cmd_definition", { symbol: "foo" });
  });

  it("flips busy true→false around the call", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    let resolveInvoke: (v: unknown) => void = () => {};
    (invoke as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(r => { resolveInvoke = r; })
    );
    const { result } = renderHook(() => useGoToDef());
    expect(result.current.busy).toBe(false);
    let p: Promise<unknown> = Promise.resolve();
    await act(async () => { p = result.current.onSymbolClick("foo"); });
    expect(result.current.busy).toBe(true);
    await act(async () => { resolveInvoke({ file: "x", line: 1, col: 0 }); await p; });
    expect(result.current.busy).toBe(false);
  });

  it("clears busy and propagates the rejection on IPC failure", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useGoToDef());
    expect(result.current.busy).toBe(false);
    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.onSymbolClick("foo");
      } catch (e) { caught = e; }
    });
    expect(result.current.busy).toBe(false);
    expect((caught as Error | null)?.message).toBe("boom");
  });
});
