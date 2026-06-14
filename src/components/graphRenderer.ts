/**
 * GraphRenderer interface.
 * Implement this to swap Canvas 2D → WebGPU → WebGL without touching GraphPanel.
 */
export interface GraphRendererInitOptions {
  canvas: HTMLCanvasElement;
  getNodeMap: () => Map<string, SimRenderNode>;
}

export interface SimRenderNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  group: number;
  /** Optional display label, used by doc-graph. */
  label?: string;
}

export interface SimRenderEdge {
  source: string | { id: string };
  target: string | { id: string };
  kind: string;
  /** Optional strength 0..1. Drives line thickness + alpha. Default 0.5. */
  weight?: number;
}

export interface GraphRenderer {
  /** Called once when the canvas is mounted. Set up context / GPU device here. */
  init(options: GraphRendererInitOptions): void;
  /** Called every frame after positions update. */
  render(params: RenderParams): void;
  /** Hit-test: find node id at viewport coordinates, or null. */
  hitTest(cx: number, cy: number, pan: { x: number; y: number }, zoom: number): string | null;
  /** Called on resize / DPR change. */
  resize(width: number, height: number, dpr: number): void;
  /** Cleanup. */
  destroy(): void;
}

export interface RenderParams {
  simNodes: SimRenderNode[];
  simEdges: SimRenderEdge[];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  pan: { x: number; y: number };
  zoom: number;
}

// Node color palette by group
export const NODE_COLORS: Record<number, string> = {
  0: "#cc7832", // file
  1: "#6a8759", // function
  2: "#6897bb", // class
  3: "#9876aa", // type
  4: "#bbb529", // import
  5: "#629755", // variable
  6: "#bc3f3f", // test
  7: "#808080", // other
};

// Edge color by kind. New doc-graph kinds are added at the end with
// per-kind weights; the renderer uses `weight` to modulate line thickness.
export const EDGE_COLORS: Record<string, string> = {
  contains: "#555",
  calls: "#4ec9b0",
  imports: "#c586c0",
  inherits: "#dcdcaa",
  implements: "#569cd6",
  references: "#808080",
  // Doc graph kinds — warm = strong, cool = weak
  "source-shared": "#ff7043",   // actual code dep — warmest, most opaque
  wikilink: "#4ea1ff",          // explicit [[link]] — cool blue
  "same-group": "#9e9e9e",      // same dir — neutral gray
};

/** Per-kind edge weight. Higher weight = stronger association. */
export const EDGE_WEIGHTS: Record<string, number> = {
  "source-shared": 1.0,
  wikilink: 0.7,
  "same-group": 0.35,
};
