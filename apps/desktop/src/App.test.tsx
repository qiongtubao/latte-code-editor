import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

// --- Tauri API mocks -----------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The App listens to "workspace-changed" via tauri::listen. We capture
// the handler so tests can fire the event manually.
let listenHandler: (() => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: () => void) => {
    listenHandler = handler;
    return Promise.resolve(() => {});
  }),
}));

// `tauri-plugin-dialog@2.7.1` 的 Rust 端 IPC 只剩 `open` / `save` /
// `message` 三个 handler — `useSave` 直接
// `invoke("plugin:dialog|message", ...)` 走原生命令面板。jsdom 里
// 没法真弹,这里把"未配"的 message 调用默认返 `"Cancel"`,让 dirty +
// 未 accept 的测试自然走到 cancel 分支;需要 accept 的测试用
// `mockResolveMessageOnce("Ok")` 排队下一次 message 调用的结果。
//
// 用 flag 而不是 `mockImplementationOnce` 是因为 `onFileOpen` 先打
// `cmd_read_file` 才走到 `requestFileSwitch` → message,一连串 invoke
// 里 `mockImplementationOnce` 会被错配的非 message 调用消费。
let nextMessageResult: "Ok" | "Cancel" | null = null;
const mockResolveMessageOnce = (result: "Ok" | "Cancel") => {
  nextMessageResult = result;
};

// --- MonacoEditor mock ----------------------------------------------------
//
// App.tsx renders <MonacoEditor ref={monacoRef} ...> with a number of
// callbacks (onChange, onSave, onDirtyChange, onSymbolClick). The real
// component pulls in monaco-editor which can't run under jsdom, so we
// stub it: capture the latest props so tests can drive the callbacks,
// and expose a `syncSavedContent` imperative handle that the test can
// assert against (C2 fix verification).

const mockImperativeHandle = { syncSavedContent: vi.fn() };
const mockMonacoProps: { current: Record<string, unknown> | null } = {
  current: null,
};

import * as React from "react";
vi.mock("@latte/editor", () => ({
  MonacoEditor: React.forwardRef(function MockMonaco(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    mockMonacoProps.current = props;
    React.useImperativeHandle(ref, () => mockImperativeHandle, []);
    return React.createElement("div", {
      "data-testid": "mock-monaco",
      "data-value": props.value as string,
      "data-saved-content": props.savedContent as string,
    });
  }),
  // Minimal Drawer stub: re-uses the real <section data-testid="drawer">
  // shape so the new out-of-workspace test can query the rows. We don't
  // pull in the real module because it invokes `cmd_call_hierarchy` on
  // mount — the test would have to thread that mock through anyway, and
  // a tiny in-test stub is simpler than partial-mocking `importOriginal`.
  Drawer: (props: { symbol: string | null; onClose: () => void; onJump: (n: unknown) => void }) => {
    if (props.symbol === null) return null;
    return React.createElement(
      "section",
      { "data-testid": "drawer" },
      React.createElement("div", {
        "data-testid": "drawer-row",
        onClick: () => props.onJump({ name: "f", file: "/usr/local/lib/typescript.d.ts", line: 1, role: "callee" }),
      }),
    );
  },
}));

import { invoke } from "@tauri-apps/api/core";
import App from "./App.js";
const mockInvoke = vi.mocked(invoke);

function setupDefaultMocks() {
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const path = (args as { path?: string } | undefined)?.path;
    switch (cmd) {
      case "cmd_get_workspace": return "/ws";
      case "cmd_user_hook": return { css: null, js: null };
      case "cmd_list_dir": return [
        { name: "a.ts", path: "a.ts", isDir: false },
        { name: "b.ts", path: "b.ts", isDir: false },
      ];
      case "cmd_read_file": {
        if (path === "a.ts") return "content of a";
        if (path === "b.ts") return "content of b";
        return "default content";
      }
      case "cmd_definition": return null;
      case "plugin:dialog|message": {
        // Consume the override (if any) and clear it, so subsequent
        // dirty-switch attempts in the same test default back to
        // "Cancel" unless re-armed.
        if (nextMessageResult !== null) {
          const r = nextMessageResult;
          nextMessageResult = null;
          return r;
        }
        return "Cancel";
      }
      default: return null;
    }
  });
}

