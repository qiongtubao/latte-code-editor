import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import * as React from "react";

// Hoist the editor-instance ref so the mock factory and the tests can share it.
const mock = vi.hoisted(() => {
  const state: {
    changeCallback: (() => void) | null;
    saveCommand: (() => void) | null;
  } = { changeCallback: null, saveCommand: null };
  const editorInstance = {
    onDidChangeModelContent: vi.fn((cb: () => void) => { state.changeCallback = cb; }),
    onMouseDown: vi.fn(),
    getValue: vi.fn(() => "typed-value"),
    getModel: vi.fn(() => ({ getWordAtPosition: vi.fn() })),
    setValue: vi.fn(),
    revealLineInCenterIfOutsideViewport: vi.fn(),
    updateOptions: vi.fn(),
    addCommand: vi.fn((_keybinding: number, handler: () => void) => {
      state.saveCommand = handler;
      return "save-cmd-id";
    }),
    dispose: vi.fn(),
  };
  return { state, editorInstance };
});

vi.mock("monaco-editor", () => ({
  editor: {
    create: vi.fn(() => mock.editorInstance),
    setModelLanguage: vi.fn(),
    MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
  },
  languages: {
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
  },
  KeyMod: { CtrlCmd: 1 << 11 },
  KeyCode: { KeyS: 49 },
}));

import { MonacoEditor, type MonacoEditorHandle } from "../src/MonacoEditor.js";

describe("MonacoEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.state.changeCallback = null;
    mock.state.saveCommand = null;
  });

  it("renders a div container", () => {
    const { container } = render(
      <MonacoEditor
        value="hello"
        language="typescript"
        path={null}
        savedContent="hello"
        onChange={() => {}}
        onSave={() => {}}
      />
    );
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("calls onChange when the model content changes", async () => {
    const onChange = vi.fn();
    render(
      <MonacoEditor
        value=""
        language="typescript"
        path={null}
        savedContent=""
        onChange={onChange}
        onSave={() => {}}
      />
    );
    await waitFor(() => expect(mock.state.changeCallback).toBeTypeOf("function"));
    mock.state.changeCallback!();
    expect(onChange).toHaveBeenCalledWith("typed-value");
  });

  it("disposes the editor on unmount", () => {
    const { unmount } = render(
      <MonacoEditor
        value=""
        language="typescript"
        path={null}
        savedContent=""
        onChange={() => {}}
        onSave={() => {}}
      />
    );
    expect(mock.editorInstance.dispose).not.toHaveBeenCalled();
    unmount();
    expect(mock.editorInstance.dispose).toHaveBeenCalledTimes(1);
  });

  it("registers CtrlCmd+S as a save command that calls onSave", async () => {
    const onSave = vi.fn();
    render(
      <MonacoEditor
        value=""
        language="typescript"
        path={null}
        savedContent=""
        onChange={() => {}}
        onSave={onSave}
      />
    );
    // Wait for the mount effect to register the command.
    await waitFor(() => {
      expect(mock.editorInstance.addCommand).toHaveBeenCalledTimes(1);
    });
    // The keybinding should be CtrlCmd | KeyS (matches the host's Cmd+S
    // on macOS and Ctrl+S on Windows/Linux — Monaco normalises the modifier).
    const keybinding = mock.editorInstance.addCommand.mock.calls[0][0];
    expect(keybinding).toBe((1 << 11) | 49);
    // Fire the registered command — must call onSave.
    expect(mock.state.saveCommand).toBeTypeOf("function");
    mock.state.saveCommand!();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("MonacoEditor.revealLine", () => {
  beforeEach(() => {
    mock.editorInstance.revealLineInCenterIfOutsideViewport.mockClear();
    mock.editorInstance.updateOptions.mockClear();
  });

  it("scrolls to the requested line on the next value tick, then clears pending", () => {
    const ref = React.createRef<MonacoEditorHandle>();
    const { rerender } = render(
      <MonacoEditor
        ref={ref}
        value="a"
        language="plaintext"
        path="a.txt"
        savedContent="a"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    act(() => { ref.current?.revealLine(42); });
    // The reveal hasn't fired yet — the effect waits for the next [value, ...] tick.
    expect(mock.editorInstance.revealLineInCenterIfOutsideViewport).not.toHaveBeenCalled();

    rerender(
      <MonacoEditor
        ref={ref}
        value="b"          // value changed
        language="plaintext"
        path="a.txt"
        savedContent="a"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    // The effect ran; revealLineInCenterIfOutsideViewport called once with 42.
    expect(mock.editorInstance.revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
    expect(mock.editorInstance.revealLineInCenterIfOutsideViewport).toHaveBeenCalledWith(42);

    // Re-render again with the same value (e.g. user types and onChange
    // bubbles back) — pending was cleared, no extra reveal.
    rerender(
      <MonacoEditor
        ref={ref}
        value="b"
        language="plaintext"
        path="a.txt"
        savedContent="a"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(mock.editorInstance.revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
  });
});

describe("MonacoEditor.readOnly", () => {
  it("forwards readOnly to editor.updateOptions", () => {
    const ref = React.createRef<MonacoEditorHandle>();
    render(
      <MonacoEditor
        ref={ref}
        value="x"
        language="plaintext"
        path="x.txt"
        savedContent="x"
        onChange={() => {}}
        onSave={() => {}}
        readOnly
      />,
    );
    expect(mock.editorInstance.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });
});
