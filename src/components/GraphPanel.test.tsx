// GraphPanel 搜索-点击流程集成测试
//
// 回归覆盖：
// 1. 图谱搜索"类/方法"（kind !== "file"）双击结果时，要打开文件并跳转到 start_line。
//    旧实现只在 kind === "file" 分支调 openFile + openFileOrSwitch，symbol 节点
//    直接 terminate worker 就 return —— 文件打不开，行号也跳不过去。
// 2. 点击 symbol 结果**不能**把画布清空。
//    旧实现清掉 simResult 但 layout effect 不会重启（displayMode/focusedNodeId 没变），
//    canvas 就此变空白 —— 用户体感是"搜了一下整个图就没了"。
// 3. 点击 symbol 后图谱必须切到该节点的关联视图（focus subgraph），不能停在主视图。
//    之前只 setSelectedNode 不切 displayMode，结果用户在主图里根本找不到那个节点
//    （被 getDefaultSubgraph 过滤掉了）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Profiler } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useGraphStore } from "../hooks/useGraphStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { GraphPanel } from "./GraphPanel";
import type { GraphData } from "../hooks/graphTypes";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}));

// happy-dom 没有 Web Worker，全局替换成 no-op，立即回一个 layout（绕开 3s 兜底 timeout）。
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(msg: unknown) {
    const data = msg as { nodes?: Array<{ id: string; group: number }> };
    if (this.onmessage) {
      this.onmessage({
        data: {
          positions: new Float32Array((data.nodes ?? []).flatMap(() => [0, 0])),
        },
      } as MessageEvent);
    }
  }
  terminate() { /* no-op */ }
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as unknown as { Worker: typeof FakeWorker }).Worker = FakeWorker;

// class Foo 包含 method bar，让 main 视图的 getDefaultSubgraph 能把两个 sig 节点都拉进 simNodes。
// 否则 edges=[] 时 detectCommunities 拆出 3 个独立点，main 视图只显示最大 community 的 1 个节点。
const fakeGraph: GraphData = {
  nodes: [
    { id: "f:src/a.ts", kind: "file", name: "a.ts", qualified_name: "src/a.ts", file_path: "/repo/src/a.ts", language: "typescript", start_line: 1, end_line: 10, signature: null },
    { id: "c:src/a.ts:Foo", kind: "class", name: "Foo", qualified_name: "src/a.ts::Foo", file_path: "/repo/src/a.ts", language: "typescript", start_line: 3, end_line: 8, signature: "class Foo" },
    { id: "m:src/a.ts:Foo:bar", kind: "method", name: "bar", qualified_name: "src/a.ts::Foo::bar", file_path: "/repo/src/a.ts", language: "typescript", start_line: 5, end_line: 7, signature: "bar()" },
  ],
  edges: [
    { id: "e1", source: "c:src/a.ts:Foo", target: "m:src/a.ts:Foo:bar", kind: "contains", metadata: null },
  ],
  stats: { total_nodes: 3, total_edges: 1, node_kinds: [], edge_kinds: [] },
};

const burstGraph: GraphData = {
  nodes: Array.from({ length: 4 }, (_, index) => ({
    id: `fn:${index}`,
    kind: "function",
    name: `fn${index}`,
    qualified_name: `fn${index}`,
    file_path: `/repo/src/fn${index}.ts`,
    language: "typescript",
    start_line: index + 1,
    end_line: index + 1,
    signature: `fn${index}()`,
  })),
  edges: Array.from({ length: 3 }, (_, index) => ({
    id: `call:${index}`,
    source: `fn:${index}`,
    target: `fn:${index + 1}`,
    kind: "calls",
    metadata: null,
  })),
  stats: { total_nodes: 4, total_edges: 3, node_kinds: [], edge_kinds: [] },
};

const fakeFile = (path: string) => ({
  path,
  content: "// hello",
  line_count: 10,
  is_large_file: false,
  is_modified: false,
});