beforeEach(() => {
  nextMessageResult = null;
  setupDefaultMocks();
  listenHandler = null;
  mockMonacoProps.current = null;
  mockImperativeHandle.syncSavedContent.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App save mechanism integration", () => {
  it("read failure: shows editor banner, no fake file content, no MonacoEditor", async () => {
    // Override cmd_read_file to ALWAYS reject. The catch in
    // onFileOpen (App.tsx) sets the editor banner and leaves `file`
    // untouched, so the previously-open file is still shown (and in
    // the initial state, no file is open, so the placeholder stays).
    // We re-install the full default impl (instead of mockRejectedValueOnce
    // on cmd_read_file) so the earlier cmd_get_workspace / cmd_list_dir /
    // cmd_user_hook calls still resolve and FileTree actually renders
    // the a.ts row we want to click.
    mockInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "cmd_get_workspace": return "/ws";
        case "cmd_user_hook": return { css: null, js: null };
        case "cmd_list_dir": return [
          { name: "a.ts", path: "a.ts", isDir: false },
          { name: "b.ts", path: "b.ts", isDir: false },
        ];
        case "cmd_read_file": throw new Error("invalid utf-8 sequence");
        case "cmd_definition": return null;
        default: return null;
      }
    });

    const { findByTestId, getByTestId, queryByTestId, queryByText } = render(<App />);
    await findByTestId("tree-row-a.ts");

    fireEvent.click(getByTestId("tree-row-a.ts"));

    const banner = await findByTestId("editor-banner");
    expect(banner.textContent).toMatch(/read failed: a\.ts.*invalid utf-8 sequence/);
    // MonacoEditor must NOT have mounted (file is still null).
    expect(queryByTestId("mock-monaco")).toBeNull();
    // The old "// failed to read" text from the previous App.tsx is gone.
    expect(queryByText(/failed to read/)).toBeNull();
  });

  it("dirty + click another file: confirm=false blocks; confirm=true swaps", async () => {
    const { findByTestId, getByTestId } = render(<App />);
    await findByTestId("tree-row-a.ts");

    // Open a.ts.
    fireEvent.click(getByTestId("tree-row-a.ts"));
    await findByTestId("mock-monaco");
    expect(getByTestId("mock-monaco").getAttribute("data-value")).toBe("content of a");

    // Mark the file dirty via the captured onDirtyChange callback.
    act(() => {
      (mockMonacoProps.current!.onDirtyChange as (d: boolean) => void)(true);
    });

    // First swap attempt: user cancels (default `plugin:dialog|message`
    // mock returns "Cancel" — no need to queue anything). File should
    // stay on a.ts.
    fireEvent.click(getByTestId("tree-row-b.ts"));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("plugin:dialog|message", expect.objectContaining({
        message: "Discard unsaved changes?",
        title: "Unsaved changes",
      }));
    });
    expect(getByTestId("mock-monaco").getAttribute("data-value")).toBe("content of a");
    // And the (unchanged) savedContent for a.ts is "content of a".
    expect(getByTestId("mock-monaco").getAttribute("data-saved-content")).toBe("content of a");

    // Second swap attempt: user accepts. File should switch to b.ts.
    mockResolveMessageOnce("Ok");
    fireEvent.click(getByTestId("tree-row-b.ts"));
    await waitFor(() => {
      expect(getByTestId("mock-monaco").getAttribute("data-value")).toBe("content of b");
    });
    expect(getByTestId("mock-monaco").getAttribute("data-saved-content")).toBe("content of b");
  });

  it("dirty + workspace-changed: confirm=false blocks the workspace fetch", async () => {
    const { findByTestId, getByTestId } = render(<App />);
    await findByTestId("tree-row-a.ts");

    // Open a.ts so the App has an active file.
    fireEvent.click(getByTestId("tree-row-a.ts"));
    await findByTestId("mock-monaco");

    // Mark dirty.
    act(() => {
      (mockMonacoProps.current!.onDirtyChange as (d: boolean) => void)(true);
    });

    // The workspace-changed event is about to fire. With the user
    // choosing "discard? → cancel" (default mock returns "Cancel"),
    // App.tsx must NOT re-fetch the workspace. (Without
    // `requestFileSwitch`, the listener would immediately overwrite
    // `workspace` and clobber the active edit.)
    const callsBefore = mockInvoke.mock.calls.length;

    expect(listenHandler).toBeTypeOf("function");
    act(() => { listenHandler!(); });

    // Wait for the message promise to resolve + any post-confirm invoke.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("plugin:dialog|message", expect.any(Object));
    });
    await new Promise((r) => setTimeout(r, 20));
    const newCalls = mockInvoke.mock.calls.slice(callsBefore);
    const calledGetWorkspace = newCalls.some(([c]) => c === "cmd_get_workspace");
    expect(calledGetWorkspace).toBe(false);
  });

  it("out-of-workspace go-to: opens the file read-only with readOnly prop set", async () => {
    // Override the default mock: the default returns `null` for
    // `cmd_call_hierarchy`, which would leave the Drawer empty. We
    // also need a known read for the .d.ts path the Drawer row
    // references.
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      switch (cmd) {
        case "cmd_get_workspace": return "/ws";
        case "cmd_user_hook": return { css: null, js: null };
        case "cmd_list_dir": return [
          { name: "a.ts", path: "a.ts", isDir: false },
        ];
        case "cmd_read_file": {
          if (path === "a.ts") return "content of a";
          if (path === "/usr/local/lib/typescript.d.ts") return "declare const x: number;";
          return "default";
        }
        case "cmd_definition": return null;
        case "cmd_call_hierarchy": return [
          { name: "f", file: "/usr/local/lib/typescript.d.ts", line: 1, role: "callee" },
        ];
        case "plugin:dialog|message": return "Cancel";
        default: return null;
      }
    });

    const { findByTestId, getByTestId } = render(<App />);
    await findByTestId("tree-row-a.ts");
    fireEvent.click(getByTestId("tree-row-a.ts"));
    await findByTestId("mock-monaco");

    // Click a symbol in the editor — Drawer opens with the hierarchy.
    act(() => {
      (mockMonacoProps.current!.onSymbolClick as (s: string) => void)("f");
    });
    await waitFor(() => {
      expect(getByTestId("drawer")).toBeTruthy();
    });

    // Click the callee row in the Drawer — file opens, readOnly is true.
    const row = await waitFor(() => {
      const drawer = getByTestId("drawer");
      const rows = drawer.querySelectorAll("[data-testid='drawer-row']");
      if (rows.length === 0) throw new Error("no rows yet");
      return rows[0];
    });
    fireEvent.click(row);

    // The MonacoEditor's mockImperativeHandle is the same across renders
    // (we don't re-create it). The simplest signal that the out-of-workspace
    // jump landed: the editor received a new `value` matching the .d.ts
    // content. The `readOnly` prop itself is asserted via the status bar
    // text below.
    await waitFor(() => {
      expect(getByTestId("mock-monaco").getAttribute("data-value"))
        .toBe("declare const x: number;");
    });
    // Status bar surfaces `· read-only` when the active file's path is
    // outside the workspace.
    expect(getByTestId("status-bar").textContent).toMatch(/read-only/);
  });
});
