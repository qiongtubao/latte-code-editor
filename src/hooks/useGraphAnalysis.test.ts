import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "./graphTypes";
import { useGraphAnalysis } from "./useGraphAnalysis";

const mocks = vi.hoisted(() => ({
  detectCommunities: vi.fn(),
}));

vi.mock("./graphUtils", () => ({
  detectCommunities: mocks.detectCommunities,
}));

const graphData: GraphData = {
  nodes: [
    {
      id: "a",
      kind: "function",
      name: "a",
      qualified_name: "a",
      file_path: "/a.ts",
      language: "typescript",
      start_line: 1,
      end_line: 1,
      signature: null,
    },
    {
      id: "b",
      kind: "function",
      name: "b",
      qualified_name: "b",
      file_path: "/b.ts",
      language: "typescript",
      start_line: 1,
      end_line: 1,
      signature: null,
    },
    {
      id: "c",
      kind: "function",
      name: "c",
      qualified_name: "c",
      file_path: "/c.ts",
      language: "typescript",
      start_line: 1,
      end_line: 1,
      signature: null,
    },
  ],
  edges: [
    {
      id: "a-b",
      source: "a",
      target: "b",
      kind: "calls",
      metadata: null,
    },
  ],
  stats: {
    total_nodes: 3,
    total_edges: 1,
    node_kinds: [],
    edge_kinds: [],
  },
};

describe("useGraphAnalysis", () => {
  beforeEach(() => {
    mocks.detectCommunities.mockReset().mockReturnValue([
      { id: 0, nodeIds: new Set(["a", "b"]), cx: 0, cy: 0, rank: 0 },
      { id: 1, nodeIds: new Set(["c"]), cx: 0, cy: 0, rank: 1 },
    ]);
  });

  it("derives ranks and totals from one community analysis per graph identity", () => {
    const { result, rerender } = renderHook(
      ({ graph }: { graph: GraphData }) => useGraphAnalysis(graph),
      { initialProps: { graph: graphData } },
    );

    expect(mocks.detectCommunities).toHaveBeenCalledTimes(1);
    expect(mocks.detectCommunities).toHaveBeenCalledWith(
      graphData.nodes,
      graphData.edges,
    );
    expect([...result.current.communityMap.entries()]).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 1],
    ]);
    expect(result.current.totalStats).toEqual({
      nodes: 3,
      edges: 1,
      communities: 2,
    });

    const firstAnalysis = result.current;
    rerender({ graph: graphData });
    expect(mocks.detectCommunities).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(firstAnalysis);

    const nextGraph = { ...graphData };
    rerender({ graph: nextGraph });
    expect(mocks.detectCommunities).toHaveBeenCalledTimes(2);
    expect(result.current).not.toBe(firstAnalysis);
  });

  it("returns stable empty analysis without running community detection", () => {
    const { result, rerender } = renderHook(
      ({ graph }: { graph: GraphData | null }) => useGraphAnalysis(graph),
      { initialProps: { graph: null } },
    );

    expect(mocks.detectCommunities).not.toHaveBeenCalled();
    expect(result.current.communityMap).toEqual(new Map());
    expect(result.current.totalStats).toEqual({
      nodes: 0,
      edges: 0,
      communities: 0,
    });

    const firstAnalysis = result.current;
    rerender({ graph: null });
    expect(result.current).toBe(firstAnalysis);
    expect(mocks.detectCommunities).not.toHaveBeenCalled();
  });
});
