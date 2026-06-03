import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import type { RefObject } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useSymbolNavigation } from "./useSymbolNavigation.js";
import type { MonacoEditorHandle } from "@latte/editor";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

function makeHandle(): RefObject<MonacoEditorHandle> {
  return { current: { syncSavedContent: vi.fn(), revealLine: vi.fn() } };
}

function renderHook(opts: {
  initialPath?: string;
  workspace?: string | null;
  dirty?: boolean;
} = {}) {
  const bag: {
    drawerSymbol: string | null;
    onSymbolClick: (s: string) => void;
    onJump: (n: { name: string; file: string; line: number; role: "caller" | "callee" }) => void;
    closeDrawer: () => void;
    setFile: ReturnType<typeof vi.fn>;
    setEditorBanner: ReturnType<typeof vi.fn>;
    requestFileSwitch: ReturnType<typeof vi.fn>;
    revealLineSpy: ReturnType<typeof vi.fn>;
  } = {
    drawerSymbol: null,
    onSymbolClick: () => {},
    onJump: () => {},
    closeDrawer: () => {},
    setFile: vi.fn(),
    setEditorBanner: vi.fn(),
    requestFileSwitch: vi.fn().mockImplementation((thunk: () => void) => thunk()),
    revealLineSpy: vi.fn(),
  };
  bag.revealLineSpy = bag.revealLineSpy; // silence linter

  function Host() {
    const [file, setFileState] = useState<{ path: string; content: string; isReadOnly?: boolean } | null>(
      opts.initialPath ? { path: opts.initialPath, content: "" } : null,
    );
    const monacoRef = makeHandle();
    // Patch the handle to use the revealLine spy.
    monacoRef.current!.revealLine = bag.revealLineSpy as never;

    const nav = useSymbolNavigation({
      file,
      setFile: bag.setFile,
      monacoRef,
      workspace: opts.workspace ?? "/ws",
      requestFileSwitch: bag.requestFileSwitch as never,
      setEditorBanner: bag.setEditorBanner,
    });
    bag.drawerSymbol = nav.drawerSymbol;
    bag.onSymbolClick = nav.onSymbolClick;
    bag.onJump = nav.onJump;
    bag.closeDrawer = nav.closeDrawer;
    // keep TS happy about an unused state setter
    void setFileState;
    return null;
  }
  render(<Host />);
  return bag;
}

describe("useSymbolNavigation", () => {
  it("onSymbolClick sets drawerSymbol; does not setFile", () => {
    const bag = renderHook();
    act(() => { bag.onSymbolClick("foo"); });
    expect(bag.drawerSymbol).toBe("foo");
    expect(bag.setFile).not.toHaveBeenCalled();
  });

  it("onJump: cmd_read_file → setFile → revealLine, in order", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "cmd_read_file") return "the content";
      return null;
    });
    const bag = renderHook({ initialPath: "a.ts" });
    await act(async () => {
      bag.onJump({ name: "foo", file: "b.ts", line: 42, role: "callee" });
    });
    expect(mockInvoke).toHaveBeenCalledWith("cmd_read_file", { path: "b.ts" });
    expect(bag.setFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "b.ts",
      content: "the content",
      isReadOnly: expect.any(Boolean),
    }));
    expect(bag.revealLineSpy).toHaveBeenCalledWith(42);
    // Order: cmd_read_file before setFile before revealLine
    const order = [
      mockInvoke.mock.invocationCallOrder[0],
      bag.setFile.mock.invocationCallOrder[0],
      bag.revealLineSpy.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("onJump is guarded by requestFileSwitch", async () => {
    let accept = false;
    const bag = renderHook({ initialPath: "a.ts" });
    bag.requestFileSwitch.mockImplementation((thunk: () => void) => {
      if (accept) thunk();
    });
    mockInvoke.mockResolvedValue("c");
    await act(async () => { bag.onJump({ name: "f", file: "b.ts", line: 1, role: "callee" }); });
    // requestFileSwitch was called; cmd_read_file was NOT (because thunk didn't run).
    expect(bag.requestFileSwitch).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_read_file", expect.anything());

    // Accept this time.
    accept = true;
    await act(async () => { bag.onJump({ name: "f", file: "b.ts", line: 1, role: "callee" }); });
    expect(mockInvoke).toHaveBeenCalledWith("cmd_read_file", { path: "b.ts" });
  });

  it("onJump on currently-open file: skip setFile and cmd_read_file, just revealLine", async () => {
    const bag = renderHook({ initialPath: "a.ts" });
    await act(async () => {
      bag.onJump({ name: "f", file: "a.ts", line: 7, role: "caller" });
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_read_file", expect.anything());
    expect(bag.setFile).not.toHaveBeenCalled();
    expect(bag.revealLineSpy).toHaveBeenCalledWith(7);
  });

  it("onJump on read failure: setEditorBanner; no setFile", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not found"));
    const bag = renderHook({ initialPath: "a.ts" });
    await act(async () => {
      bag.onJump({ name: "f", file: "missing.ts", line: 1, role: "callee" });
    });
    expect(bag.setEditorBanner).toHaveBeenCalledWith(expect.stringMatching(/open failed: missing\.ts.*not found/));
    expect(bag.setFile).not.toHaveBeenCalled();
    expect(bag.revealLineSpy).not.toHaveBeenCalled();
  });
});
