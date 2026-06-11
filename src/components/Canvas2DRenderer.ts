import type { GraphRenderer, GraphRendererInitOptions, RenderParams, SimRenderNode } from "./graphRenderer";
import { NODE_COLORS, EDGE_COLORS } from "./graphRenderer";

/**
 * Canvas 2D renderer with refined node/edge visuals.
 * Node radius based on degree; edge thickness and color by kind.
 */
export class Canvas2DRenderer implements GraphRenderer {
  private ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private getNodeMap: (() => Map<string, SimRenderNode>) | null = null;
  private dpr = 1;
  private nodeDegrees = new Map<string, number>();

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

    // Build node map & compute degrees
    const nodeMap = new Map<string, SimRenderNode>();
    this.nodeDegrees.clear();
    for (const n of simNodes) nodeMap.set(n.id, n);
    for (const e of simEdges) {
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      this.nodeDegrees.set(s, (this.nodeDegrees.get(s) ?? 0) + 1);
      this.nodeDegrees.set(t, (this.nodeDegrees.get(t) ?? 0) + 1);
    }
    // Edge helper for source/target
    const src = (e: { source: string | { id: string }; target: string | { id: string }; kind: string }): string =>
      typeof e.source === "string" ? e.source : e.source.id;
    const tgt = (e: { source: string | { id: string }; target: string | { id: string }; kind: string }): string =>
      typeof e.target === "string" ? e.target : e.target.id;
    const hoveredNodes = new Set<string>();
    if (hoveredNodeId) {
      hoveredNodes.add(hoveredNodeId);
      for (const e of simEdges) {
        const s = src(e);
        const t = tgt(e);
        if (s === hoveredNodeId) hoveredNodes.add(t);
        if (t === hoveredNodeId) hoveredNodes.add(s);
      }
    }
    const isDimmed = (id: string): boolean => hoveredNodeId != null && !hoveredNodes.has(id);

    // === Edges ===
    for (const e of simEdges) {
      const s = src(e);
      const t = tgt(e);
      const sNode = nodeMap.get(s);
      const tNode = nodeMap.get(t);
      if (!sNode || !tNode) continue;

      const edgeColor = EDGE_COLORS[e.kind] ?? "#555";
      const edgeWidth = e.kind === "calls" ? 1.5 : e.kind === "imports" ? 1.2 : 0.8;
      const isHighlighted =
        (selectedNodeId != null && (s === selectedNodeId || t === selectedNodeId)) ||
        (hoveredNodeId != null && (s === hoveredNodeId || t === hoveredNodeId));
      const dim = isDimmed(s) || isDimmed(t);

      ctx.beginPath();
      ctx.moveTo(sNode.x, sNode.y);
      ctx.lineTo(tNode.x, tNode.y);
      ctx.strokeStyle = isHighlighted ? "#e0e0e0" : edgeColor;
      ctx.lineWidth = isHighlighted ? edgeWidth * 2 : edgeWidth;
      ctx.globalAlpha = dim ? 0.08 : isHighlighted ? 0.9 : 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
      // ... arrow drawing ...
      if (dim) continue; // skip arrows for dimmed edges
      if ((e.kind === "calls" || e.kind === "imports") && edgeWidth >= 0.8) {
        const angle = Math.atan2(tNode.y - sNode.y, tNode.x - sNode.x);
        const tR = Math.min(16, Math.max(6, 4 + Math.sqrt((this.nodeDegrees.get(t) ?? 1)) * 1.5));
        const arrowLen = 8;
        const ax = tNode.x - Math.cos(angle) * (tR + 4);
        const ay = tNode.y - Math.sin(angle) * (tR + 4);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(arrowLen, 0);
        ctx.lineTo(-arrowLen * 0.5, -arrowLen * 0.5);
        ctx.lineTo(-arrowLen * 0.5, arrowLen * 0.5);
        ctx.closePath();
        ctx.fillStyle = isHighlighted ? "#e0e0e0" : edgeColor;
        ctx.globalAlpha = isHighlighted ? 0.9 : 0.5;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }
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
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Label for hovered or larger nodes
      if (isHovered || r > 8) {
        const label = n.id.includes(":") ? n.id.split(":").slice(-2, -1)[0] || n.id : n.id;
        ctx.fillStyle = isHovered ? "#fff" : "#d4d4d4";
        ctx.font = isHovered ? "bold 11px monospace" : `${Math.min(11, r * 1.2)}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (isHovered) {
          const textW = ctx.measureText(label.length > 25 ? label.slice(0, 23) + "…" : label).width;
          ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
          ctx.roundRect(n.x - textW / 2 - 3, n.y + r + 2, textW + 6, 14, 3);
          ctx.fill();
          ctx.fillStyle = "#fff";
        }
        ctx.fillText(label.length > 25 ? label.slice(0, 23) + "…" : label, n.x, n.y + r + 2);
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
