import type { SimRenderEdge, SimRenderNode } from "./graphRenderer";
import { EDGE_COLORS } from "./graphRenderer";

export interface CachedGraphEdge {
  sourceId: string;
  targetId: string;
  weight: number;
  canvasWidth: number;
  gpuWidth: number;
  color: string;
  rgba: [number, number, number, number];
  directed: boolean;
}

export interface GraphTopology {
  source: SimRenderEdge[];
  edgeLimit: number;
  edges: CachedGraphEdge[];
  nodeDegrees: Map<string, number>;
}

const EMPTY_HOVERED_NODES = new Set<string>();

function endpointId(endpoint: SimRenderEdge["source"]): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function hexToRgba(hex: string): [number, number, number, number] {
  const raw = hex.replace("#", "");
  const normalized = raw.length === 3
    ? raw.split("").map((digit) => digit + digit).join("")
    : raw;
  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
    1,
  ];
}

export class GraphTopologyCache {
  private topology: GraphTopology | null = null;
  private hoveredTopology: GraphTopology | null = null;
  private hoveredNodeId: string | null = null;
  private hoveredNodes: Set<string> = EMPTY_HOVERED_NODES;

  get(source: SimRenderEdge[], edgeLimit = source.length): GraphTopology {
    const normalizedLimit = Math.max(0, Math.min(source.length, edgeLimit));
    if (
      this.topology?.source === source
      && this.topology.edgeLimit === normalizedLimit
    ) {
      return this.topology;
    }

    const edges: CachedGraphEdge[] = [];
    const nodeDegrees = new Map<string, number>();
    for (let index = 0; index < normalizedLimit; index++) {
      const edge = source[index];
      const sourceId = endpointId(edge.source);
      const targetId = endpointId(edge.target);
      const hasWeight = typeof edge.weight === "number";
      const weight = edge.weight ?? 0.5;
      const color = hasWeight ? (EDGE_COLORS[edge.kind] ?? "#888") : "#ff3333";
      const directed =
        edge.kind === "calls"
        || edge.kind === "imports"
        || edge.kind === "wikilink"
        || edge.kind === "source-shared";
      edges.push({
        sourceId,
        targetId,
        weight,
        canvasWidth: 0.6 + weight * 1.8,
        gpuWidth: 0.4 + weight * 1.6,
        color,
        rgba: hexToRgba(color),
        directed,
      });
      nodeDegrees.set(sourceId, (nodeDegrees.get(sourceId) ?? 0) + 1);
      nodeDegrees.set(targetId, (nodeDegrees.get(targetId) ?? 0) + 1);
    }

    this.topology = { source, edgeLimit: normalizedLimit, edges, nodeDegrees };
    this.hoveredTopology = null;
    this.hoveredNodeId = null;
    this.hoveredNodes = EMPTY_HOVERED_NODES;
    return this.topology;
  }

  getHoveredNodes(topology: GraphTopology, hoveredNodeId: string | null): Set<string> {
    if (hoveredNodeId === null) return EMPTY_HOVERED_NODES;
    if (
      this.hoveredTopology === topology
      && this.hoveredNodeId === hoveredNodeId
    ) {
      return this.hoveredNodes;
    }

    const hoveredNodes = new Set([hoveredNodeId]);
    for (const edge of topology.edges) {
      if (edge.sourceId === hoveredNodeId) hoveredNodes.add(edge.targetId);
      if (edge.targetId === hoveredNodeId) hoveredNodes.add(edge.sourceId);
    }
    this.hoveredTopology = topology;
    this.hoveredNodeId = hoveredNodeId;
    this.hoveredNodes = hoveredNodes;
    return hoveredNodes;
  }

  clear(): void {
    this.topology = null;
    this.hoveredTopology = null;
    this.hoveredNodeId = null;
    this.hoveredNodes = EMPTY_HOVERED_NODES;
  }
}

export function isEdgeDimmed(
  hoveredNodeId: string | null,
  hoveredNodes: Set<string>,
  sourceId: string,
  targetId: string,
): boolean {
  return hoveredNodeId !== null
    && (!hoveredNodes.has(sourceId) || !hoveredNodes.has(targetId));
}

export class GraphNodeIndexCache {
  private nodeIds: string[] = [];
  private indexById = new Map<string, number>();
  private initialized = false;

  get(nodes: readonly SimRenderNode[]): Map<string, number> {
    if (this.initialized && this.nodeIds.length === nodes.length) {
      let matches = true;
      for (let index = 0; index < nodes.length; index++) {
        if (this.nodeIds[index] !== nodes[index].id) {
          matches = false;
          break;
        }
      }
      if (matches) return this.indexById;
    }

    const nodeIds = new Array<string>(nodes.length);
    const indexById = new Map<string, number>();
    for (let index = 0; index < nodes.length; index++) {
      const id = nodes[index].id;
      nodeIds[index] = id;
      indexById.set(id, index);
    }
    this.nodeIds = nodeIds;
    this.indexById = indexById;
    this.initialized = true;
    return indexById;
  }

  clear(): void {
    this.nodeIds = [];
    this.indexById = new Map();
    this.initialized = false;
  }
}
