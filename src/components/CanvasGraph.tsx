import { useEffect, useRef, useCallback } from "react";
import type { GraphRenderer, RenderParams, SimRenderNode } from "./graphRenderer";
import { createRenderer, rendererKindOf, type RendererKind } from "./rendererFactory";

type CanvasRenderState = Omit<RenderParams, "pan" | "zoom">;

interface CanvasGraphProps {
  simNodes: SimRenderNode[];
  simEdges: Array<{ source: string; target: string; kind: string }>;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  onNodeClick: (nodeId: string) => void;
  onNodeHover: (nodeId: string | null) => void;
  onNodeContextMenu?: (nodeId: string, x: number, y: number) => void;
  /** Pull the latest render state without requiring a React render per tick. */
  getRenderState?: () => CanvasRenderState;
  /** Pull the latest hit-test map without rebuilding it during React commits. */
  getNodeMap?: () => Map<string, SimRenderNode>;
  /** Pull only the current hover ID for mousemove transition deduplication. */
  getHoveredNodeId?: () => string | null;
  /** Subscribe to imperative state changes that should schedule one redraw. */
  subscribeRenderState?: (invalidate: () => void) => () => void;
  /** 外部传入的渲染器（测试或自定义场景）。优先级高于 rendererKind */
  renderer?: GraphRenderer;
  /** 渲染器选择（auto = 探测后选最优；webgpu = 强制 WebGPU；canvas2d = 强制 Canvas 2D） */
  rendererKind?: RendererKind;
  /** 渲染器已就绪的回调（用于状态栏显示） */
  onRendererReady?: (kind: "webgpu" | "canvas2d") => void;
}

