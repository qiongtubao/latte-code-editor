import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGraphStore } from "../hooks/useGraphStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { GraphStoreCanvas } from "./GraphStoreCanvas";

let subscribeRenderState:
  | ((invalidate: () => void) => () => void)
  | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./CanvasGraph", () => ({
  CanvasGraph: (props: {
    subscribeRenderState?: (invalidate: () => void) => () => void;
  }) => {
    subscribeRenderState = props.subscribeRenderState;
    return <canvas />;
  },
}));

describe("GraphStoreCanvas invalidation subscription", () => {
  beforeEach(() => {
    subscribeRenderState = undefined;
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
      activeWorkspaceId: "canvas-test",
      windowMappings: {},
      hydrated: true,
    });
    useGraphStore.getState().setSimResult({
      nodes: [{ id: "n1", x: 0, y: 0, vx: 0, vy: 0, group: 1 }],
      edges: [],
    });
  });

  it("invalidates for render state but ignores unrelated graph fields", () => {
    render(
      <GraphStoreCanvas
        onNodeClick={() => undefined}
        onNodeContextMenu={() => undefined}
      />,
    );
    expect(subscribeRenderState).toBeTypeOf("function");
    const invalidate = vi.fn();
    const unsubscribe = subscribeRenderState!(invalidate);

    act(() => useGraphStore.getState().setLoading(true));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => useGraphStore.getState().setSimResult({
      nodes: [{ id: "n1", x: 1, y: 2, vx: 0, vy: 0, group: 1 }],
      edges: [],
    }));
    act(() => useGraphStore.getState().setSelectedNode("n1"));
    act(() => useGraphStore.getState().setHoveredNode("n1"));
    act(() => useGraphStore.getState().setHighlightedNodes(new Set(["n1"])));
    expect(invalidate).toHaveBeenCalledTimes(4);

    unsubscribe();
    act(() => useGraphStore.getState().setHoveredNode(null));
    expect(invalidate).toHaveBeenCalledTimes(4);
  });
});
