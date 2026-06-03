import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  useSave,
  type OpenFile,
  type MonacoEditorLike,
  type UseSaveReturn,
} from "./useSave.js";

const mockInvoke = vi.mocked(invoke);

// `tauri-plugin-dialog@2.7.1` 的 Rust 端 IPC 只有 `open` / `save` /
// `message` 三个 handler — `ask` / `confirm` 命令已被合并到 `message`,
// `useSave` 直接 `invoke("plugin:dialog|message", ...)`。jsdom 里
// 没法真弹原生 dialog,测试通过 `mockInvoke` 配 `plugin:dialog|message`
// 的返回值来模拟用户点哪个按钮。
//
// **结果值的形状是 `buttons` 决定的**(见 useSave.ts 的注释):
//   - `OkCancelCustom("Discard","Cancel")` → 用户点 "Discard" 返
//     `"Discard"`(rfd 走 `Custom(label)`),点 "Cancel" 返 `"Cancel"`
//   - `OkCancel`(无自定义)→ 点 ok 返 `"Ok"`,cancel 返 `"Cancel"`
//   - 按 ESC / 关窗 → 总是 `"Cancel"`
//
// `useSave.requestFileSwitch` 用 `result !== "Cancel"` 判定放行,
// 所以测试也按这个语义来:"用户接受了" = 任何非 `"Cancel"`(用
// `"Discard"` 模拟最贴近真实)。
//
// 默认所有 `plugin:dialog|message` 调用返 `"Cancel"` — 让 clean path
// 测试不需要关心;dirty + accept 测试用 `mockResolveMessageOnce("Discard")`
// 显式排队一次。
const mockResolveMessageOnce = (result: "Ok" | "Cancel" | "Discard" | "Yes") => {
  mockInvoke.mockImplementationOnce(async (cmd: string) => {
    if (cmd === "plugin:dialog|message") return result;
    return undefined;
  });
};

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    path: "a.ts",
    name: "a.ts",
    content: "hello",
    savedContent: "hello",
    language: "typescript",
    ...overrides,
  };
}

/**
 * Render a host that wires the file state through `useSave` and exposes
 * the latest hook return via a mutable ref, so tests can drive it
 * without coupling to the host's React tree. The imperative handle
 * stub is shared across all tests; tests that need to assert on
 * `syncSavedContent` calls inspect the spy directly.
 */
function renderUseSave(
  initialFile: OpenFile | null,
  handle: MonacoEditorLike = { syncSavedContent: vi.fn() },
) {
  const bag: {
    file: OpenFile | null;
    setFile: Dispatch<SetStateAction<OpenFile | null>>;
    hookResult: UseSaveReturn | null;
    monacoRef: RefObject<MonacoEditorLike | null>;
  } = {
    file: initialFile,
    setFile: () => {},
    hookResult: null,
    monacoRef: { current: handle },
  };
  function Host() {
    const [file, setFile] = useState<OpenFile | null>(initialFile);
    bag.file = file;
    bag.setFile = setFile;
    const ref = useRef<MonacoEditorLike | null>(handle);
    bag.monacoRef = ref;
    bag.hookResult = useSave({ file, setFile, monacoRef: ref });
    return null;
  }
  render(<Host />);
  return bag;
}

describe("useSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("handleSave success: invokes cmd_write_file, calls syncSavedContent, cycles saveStatus saving→saved→idle", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const syncSpy = vi.fn();
    const bag = renderUseSave(
      makeFile({ content: "new", savedContent: "old" }),
      { syncSavedContent: syncSpy },
    );

    // Simulate the editor reporting dirty (MonacoEditor fires this
    // from onDidChangeModelContent when value !== savedContent).
    act(() => { bag.hookResult!.setDirty(true); });
    expect(bag.hookResult!.dirty).toBe(true);

    // Fire the save. handleSave awaits the invoke; the await needs
    // a microtask flush inside act.
    await act(async () => {
      await bag.hookResult!.handleSave();
    });

    expect(mockInvoke).toHaveBeenCalledWith("cmd_write_file", {
      path: "a.ts",
      content: "new",
    });
    // C2 fix: imperative handle called synchronously before setFile.
    expect(syncSpy).toHaveBeenCalledWith("new");
    // After the await, the hook has transitioned to "saved" and
    // scheduled the 2s timer to flip to "idle".
    expect(bag.hookResult!.saveStatus).toBe("saved");

    // Fast-forward 2s — status should drop back to "idle".
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(bag.hookResult!.saveStatus).toBe("idle");
  });

  it("handleSave failure: surfaces editorBanner and returns saveStatus to idle", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("disk full"));
    const bag = renderUseSave(makeFile());

    await act(async () => {
      await bag.hookResult!.handleSave();
    });

    expect(bag.hookResult!.editorBanner).toMatch(/save failed:.*disk full/);
    expect(bag.hookResult!.saveStatus).toBe("idle");
    // 5s auto-dismiss for the banner.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(bag.hookResult!.editorBanner).toBeNull();
  });

  it("requestFileSwitch: clean state runs swap immediately without asking", async () => {
    const swap = vi.fn();
    const bag = renderUseSave(makeFile());
    act(() => { bag.hookResult!.setDirty(false); });

    await act(async () => {
      bag.hookResult!.requestFileSwitch(swap);
    });

    expect(swap).toHaveBeenCalledTimes(1);
    // No `plugin:dialog|message` should have been invoked on the clean
    // path (no confirm needed).
    const dialogCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "plugin:dialog|message",
    );
    expect(dialogCalls).toHaveLength(0);
  });

  it("requestFileSwitch: dirty + accept runs swap", async () => {
    const swap = vi.fn();
    // 用户点 "Discard" 按钮 — Rust 走 `rfd::Custom("Discard")` 路径,
    // 序列化成 inner 字符串 `"Discard"`(不是 `"Ok"`,后者是
    // `OkCancel` 无自定义按钮的 wire 形式)。
    mockResolveMessageOnce("Discard");
    const bag = renderUseSave(makeFile());
    act(() => { bag.hookResult!.setDirty(true); });

    await act(async () => {
      bag.hookResult!.requestFileSwitch(swap);
    });

    expect(mockInvoke).toHaveBeenCalledWith("plugin:dialog|message", {
      title: "Unsaved changes",
      message: "Discard unsaved changes?",
      kind: "warning",
      buttons: { OkCancelCustom: ["Discard", "Cancel"] },
    });
    expect(swap).toHaveBeenCalledTimes(1);
  });

  it("requestFileSwitch: dirty + cancel blocks swap", async () => {
    const swap = vi.fn();
    mockResolveMessageOnce("Cancel");
    const bag = renderUseSave(makeFile());
    act(() => { bag.hookResult!.setDirty(true); });

    await act(async () => {
      bag.hookResult!.requestFileSwitch(swap);
    });

    expect(mockInvoke).toHaveBeenCalledWith("plugin:dialog|message", expect.any(Object));
    expect(swap).not.toHaveBeenCalled();
  });

  it("dirty resets to false when file becomes null (workspace closed)", () => {
    const bag = renderUseSave(makeFile());
    act(() => { bag.hookResult!.setDirty(true); });
    expect(bag.hookResult!.dirty).toBe(true);

    act(() => { bag.setFile(null); });
    expect(bag.hookResult!.dirty).toBe(false);
  });
});
