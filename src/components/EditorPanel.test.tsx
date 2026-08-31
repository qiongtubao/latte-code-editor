import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../hooks/useEditorStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { EditorPanel } from "./EditorPanel";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../api/commands", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
}));
vi.mock("./LazyEditorViewers", () => ({
  preloadCodeEditor: vi.fn().mockResolvedValue(undefined),
  preloadMarkdownPreview: vi.fn().mockResolvedValue(undefined),
  shouldPreloadCodeEditor: vi.fn().mockReturnValue(false),
  LazyCodeEditor: ({ content }: { content: string }) => <div>source:{content}</div>,
  LazyMarkdownPreview: ({ content }: { content: string }) => <div>preview:{content}</div>,
  LazyLargeFileMode: ({ file }: { file: { path: string } }) => <div>large:{file.path}</div>,
}));

function file(path: string, content: string, isLarge = false) {
  return {
    path,
    content,
    line_count: 1,
    is_large_file: isLarge,
    is_modified: false,
  };
}

describe("EditorPanel conditional viewers", () => {
  beforeEach(() => {
    useEditorStore.setState({
      byWorkspace: {},
      tabs: [],
      activeIndex: 0,
      openFile: null,
      currentContent: "",
      tabState: "empty",
      modified: false,
      filePath: null,
      cursorWord: "",
      targetLine: null,
      targetColumn: null,
      markdownMode: "preview",
    });
    useWorkspaceStore.setState({
      workspaces: {},
      activeWorkspaceId: "ws-editor-panel",
      windowMappings: {},
      hydrated: true,
    });
  });

  it("switches Markdown between lazy preview and CodeMirror source", () => {
    useEditorStore.getState().openFileOrSwitch(file("/repo/readme.md", "# title"));
    render(<EditorPanel />);

    expect(screen.getByText("preview:# title")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText("source:# title")).toBeTruthy();
    expect(screen.queryByText("preview:# title")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("preview:# title")).toBeTruthy();
  });

  it("routes ordinary code files to the lazy CodeMirror editor", () => {
    useEditorStore.getState().openFileOrSwitch(file("/repo/main.ts", "const x = 1"));
    render(<EditorPanel />);
    expect(screen.getByText("source:const x = 1")).toBeTruthy();
  });

  it("routes large files to the lazy paged viewer", () => {
    useEditorStore.getState().openFileOrSwitch(file("/repo/big.log", "", true));
    render(<EditorPanel />);
    expect(screen.getByText("large:/repo/big.log")).toBeTruthy();
  });
});