function setupInvokeMock() {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "graph_get_data") return { data: fakeGraph };
    if (cmd === "graph_search") {
      const q = String(args?.query ?? "").toLowerCase();
      const nodes = fakeGraph.nodes.filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.qualified_name.toLowerCase().includes(q) ||
          n.file_path.toLowerCase().includes(q),
      );
      return { nodes };
    }
    if (cmd === "open_file") return fakeFile(String(args?.path));
    return null;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  setupInvokeMock();
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
  });
  useWorkspaceStore.setState({
    workspaces: { "ws-1": { name: "demo", project_root: "/repo", open_tabs: [], active_tab: null, ui_state: { sidebar_width: 240, outline_width: 180, editor_flex: 0.5, sidebar_open: true, active_panel: "split", sidebar_panel: "explorer" }, last_used_at: 0 } },
    activeWorkspaceId: "ws-1",
    windowMappings: {},
    hydrated: true,
  });
});

describe("GraphPanel 搜索结果点击", () => {
  it("点击 file 节点会调用 open_file 并把 start_line 传给 openFileOrSwitch", async () => {
    render(<GraphPanel />);
    await waitFor(() => {
      expect(useGraphStore.getState().graphData?.nodes.length).toBe(3);
    });
    // 切到 files tab（symbols tab 会过滤掉 kind==="file"）
    fireEvent.click(screen.getByRole("button", { name: "files" }));
    const input = screen.getByPlaceholderText("Search files...");
    fireEvent.change(input, { target: { value: "a.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("graph_search", expect.objectContaining({ query: "a.ts" }));
    });
    // files tab 下搜 "a.ts" 只匹配 1 个 file 节点 → auto-select 直接打开文件
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/repo/src/a.ts" });
    });
    const ed = useEditorStore.getState();
    expect(ed.filePath).toBe("/repo/src/a.ts");
    expect(ed.targetLine).toBe(1);
  });

  it("点击 class 节点（symbol）也会打开文件并跳到 start_line（回归测试）", async () => {
    render(<GraphPanel />);
    await waitFor(() => {
      expect(useGraphStore.getState().graphData?.nodes.length).toBe(3);
    });
    // symbols tab 是默认；搜 "Foo" 拿到 class + method 两个结果（method qualified_name 也含 Foo）
    const input = screen.getByPlaceholderText("Search symbols...");
    fireEvent.change(input, { target: { value: "Foo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("graph_search", expect.objectContaining({ query: "Foo" }));
    });
    // 等结果渲染后再点（results.length > 1，不会走 auto-select）
    const fooRow = await screen.findByText("Foo");
    fireEvent.click(fooRow);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/repo/src/a.ts" });
    });
    const ed = useEditorStore.getState();
    expect(ed.filePath).toBe("/repo/src/a.ts");
    expect(ed.targetLine).toBe(3);
  });

  it("点击 method 节点（symbol）也会打开文件并跳到 start_line（回归测试）", async () => {
    render(<GraphPanel />);
    await waitFor(() => {
      expect(useGraphStore.getState().graphData?.nodes.length).toBe(3);
    });
    // "bar" 只匹配 1 个 method 节点，handleSearch 走 auto-select 路径直接打开文件，
    // 不渲染结果列表。这条测试同时覆盖了"单结果 auto-select"和"symbol 打开文件"两条逻辑。
    const input = screen.getByPlaceholderText("Search symbols...");
    fireEvent.change(input, { target: { value: "bar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("graph_search", expect.objectContaining({ query: "bar" }));
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/repo/src/a.ts" });
    });
    const ed = useEditorStore.getState();
    expect(ed.filePath).toBe("/repo/src/a.ts");
    expect(ed.targetLine).toBe(5);
  });

  it("点击 symbol 结果**不能**把画布（simNodes）清空（回归：旧实现会清，画布变白）", async () => {
    render(<GraphPanel />);
    await waitFor(() => {
      expect(useGraphStore.getState().graphData?.nodes.length).toBe(3);
    });
    // 等 main 模式 layout 跑完，simNodes 被填上（FakeWorker 立即回 circle）
    await waitFor(() => {
      expect(useGraphStore.getState().simNodes.length).toBeGreaterThan(0);
    });
    const simBefore = useGraphStore.getState().simNodes.length;
    // 搜 class 节点并点开
    const input = screen.getByPlaceholderText("Search symbols...");
    fireEvent.change(input, { target: { value: "Foo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const fooRow = await screen.findByText("Foo");
    fireEvent.click(fooRow);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/repo/src/a.ts" });
    });
    // 关键断言：simNodes 没被清空，画布还在。
    // 切到 focus subgraph 是 main 的子集（只 center，没有 calls 边就没有 callers/callees），
    // 所以 simAfter <= simBefore，而且 simAfter 必须包含 center。
    const simAfter = useGraphStore.getState().simNodes;
    expect(simAfter.length).toBeGreaterThan(0);
    expect(simAfter.length).toBeLessThanOrEqual(simBefore);
    expect(simAfter.map((n) => n.id)).toContain("c:src/a.ts:Foo");
    // 顺手验一下选中了那个节点
    expect(useGraphStore.getState().selectedNodeId).toBe("c:src/a.ts:Foo");
  });
  it("点击 symbol 后图谱切到该节点的关联图（focus subgraph）", async () => {
    render(<GraphPanel />);
    await waitFor(() => {
      expect(useGraphStore.getState().graphData?.nodes.length).toBe(3);
    });
    // 等 main 模式 layout 跑完，simNodes 应包含 sig 节点（class + method，因为 contains 边把它们连成一个 community）
    await waitFor(() => {
      expect(useGraphStore.getState().simNodes.length).toBeGreaterThanOrEqual(2);
    });
    // 搜 class Foo 并点开
    const input = screen.getByPlaceholderText("Search symbols...");
    fireEvent.change(input, { target: { value: "Foo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const fooRow = await screen.findByText("Foo");
    fireEvent.click(fooRow);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/repo/src/a.ts" });
    });
    // 等 layout effect 重新跑过 focus 分支，simNodes 重算成 focus subgraph：
    // 切到 focus 后 filteredData 走 extractFocusSubgraph（[callers, center, callees]），
    // 中心节点必须出现在 simNodes 里。
    await waitFor(() => {
      const ids = useGraphStore.getState().simNodes.map((n) => n.id);
      expect(ids).toContain("c:src/a.ts:Foo");
    });
    // 选中节点也指向 Foo
    expect(useGraphStore.getState().selectedNodeId).toBe("c:src/a.ts:Foo");
  });
  it("coalesces burst worker ticks and publishes only the latest result", async () => {
    let postedNodeIds: string[] = [];
    class BurstWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(message: unknown) {
        const input = message as {
          nodes: Array<{ id: string; group: number }>;
        };
        postedNodeIds = input.nodes.map((node) => node.id);
        for (const tick of [1, 2, 3]) {
          this.onmessage?.({
            data: {
              positions: new Float32Array(
                input.nodes.flatMap(() => [tick, tick]),
              ),
            },
          } as MessageEvent);
        }
      }
      terminate() { /* no-op */ }
      addEventListener() {}
      removeEventListener() {}
    }

    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    (globalThis as unknown as { Worker: typeof BurstWorker }).Worker = BurstWorker;
    invokeMock.mockImplementation(async (command: string) =>
      command === "graph_get_data" ? { data: burstGraph } : null,
    );

    const view = render(<GraphPanel />);
    let unsubscribe = () => {};
    try {
      await waitFor(() => {
        expect(useGraphStore.getState().graphData?.nodes).toHaveLength(4);
        expect(frames.size).toBe(1);
      });

      let simulationPublications = 0;
      unsubscribe = useGraphStore.subscribe((state, previousState) => {
        if (state.simNodes !== previousState.simNodes) {
          simulationPublications += 1;
        }
      });
      expect(useGraphStore.getState().simNodes).toEqual([]);

      const [frameId, flush] = frames.entries().next().value as [
        number,
        FrameRequestCallback,
      ];
      frames.delete(frameId);
      act(() => flush(performance.now()));

      expect(simulationPublications).toBe(1);
      const simulation = useGraphStore.getState();
      expect(simulation.simNodes).toHaveLength(4);
      expect(simulation.simNodes.every((node) => node.x === 3 && node.y === 3)).toBe(true);
      expect(simulation.simNodes.map((node) => node.id)).toEqual(postedNodeIds);
      expect(simulation.simNodes.every((node) => node.group === 1)).toBe(true);
      expect(simulation.simEdges).toEqual(
        burstGraph.edges.map(({ source, target, kind }) => ({ source, target, kind })),
      );
    } finally {
      unsubscribe();
      view.unmount();
      (globalThis as unknown as { Worker: typeof FakeWorker }).Worker = FakeWorker;
      vi.unstubAllGlobals();
    }
  });

  it("simulation-only ticks do not commit the GraphPanel React tree", async () => {
    let commits = 0;
    render(
      <Profiler id="graph-panel" onRender={() => { commits += 1; }}>
        <GraphPanel />
      </Profiler>,
    );
    await waitFor(() => {
      expect(useGraphStore.getState().simNodes.length).toBeGreaterThan(0);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const settledCommits = commits;
    const current = useGraphStore.getState();

    act(() => current.setSimResult({
      nodes: current.simNodes.map((node) => ({
        ...node,
        x: node.x + 10,
        y: node.y + 10,
      })),
      edges: current.simEdges,
    }));

    expect(commits).toBe(settledCommits);
  });

  it("挂载时会消费懒加载期间排队的 reveal request", async () => {
    const handled = vi.fn();
    render(
      <GraphPanel
        revealRequest={{ nodeId: "c:src/a.ts:Foo", requestId: 1 }}
        onRevealHandled={handled}
      />,
    );

    await waitFor(() => {
      expect(useGraphStore.getState().graphData?.nodes.length).toBe(3);
    });
    await waitFor(() => {
      const ids = useGraphStore.getState().simNodes.map((node) => node.id);
      expect(ids).toContain("c:src/a.ts:Foo");
    });
    expect(useGraphStore.getState().selectedNodeId).toBe("c:src/a.ts:Foo");
    expect(handled).toHaveBeenCalledWith(1);
  });

});

describe("GraphPanel workspace-scoped loading", () => {
  it("does not write a previous workspace response into the newly active workspace", async () => {
    const firstLoad = Promise.withResolvers<{ data: GraphData }>();
    const secondLoad = Promise.withResolvers<{ data: GraphData }>();
    let graphLoadCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command !== "graph_get_data") return Promise.resolve(null);
      graphLoadCalls += 1;
      return graphLoadCalls === 1 ? firstLoad.promise : secondLoad.promise;
    });

    const firstWorkspace = useWorkspaceStore.getState().workspaces["ws-1"];
    useWorkspaceStore.setState({
      workspaces: {
        "ws-1": firstWorkspace,
        "ws-2": {
          ...firstWorkspace,
          name: "other",
          project_root: "/repo-other",
        },
      },
      activeWorkspaceId: "ws-1",
    });

    render(<GraphPanel />);
    await waitFor(() => {
      expect(graphLoadCalls).toBe(1);
      expect(useGraphStore.getState().byWorkspace["ws-1"]?.loading).toBe(true);
    });

    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: "ws-2" });
      firstLoad.resolve({ data: fakeGraph });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(graphLoadCalls).toBe(2);
    });
    expect(useGraphStore.getState().byWorkspace["ws-1"]?.loading).toBe(false);
    expect(useGraphStore.getState().byWorkspace["ws-2"]?.graphData).toBeNull();
    expect(useGraphStore.getState().byWorkspace["ws-2"]?.loading).toBe(true);

    secondLoad.resolve({ data: burstGraph });
    await waitFor(() => {
      const state = useGraphStore.getState();
      expect(state.byWorkspace["ws-2"]?.graphData).toBe(burstGraph);
      expect(state.byWorkspace["ws-2"]?.loading).toBe(false);
      expect(state.graphData).toBe(burstGraph);
    });
  });
});
