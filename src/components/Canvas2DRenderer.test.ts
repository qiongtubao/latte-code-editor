import { afterEach, describe, expect, it, vi } from "vitest";
import { Canvas2DRenderer } from "./Canvas2DRenderer";
import type { RenderParams, SimRenderEdge, SimRenderNode } from "./graphRenderer";

function createContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    rotate: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn(),
    roundRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
}

function node(id: string, x: number, y: number): SimRenderNode {
  return { id, x, y, vx: 0, vy: 0, group: 1 };
}

describe("Canvas2DRenderer topology caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses stable edges once while drawing every new node position", () => {
    const context = createContext();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      getBoundingClientRect: vi.fn(() => ({ width: 640, height: 480 })),
    };
    Object.defineProperty(context, "canvas", { value: canvas });

    let sourceReads = 0;
    let targetReads = 0;
    const edge = {
      get source() {
        sourceReads += 1;
        return "a";
      },
      get target() {
        targetReads += 1;
        return "b";
      },
      kind: "references",
      weight: 0.5,
    } as SimRenderEdge;
    const edges = [edge];
    const renderer = new Canvas2DRenderer();
    renderer.init({
      canvas: canvas as unknown as HTMLCanvasElement,
      getNodes: () => [],
    });

    const baseParams: Omit<RenderParams, "simNodes"> = {
      simEdges: edges,
      selectedNodeId: null,
      hoveredNodeId: null,
      highlightedNodeIds: new Set(),
      pan: { x: 0, y: 0 },
      zoom: 1,
    };
    renderer.render({
      ...baseParams,
      simNodes: [node("a", 1, 2), node("b", 3, 4)],
    });
    expect(sourceReads).toBe(1);
    expect(targetReads).toBe(1);
    expect(context.moveTo).toHaveBeenLastCalledWith(1, 2);
    expect(context.lineTo).toHaveBeenLastCalledWith(3, 4);

    renderer.render({
      ...baseParams,
      simNodes: [node("a", 10, 20), node("b", 30, 40)],
    });
    expect(sourceReads).toBe(1);
    expect(targetReads).toBe(1);
    expect(context.moveTo).toHaveBeenLastCalledWith(10, 20);
    expect(context.lineTo).toHaveBeenLastCalledWith(30, 40);

    renderer.render({
      ...baseParams,
      simEdges: [...edges],
      simNodes: [node("a", 100, 200), node("b", 300, 400)],
    });
    expect(sourceReads).toBe(2);
    expect(targetReads).toBe(2);
    expect(context.moveTo).toHaveBeenLastCalledWith(100, 200);
    expect(context.lineTo).toHaveBeenLastCalledWith(300, 400);
  });
});

describe("Canvas2DRenderer hit testing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads ordered nodes without materializing entries per hit test", () => {
    const context = createContext();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      getBoundingClientRect: vi.fn(() => ({ width: 640, height: 480 })),
    };
    Object.defineProperty(context, "canvas", { value: canvas });

    let nodes = [node("first", 20, 20), node("topmost", 20, 20)];
    const getNodes = vi.fn(() => nodes);
    const renderer = new Canvas2DRenderer();
    renderer.init({
      canvas: canvas as unknown as HTMLCanvasElement,
      getNodes,
    });
    const arrayFrom = vi.spyOn(Array, "from");

    for (let i = 0; i < 100; i++) {
      expect(renderer.hitTest(20, 20, { x: 0, y: 0 }, 1)).toBe("topmost");
    }
    expect(getNodes).toHaveBeenCalledTimes(100);
    expect(arrayFrom).not.toHaveBeenCalled();

    nodes = [node("latest", 80, 90)];
    expect(renderer.hitTest(80, 90, { x: 0, y: 0 }, 1)).toBe("latest");
    expect(renderer.hitTest(20, 20, { x: 0, y: 0 }, 1)).toBeNull();
  });
});
