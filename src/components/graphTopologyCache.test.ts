import { describe, expect, it } from "vitest";
import type { SimRenderEdge } from "./graphRenderer";
import { GraphTopologyCache, isEdgeDimmed } from "./graphTopologyCache";

describe("GraphTopologyCache", () => {
  it("reuses immutable topology and invalidates on edge identity or limit changes", () => {
    const edges: SimRenderEdge[] = [
      { source: { id: "a" }, target: "b", kind: "calls", weight: 0.75 },
      { source: "b", target: { id: "c" }, kind: "references" },
    ];
    const cache = new GraphTopologyCache();

    const first = cache.get(edges);
    expect(cache.get(edges)).toBe(first);
    expect(first.nodeDegrees).toEqual(new Map([
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]));
    expect(first.edges[0]).toMatchObject({
      sourceId: "a",
      targetId: "b",
      weight: 0.75,
      color: "#4ec9b0",
      directed: true,
    });
    expect(first.edges[0].canvasWidth).toBeCloseTo(1.95);
    expect(first.edges[0].gpuWidth).toBeCloseTo(1.6);
    expect(first.edges[1]).toMatchObject({
      weight: 0.5,
      color: "#ff3333",
      directed: false,
    });

    const limited = cache.get(edges, 1);
    expect(limited).not.toBe(first);
    expect(limited.edges).toHaveLength(1);
    expect(cache.get(edges, 1)).toBe(limited);

    const copiedEdges = [...edges];
    const copied = cache.get(copiedEdges, 1);
    expect(copied).not.toBe(limited);
    expect(copied.source).toBe(copiedEdges);

    const unknownKind = cache.get([
      { source: "x", target: "y", kind: "unknown", weight: 0.25 },
    ]).edges[0];
    expect(unknownKind.color).toBe("#888");
    expect(unknownKind.rgba[0]).toBeCloseTo(0.533);
    expect(unknownKind.rgba[1]).toBeCloseTo(0.533);
    expect(unknownKind.rgba[2]).toBeCloseTo(0.533);
  });

  it("reuses hover neighborhoods and never dims edges when hover is absent", () => {
    const cache = new GraphTopologyCache();
    const topology = cache.get([
      { source: "a", target: "b", kind: "calls", weight: 1 },
      { source: "b", target: "c", kind: "calls", weight: 1 },
    ]);

    const hoveredA = cache.getHoveredNodes(topology, "a");
    expect(cache.getHoveredNodes(topology, "a")).toBe(hoveredA);
    expect(hoveredA).toEqual(new Set(["a", "b"]));
    expect(isEdgeDimmed("a", hoveredA, "a", "b")).toBe(false);
    expect(isEdgeDimmed("a", hoveredA, "b", "c")).toBe(true);

    const noHover = cache.getHoveredNodes(topology, null);
    expect(cache.getHoveredNodes(topology, null)).toBe(noHover);
    expect(noHover.size).toBe(0);
    expect(isEdgeDimmed(null, noHover, "a", "b")).toBe(false);
  });
});