export function CanvasGraph({
  simNodes,
  simEdges,
  selectedNodeId,
  hoveredNodeId,
  highlightedNodeIds,
  onNodeClick,
  onNodeHover,
  onNodeContextMenu,
  getRenderState,
  getNodeMap: externalGetNodeMap,
  getHoveredNodeId,
  subscribeRenderState,
  renderer: externalRenderer,
  rendererKind = "auto",
  onRendererReady,
}: CanvasGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const lastReportedHoveredNodeRef = useRef(hoveredNodeId);
  if (!getHoveredNodeId) {
    lastReportedHoveredNodeRef.current = hoveredNodeId;
  }
  const rendererRef = useRef<GraphRenderer | null>(null);
  const nodeMapRef = useRef<Map<string, SimRenderNode>>(new Map());
  const renderStateRef = useRef<CanvasRenderState>({
    simNodes,
    simEdges,
    selectedNodeId,
    hoveredNodeId,
    highlightedNodeIds,
  });
  renderStateRef.current = {
    simNodes,
    simEdges,
    selectedNodeId,
    hoveredNodeId,
    highlightedNodeIds,
  };

  // Build node lookup from simNodes (used by hitTest via getNodeMap)
  useEffect(() => {
    if (externalGetNodeMap) return;
    const map = new Map<string, SimRenderNode>();
    for (const n of simNodes) {
      map.set(n.id, n);
    }
    nodeMapRef.current = map;
  }, [externalGetNodeMap, simNodes]);

  // Initialize renderer (支持 async——WebGPU 探测和设备请求都是 async)
  useEffect(() => {
    if (!canvasRef.current) return;
    let cancelled = false;

    const initOptions = {
      canvas: canvasRef.current,
      getNodeMap: externalGetNodeMap ?? (() => nodeMapRef.current),
    };

    if (externalRenderer) {
      // 外部传入：假设已 init 完毕（同步 init）
      rendererRef.current = externalRenderer;
      onRendererReady?.(rendererKindOf(externalRenderer));
      invalidateRef.current();
    } else {
      // 自动 / 显式选择
      createRenderer(rendererKind, initOptions).then((r) => {
        if (cancelled) {
          r.destroy();
          return;
        }
        rendererRef.current = r;
        const k = rendererKindOf(r);
        onRendererReady?.(k);
        invalidateRef.current();
      }).catch((e) => {
        console.error("[CanvasGraph] renderer init failed:", e);
      });
    }

    return () => {
      cancelled = true;
      const r = rendererRef.current;
      if (r && r !== externalRenderer) r.destroy();
      rendererRef.current = null;
    };
  }, [externalGetNodeMap, externalRenderer, rendererKind, onRendererReady]);
  // Resize handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          const dpr = window.devicePixelRatio || 1;
          rendererRef.current?.resize(width, height, dpr);
          invalidateRef.current();
        }
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Dirty-frame renderer: at most one RAF may be pending, and drawing never
  // schedules another frame by itself. Idle graphs therefore consume zero RAF.
  useEffect(() => {
    const invalidate = () => {
      if (animFrameRef.current !== null) return;
      animFrameRef.current = requestAnimationFrame(() => {
        animFrameRef.current = null;
        const state = getRenderState?.() ?? renderStateRef.current;
        rendererRef.current?.render({
          ...state,
          pan: panRef.current,
          zoom: zoomRef.current,
        });
      });
    };

    invalidateRef.current = invalidate;
    invalidate();
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (invalidateRef.current === invalidate) {
        invalidateRef.current = () => {};
      }
    };
  }, [getRenderState]);

  useEffect(() => {
    if (!subscribeRenderState) return;
    return subscribeRenderState(() => invalidateRef.current());
  }, [subscribeRenderState]);

  // Prop-driven canvases (for example the doc graph) redraw when their render
  // state changes. Store-driven canvases use subscribeRenderState instead.
  useEffect(() => {
    invalidateRef.current();
  }, [simNodes, simEdges, selectedNodeId, hoveredNodeId, highlightedNodeIds]);

  // Hit test (delegates to renderer)
  const hitTest = useCallback(
    (cx: number, cy: number): string | null => {
      return rendererRef.current?.hitTest(cx, cy, panRef.current, zoomRef.current) ?? null;
    },
    [],
  );

  const reportNodeHover = useCallback((nodeId: string | null) => {
    const currentNodeId = getHoveredNodeId
      ? getHoveredNodeId()
      : lastReportedHoveredNodeRef.current;
    if (currentNodeId === nodeId) return;
    lastReportedHoveredNodeRef.current = nodeId;
    onNodeHover(nodeId);
  }, [getHoveredNodeId, onNodeHover]);

  // Mouse handlers
  const mouseDownPos = useRef({ x: 0, y: 0 });
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Left button only starts drag
    if (e.button !== 0) return;
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (isDragging.current) {
        const dx = e.clientX - lastMouse.current.x;
        const dy = e.clientY - lastMouse.current.y;
        panRef.current.x += dx;
        panRef.current.y += dy;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        invalidateRef.current();
        return;
      }

      const hit = hitTest(cx, cy);
      reportNodeHover(hit);
      const cursor = hit ? "pointer" : "default";
      if (canvas.style.cursor !== cursor) {
        canvas.style.cursor = cursor;
      }
    },
    [hitTest, reportNodeHover],
  );
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = hitTest(cx, cy);

      // Right-click: show context menu
      if (e.button === 2) {
        if (hit && onNodeContextMenu) {
          onNodeContextMenu(hit, e.clientX, e.clientY);
        }
        return;
      }

      // Left-click: click or drag
      if (e.button !== 0) return;
      const dx = Math.abs(e.clientX - mouseDownPos.current.x);
      const dy = Math.abs(e.clientY - mouseDownPos.current.y);
      if (dx < 5 && dy < 5 && hit) {
        onNodeClick(hit);
      }
      isDragging.current = false;
    },
    [hitTest, onNodeClick, onNodeContextMenu],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas || !onNodeContextMenu) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = hitTest(cx, cy);
      if (hit) {
        onNodeContextMenu(hit, e.clientX, e.clientY);
      }
    },
    [hitTest, onNodeContextMenu],
  );

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomRef.current = Math.max(0.1, Math.min(10, zoomRef.current * zoomFactor));
    invalidateRef.current();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full cursor-grab active:cursor-grabbing"
      style={{ background: "var(--surface)" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      onWheel={handleWheel}
      onMouseLeave={() => {
        isDragging.current = false;
        reportNodeHover(null);
      }}
    />
  );
}
