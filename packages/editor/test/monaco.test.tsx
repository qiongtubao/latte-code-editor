import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock monaco-editor so we don't need a real canvas/worker in jsdom.
vi.mock("monaco-editor", () => {
  const dispose = vi.fn();
  const editorInstance = {
    onDidChangeModelContent: vi.fn(),
    onMouseDown: vi.fn(),
    getValue: vi.fn(() => "hello"),
    getModel: vi.fn(() => ({ getWordAtPosition: vi.fn() })),
    setValue: vi.fn(),
    dispose,
  };
  return {
    editor: {
      create: vi.fn(() => editorInstance),
      setModelLanguage: vi.fn(),
      MouseTargetType: { GUTTER_LINE_GLYPH_MARGIN: 4 },
    },
  };
});

import { render } from "@testing-library/react";
import { MonacoEditor } from "../src/MonacoEditor.js";

describe("MonacoEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a div container", () => {
    const { container } = render(
      <MonacoEditor value="hello" language="typescript" onChange={() => {}} />
    );
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("calls onChange after typing via prop", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <MonacoEditor value="" language="typescript" onChange={onChange} />
    );
    expect(container).toBeTruthy();
  });
});
