import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the onDidChangeModelContent callback so we can fire it in tests.
let changeCallback: (() => void) | null = null;

// Mock monaco-editor so we don't need a real canvas/worker in jsdom.
vi.mock("monaco-editor", () => {
  const dispose = vi.fn();
  const editorInstance = {
    onDidChangeModelContent: vi.fn((cb: () => void) => { changeCallback = cb; }),
    onMouseDown: vi.fn(),
    getValue: vi.fn(() => "typed-value"),
    getModel: vi.fn(() => ({ getWordAtPosition: vi.fn() })),
    setValue: vi.fn(),
    dispose,
  };
  return {
    editor: {
      create: vi.fn(() => editorInstance),
      setModelLanguage: vi.fn(),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
    },
  };
});

import { render } from "@testing-library/react";
import { MonacoEditor } from "../src/MonacoEditor.js";

describe("MonacoEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    changeCallback = null;
  });

  it("renders a div container", () => {
    const { container } = render(
      <MonacoEditor value="hello" language="typescript" onChange={() => {}} />
    );
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("calls onChange when the model content changes", () => {
    const onChange = vi.fn();
    render(
      <MonacoEditor value="" language="typescript" onChange={onChange} />
    );
    expect(changeCallback).not.toBeNull();
    changeCallback!();
    expect(onChange).toHaveBeenCalledWith("typed-value");
  });
});
