import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasGraph } from "./CanvasGraph";
import type { GraphRenderer } from "./graphRenderer";

const nodes = [{ id: "n1", x: 10, y: 20, vx: 0, vy: 0, group: 1 }];
const edges: Array<{ source: string; target: string; kind: string }> = [];
const highlights = new Set<string>();

describe("CanvasGraph dirty-frame rendering", () => {
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeRenderer = (): GraphRenderer => ({
    kind: "canvas2d",
    init: vi.fn(),
    render: vi.fn(),
    hitTest: vi.fn().mockReturnValue(null),
    resize: vi.fn(),
    destroy: vi.fn(),
  });

  const runFrame = () => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(entry).toBeDefined();
    if (!entry) return;
    frames.delete(entry[0]);
    act(() => entry[1](performance.now()));
  };

  it("stays idle after drawing and coalesces store, prop, pan, and zoom invalidations", () => {
    const renderer = makeRenderer();
    let invalidate = () => {};
    const unsubscribe = vi.fn();
    const subscribeRenderState = vi.fn((nextInvalidate: () => void) => {
      invalidate = nextInvalidate;
      return unsubscribe;
    });
    const commonProps = {
      simNodes: nodes,
      simEdges: edges,
      hoveredNodeId: null,
      highlightedNodeIds: highlights,
      onNodeClick: vi.fn(),
      onNodeHover: vi.fn(),
      renderer,
      subscribeRenderState,
    };

    const view = render(
      <CanvasGraph {...commonProps} selectedNodeId={null} />,
    );
    const canvas = view.container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(frames.size).toBe(1);

    runFrame();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    invalidate();
    invalidate();
    invalidate();
    expect(frames.size).toBe(1);

    view.rerender(<CanvasGraph {...commonProps} selectedNodeId="n1" />);
    if (canvas) {
      fireEvent.wheel(canvas, { deltaY: -1 });
      fireEvent.mouseDown(canvas, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(canvas, { clientX: 20, clientY: 25 });
    }
    expect(frames.size).toBe(1);

    runFrame();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);

    invalidate();
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
