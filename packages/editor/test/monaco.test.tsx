import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// Hoist the editor-instance ref so the mock factory and the tests can share it.
const mock = vi.hoisted(() => {
  const state: { changeCallback: (() => void) | null } = { changeCallback: null };
  const editorInstance = {
    onDidChangeModelContent: vi.fn((cb: () => void) => { state.changeCallback = cb; }),
    onMouseDown: vi.fn(),
    getValue: vi.fn(() => "typed-value"),
    getModel: vi.fn(() => ({ getWordAtPosition: vi.fn() })),
    setValue: vi.fn(),
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
}));

import { MonacoEditor } from "../src/MonacoEditor.js";

describe("MonacoEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.state.changeCallback = null;
  });

  it("renders a div container", () => {
    const { container } = render(
      <MonacoEditor value="hello" language="typescript" onChange={() => {}} />
    );
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("calls onChange when the model content changes", async () => {
    const onChange = vi.fn();
    render(
      <MonacoEditor value="" language="typescript" onChange={onChange} />
    );
    await waitFor(() => expect(mock.state.changeCallback).toBeTypeOf("function"));
    mock.state.changeCallback!();
    expect(onChange).toHaveBeenCalledWith("typed-value");
  });

  it("disposes the editor on unmount", () => {
    const { unmount } = render(
      <MonacoEditor value="" language="typescript" onChange={() => {}} />
    );
    expect(mock.editorInstance.dispose).not.toHaveBeenCalled();
    unmount();
    expect(mock.editorInstance.dispose).toHaveBeenCalledTimes(1);
  });
});
