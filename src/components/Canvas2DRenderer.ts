import type { GraphRenderer, GraphRendererInitOptions, RenderParams, SimRenderNode } from "./graphRenderer";
import { NODE_COLORS } from "./graphRenderer";
import {
  GraphNodeIndexCache,
  GraphTopologyCache,
  isEdgeDimmed,
} from "./graphTopologyCache";
import { cssVar } from "../skins";

/**
 * Canvas 2D renderer with refined node/edge visuals.
 * Node radius based on degree; edge thickness and color by kind.
 */
export class Canvas2DRenderer implements GraphRenderer {
  readonly kind = "canvas2d" as const;
  private ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private getNodeMap: (() => Map<string, SimRenderNode>) | null = null;
  private dpr = 1;
  private nodeDegrees = new Map<string, number>();
  private topologyCache = new GraphTopologyCache();
  private nodeIndexCache = new GraphNodeIndexCache();

  init(options: GraphRendererInitOptions): void {
    this.canvas = options.canvas;
    this.ctx = options.canvas.getContext("2d");
    this.getNodeMap = options.getNodeMap;

    const rect = options.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.resize(rect.width, rect.height, this.dpr);
  }

  resize(width: number, height: number, dpr: number): void {
    if (!this.canvas || !this.ctx) return;
    this.dpr = dpr;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  hitTest(
    cx: number,
    cy: number,
    pan: { x: number; y: number },
    zoom: number,
  ): string | null {
    const nodeMap = this.getNodeMap?.();
    if (!nodeMap) return null;

    const entries = Array.from(nodeMap.entries());
    for (let i = entries.length - 1; i >= 0; i--) {
      const [id, node] = entries[i];
      const sx = (node.x + pan.x) * zoom;
      const sy = (node.y + pan.y) * zoom;
      const deg = this.nodeDegrees.get(id) ?? 1;
      const r = Math.min(16, Math.max(6, 4 + Math.sqrt(deg) * 1.5)) * zoom;
      if (Math.abs(cx - sx) <= r && Math.abs(cy - sy) <= r) {
        return id;
      }
    }
    return null;
  }

  render(params: RenderParams): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const { simNodes, simEdges, selectedNodeId, hoveredNodeId, highlightedNodeIds, pan, zoom } = params;
    const { width, height } = ctx.canvas;

    // Clear with DPR-aware transform
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.restore();

    ctx.save();
    ctx.translate(pan.x * zoom, pan.y * zoom);
    ctx.scale(zoom, zoom);

    // Node positions change every simulation frame, but edge topology is
    // immutable until simEdges identity changes.
    const topology = this.topologyCache.get(simEdges);
    this.nodeDegrees = topology.nodeDegrees;
    const nodeIndexes = this.nodeIndexCache.get(simNodes);
    const hoveredNodes = this.topologyCache.getHoveredNodes(topology, hoveredNodeId);
    const isDimmed = (id: string): boolean =>
      hoveredNodeId !== null && !hoveredNodes.has(id);

    // 皮肤联动的对比色（高亮边/选中描边/标签），绘制时现取。
    const fgColor = cssVar("--fg", "#ffffff");
    const surfaceColor = cssVar("--surface", "#1e1e1e");

    // === Edges ===
    for (const cachedEdge of topology.edges) {
      const {
        sourceId,
        targetId,
        weight,
        canvasWidth,
        color,
        directed,
      } = cachedEdge;
      const sourceIndex = nodeIndexes.get(sourceId);
      const targetIndex = nodeIndexes.get(targetId);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      const sourceNode = simNodes[sourceIndex];
      const targetNode = simNodes[targetIndex];

      const isHighlighted =
        (selectedNodeId !== null && (sourceId === selectedNodeId || targetId === selectedNodeId)) ||
        (hoveredNodeId !== null && (sourceId === hoveredNodeId || targetId === hoveredNodeId));
      const dim = isEdgeDimmed(hoveredNodeId, hoveredNodes, sourceId, targetId);

      ctx.beginPath();
      ctx.moveTo(sourceNode.x, sourceNode.y);
      ctx.lineTo(targetNode.x, targetNode.y);
      ctx.strokeStyle = isHighlighted ? fgColor : color;
      ctx.lineWidth = isHighlighted ? canvasWidth * 2 : canvasWidth;
      // Stronger association → more opaque
      ctx.globalAlpha = dim ? 0.06 : isHighlighted ? 0.95 : (0.25 + weight * 0.55);
      ctx.stroke();
      // Arrow head
      if (dim || !directed) continue;
      const angle = Math.atan2(
        targetNode.y - sourceNode.y,
        targetNode.x - sourceNode.x,
      );
      const targetRadius = Math.min(
        16,
        Math.max(6, 4 + Math.sqrt((this.nodeDegrees.get(targetId) ?? 1)) * 1.5),
      );
      const arrowLen = 8;
      const ax = targetNode.x - Math.cos(angle) * (targetRadius + 4);
      const ay = targetNode.y - Math.sin(angle) * (targetRadius + 4);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(arrowLen, 0);
      ctx.lineTo(-arrowLen * 0.5, -arrowLen * 0.5);
      ctx.lineTo(-arrowLen * 0.5, arrowLen * 0.5);
      ctx.closePath();
      ctx.fillStyle = isHighlighted ? fgColor : color;
      ctx.globalAlpha = isHighlighted ? 0.9 : 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // === Nodes ===
    for (const n of simNodes) {
      const deg = this.nodeDegrees.get(n.id) ?? 1;
      const r = Math.min(16, Math.max(6, 4 + Math.sqrt(deg) * 1.5));
      const isSelected = n.id === selectedNodeId;
      const isHovered = n.id === hoveredNodeId;
      const isHighlight = highlightedNodeIds.size > 0 && highlightedNodeIds.has(n.id);
      const dim = isDimmed(n.id);

      if (dim && !isSelected && !isHovered) {
        // Dimmed: tiny dot, no label
        ctx.beginPath();
        ctx.arc(n.x, n.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#444";
        ctx.globalAlpha = 0.15;
        ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }

      let fillColor = NODE_COLORS[n.group] ?? "#808080";
      if (isSelected) fillColor = "#ffcc00";
      else if (isHovered) fillColor = "#4fc3ff";
      else if (isHighlight) fillColor = "#ff8a65";

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();

      if (isHovered) {
        ctx.strokeStyle = "#4fc3ff";
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (isSelected) {
        ctx.strokeStyle = fgColor;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Label for hovered or larger nodes
      if (isHovered || r > 8) {
        const label = n.id.includes(":") ? n.id.split(":").slice(-2, -1)[0] || n.id : n.id;
        const display = label.length > 25 ? label.slice(0, 23) + "…" : label;
        ctx.font = isHovered ? "bold 12px monospace" : `${Math.min(12, r * 1.3)}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (isHovered) {
          // Hovered: subtle dark backdrop + bright text for emphasis
          const textW = ctx.measureText(display).width;
          ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
          ctx.beginPath();
          ctx.roundRect(n.x - textW / 2 - 4, n.y + r + 1, textW + 8, 16, 3);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
        } else {
          // Default: 前景色文字 + 底色描边，深浅皮肤下都有对比度
          ctx.fillStyle = fgColor;
          ctx.strokeStyle = surfaceColor;
          ctx.lineWidth = 3;
          ctx.lineJoin = "round";
          ctx.strokeText(display, n.x, n.y + r + 2);
        }
        ctx.fillText(display, n.x, n.y + r + 2);
      }
      }

    ctx.restore();
  }

  destroy(): void {
    this.ctx = null;
    this.canvas = null;
    this.getNodeMap = null;
    this.topologyCache.clear();
    this.nodeIndexCache.clear();
    this.nodeDegrees = new Map();
  }
}
