import type { GraphRenderer, GraphRendererInitOptions, RenderParams, SimRenderNode } from "./graphRenderer";
import { NODE_COLORS, EDGE_COLORS } from "./graphRenderer";

/**
 * Canvas 2D renderer — the baseline implementation.
 * When WebGPU support is needed, create `WebGPURenderer implements GraphRenderer`
 * and swap it in CanvasGraph.tsx without changing any other code.
 */
export class Canvas2DRenderer implements GraphRenderer {
  private ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private getNodeMap: (() => Map<string, SimRenderNode>) | null = null;
  private dpr = 1;

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
    this.ctx.scale(dpr, dpr);
  }

  hitTest(
    cx: number,
    cy: number,
    pan: { x: number; y: number },
    zoom: number,
  ): string | null {
    const nodeMap = this.getNodeMap?.();
    if (!nodeMap) return null;

    // Iterate in reverse (last rendered = on top)
    const entries = Array.from(nodeMap.entries());
    for (let i = entries.length - 1; i >= 0; i--) {
      const [id, n] = entries[i];
      const sx = n.x * zoom + pan.x;
      const sy = n.y * zoom + pan.y;
      const radius = n.group === 0 ? 6 : 4;
      const dx = cx - sx;
      const dy = cy - sy;
      if (dx * dx + dy * dy < (radius + 4) * (radius + 4)) {
        return id;
      }
    }
    return null;
  }

  render(params: RenderParams): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const { simNodes, simEdges, selectedNodeId, hoveredNodeId, highlightedNodeIds, pan, zoom } = params;

    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw edges
    for (const edge of simEdges) {
      const source = simNodes.find((n) => n.id === edge.source);
      const target = simNodes.find((n) => n.id === edge.target);
      if (!source || !target) continue;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = EDGE_COLORS[edge.kind] || "#555";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Draw nodes
    const hasHighlight = highlightedNodeIds.size > 0;
    for (const n of simNodes) {
      const isSelected = n.id === selectedNodeId;
      const isHovered = n.id === hoveredNodeId;
      const isHighlighted = !hasHighlight || highlightedNodeIds.has(n.id);

      const baseRadius = n.group === 0 ? 6 : 4;
      const radius = isSelected ? baseRadius + 3 : isHovered ? baseRadius + 2 : baseRadius;
      const color = NODE_COLORS[n.group] || "#808080";

      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);

      if (isSelected) {
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius - 1, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      } else if (!isHighlighted) {
        ctx.fillStyle = "#333";
        ctx.fill();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Label for selected/hovered
      if ((isSelected || isHovered) && n.x > 0) {
        const label = n.id.length > 30 ? n.id.slice(0, 30) + "…" : n.id;
        ctx.fillStyle = "#fff";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, n.x, n.y - radius - 4);
      }
    }

    ctx.restore();
  }

  destroy(): void {
    this.ctx = null;
    this.canvas = null;
    this.getNodeMap = null;
  }
}
