// useGraphStore 单测
//
// 覆盖多 workspace 隔离 + byWorkspace 写入正确性。
// 之前有一个隐性 bug：所有 setter 都只 set 了 derived 字段，没回写 byWorkspace，
// 结果 useWorkspaceStore.subscribe 触发的 project() 永远读到一个空 map，
// 把 projected 字段（graphData / simNodes 等）全部擦成默认值 ——
// 外部看起来就是"图谱突然消失了"。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useGraphStore } from "./useGraphStore";
import { useWorkspaceStore } from "./useWorkspaceStore";
import type { GraphData } from "./graphTypes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const sampleGraph = (id: string): GraphData => ({
  nodes: [{ id, kind: "function", name: id, qualified_name: id, file_path: `/src/${id}.ts`, language: "ts", start_line: 1, end_line: 1, signature: null }],
  edges: [],
  stats: { total_nodes: 1, total_edges: 0, node_kinds: [], edge_kinds: [] },
});

describe("useGraphStore 多 workspace 隔离", () => {
  beforeEach(() => {
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
      activeWorkspaceId: null,
      windowMappings: {},
      hydrated: true,
    });
  });

  it("unrelated workspace metadata changes do not publish graph state", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useGraphStore.getState().setGraphData(sampleGraph("a"));
    const listener = vi.fn();
    const unsubscribe = useGraphStore.subscribe(listener);

    useWorkspaceStore.setState({ hydrated: false });

    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(useGraphStore.getState().graphData?.nodes[0]?.id).toBe("a");
  });

  it("setGraphData 后 byWorkspace 必须真的被写回去（回归：之前只更新了 projected 字段）", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useGraphStore.getState().setGraphData(sampleGraph("a"));
    const s = useGraphStore.getState();
    // 关键断言：byWorkspace["ws-a"] 里必须能找到这份 graphData
    // 旧实现里 byWorkspace 永远是 {}，subscribe 回调一触发就把 graphData 擦掉
    expect(s.byWorkspace["ws-a"]?.graphData?.nodes[0]?.id).toBe("a");
  });

  it("setSimResult 后 byWorkspace 也必须真的被写回去", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useGraphStore.getState().setSimResult({
      nodes: [{ id: "n1", x: 1, y: 2, vx: 0, vy: 0, group: 1 }],
      edges: [],
    });
    expect(useGraphStore.getState().byWorkspace["ws-a"]?.simNodes[0]?.id).toBe("n1");
  });

  it("does not publish or allocate workspace state for repeated setter values", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    const graphData = sampleGraph("a");
    const simNodes = [{ id: "a", x: 1, y: 2, vx: 0, vy: 0, group: 1 }];
    const simEdges: Array<{ source: string; target: string; kind: string }> = [];
    const listener = vi.fn();
    const unsubscribe = useGraphStore.subscribe(listener);

    const expectOnlyFirstUpdateToPublish = (first: () => void, repeat: () => void) => {
      const callsBefore = listener.mock.calls.length;
      first();
      expect(listener).toHaveBeenCalledTimes(callsBefore + 1);
      const stateAfterFirstUpdate = useGraphStore.getState();
      const workspaceAfterFirstUpdate = stateAfterFirstUpdate.byWorkspace["ws-a"];

      repeat();

      expect(listener).toHaveBeenCalledTimes(callsBefore + 1);
      expect(useGraphStore.getState()).toBe(stateAfterFirstUpdate);
      expect(useGraphStore.getState().byWorkspace["ws-a"]).toBe(workspaceAfterFirstUpdate);
    };

    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setGraphData(graphData),
      () => useGraphStore.getState().setGraphData(graphData),
    );
    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setLoading(true),
      () => useGraphStore.getState().setLoading(true),
    );
    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setError("failed"),
      () => useGraphStore.getState().setError("failed"),
    );
    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setSimResult({ nodes: simNodes, edges: simEdges }),
      () => useGraphStore.getState().setSimResult({ nodes: simNodes, edges: simEdges }),
    );
    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setSelectedNode("a"),
      () => useGraphStore.getState().setSelectedNode("a"),
    );
    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setHoveredNode("a"),
      () => useGraphStore.getState().setHoveredNode("a"),
    );
    expectOnlyFirstUpdateToPublish(
      () => useGraphStore.getState().setHighlightedNodes(new Set(["a"])),
      () => useGraphStore.getState().setHighlightedNodes(new Set(["a"])),
    );

    unsubscribe();
  });

  it("切到另一个 workspace，旧的 graphData 还在 byWorkspace 里", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useGraphStore.getState().setGraphData(sampleGraph("a"));
    // 切到 ws-b：derived 字段应该切换，但 byWorkspace["ws-a"] 里的数据不丢
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-b" });
    expect(useGraphStore.getState().graphData).toBeNull();
    expect(useGraphStore.getState().byWorkspace["ws-a"]?.graphData?.nodes[0]?.id).toBe("a");
    // 切回 ws-a：数据又回来了
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    expect(useGraphStore.getState().graphData?.nodes[0]?.id).toBe("a");
  });

  it("useWorkspaceStore.subscribe 触发后，projected 字段不会被擦成默认（回归：之前会被清空）", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useGraphStore.getState().setGraphData(sampleGraph("a"));
    // 模拟 workspace 那边发生一次 setState（哪怕值不变），触发 subscribe 回调
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    // 关键断言：graphData 还在。如果 byWorkspace 没被正确写入，这里会变成 null
    expect(useGraphStore.getState().graphData?.nodes[0]?.id).toBe("a");
  });

  it("reset clears cached and projected graph state", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    const store = useGraphStore.getState();
    store.setGraphData(sampleGraph("a"));
    store.setLoading(true);
    store.setError("failed");
    store.setSimResult({
      nodes: [{ id: "a", x: 1, y: 2, vx: 0, vy: 0, group: 1 }],
      edges: [],
    });
    store.setSelectedNode("a");
    store.setHoveredNode("a");
    store.setHighlightedNodes(new Set(["a"]));

    useGraphStore.getState().reset();

    const state = useGraphStore.getState();
    expect(state.byWorkspace).toEqual({});
    expect(state.graphData).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.simNodes).toEqual([]);
    expect(state.simEdges).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.hoveredNodeId).toBeNull();
    expect(state.highlightedNodeIds).toEqual(new Set());
    expect(state.loadVersion).toBe(0);
  });

  it("evictWorkspace 真的把对应 workspace 的数据从 byWorkspace 删掉", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-a" });
    useGraphStore.getState().setGraphData(sampleGraph("a"));
    useGraphStore.getState().evictWorkspace("ws-a");
    expect(useGraphStore.getState().byWorkspace["ws-a"]).toBeUndefined();
  });
});
