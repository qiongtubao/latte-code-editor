import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGoToDef, type Location } from "../src/useGoToDef.js";

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
    expect((loc as Location | null)?.file).toBe("src/a.ts");
    expect((loc as Location | null)?.line).toBe(10);
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
    let p: Promise<unknown>;
    act(() => { p = result.current.onSymbolClick("foo"); });
    expect(result.current.busy).toBe(true);
    await act(async () => { resolveInvoke({ file: "x", line: 1, col: 0 }); await p; });
    expect(result.current.busy).toBe(false);
  });
});
