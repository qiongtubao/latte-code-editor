import { Profiler } from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../hooks/useEditorStore";
import { useGraphStore } from "../hooks/useGraphStore";
import type { GraphData } from "../hooks/graphTypes";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { OutlinePanel } from "./OutlinePanel";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api/commands", () => ({
  openFile: vi.fn(),
}));
vi.mock("../api/screenshot", () => ({
  screenshotWindow: vi.fn(),
  copyScreenshotToClipboard: vi.fn(),
}));
vi.mock("./LspStatusBar", () => ({
  LspStatusBar: () => <span>LSP</span>,
}));
vi.mock("./graphRenderer", () => ({
  NODE_COLORS: ["#000", "#111", "#222", "#333", "#444", "#555", "#666", "#777"],
}));

const testFile = {
  path: "/repo/src/main.ts",
  content: "const value = 1;",
  line_count: 1,
  is_large_file: false,
  is_modified: false,
};

const graphData: GraphData = {
  nodes: [{
    id: "main",
    kind: "function",
    name: "main",
    qualified_name: "main",
    file_path: testFile.path,
    language: "ts",
    start_line: 1,
    end_line: 1,
    signature: null,
  }],
  edges: [],
  stats: { total_nodes: 1, total_edges: 0, node_kinds: [], edge_kinds: [] },
};

function resetStores() {
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
  useGraphStore.setState({
    byWorkspace: {},
    graphData: null,
    loading: false,
    error: null,
    simNodes: [],
    simEdges: [],
    selectedNodeId: null,
    hoveredNodeId: null,
    highlightedNodeIds: new Set(),
    loadVersion: 0,
  });
  useWorkspaceStore.setState({
    workspaces: {},
    activeWorkspaceId: "subscription-performance",
    windowMappings: {},
    hydrated: true,
  });
}

function renderWithCommitCounter(id: string, child: React.ReactNode) {
  let commits = 0;
  render(
    <Profiler id={id} onRender={() => { commits += 1; }}>
      {child}
    </Profiler>,
  );
  return () => commits;
}

describe("high-frequency Zustand subscriptions", () => {
  beforeEach(resetStores);

  it("does not rerender TabBar after the modified marker is already set", () => {
    useEditorStore.getState().openFileOrSwitch(testFile);
    const commits = renderWithCommitCounter("tab-bar", <TabBar />);

    act(() => useEditorStore.getState().setContent("const value = 2;"));
    const afterModifiedMarker = commits();
    expect(afterModifiedMarker).toBeGreaterThan(1);

    act(() => useEditorStore.getState().setContent("const value = 3;"));
    expect(commits()).toBe(afterModifiedMarker);
  });

  it("does not rerender StatusBar when only modified file content changes", () => {
    useEditorStore.getState().openFileOrSwitch(testFile);
    useEditorStore.getState().setContent("const value = 2;");
    const commits = renderWithCommitCounter(
      "status-bar",
      <StatusBar onToggleSettings={() => undefined} />,
    );
    const initialCommits = commits();

    act(() => useEditorStore.getState().setContent("const value = 3;"));
    expect(commits()).toBe(initialCommits);
  });

  it("does not rerender OutlinePanel for graph simulation ticks", () => {
    useEditorStore.getState().openFileOrSwitch(testFile);
    useGraphStore.getState().setGraphData(graphData);
    const commits = renderWithCommitCounter("outline", <OutlinePanel />);
    expect(screen.getByText("main")).toBeTruthy();
    const initialCommits = commits();

    act(() => useGraphStore.getState().setSimResult({
      nodes: [{ id: "main", x: 20, y: 30, vx: 1, vy: 1, group: 1 }],
      edges: [],
    }));
    expect(commits()).toBe(initialCommits);
  });
});
