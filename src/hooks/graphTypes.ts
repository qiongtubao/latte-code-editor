// Shared types for graph visualization

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    total_nodes: number;
    total_edges: number;
    node_kinds: Array<{ kind: string; count: number }>;
    edge_kinds: Array<{ kind: string; count: number }>;
  };
}

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  group: number;
}

export interface SimEdge {
  source: string;
  target: string;
  kind: string;
}

export interface SimResult {
  nodes: SimNode[];
  edges: SimEdge[];
}

/** Display mode for the graph panel */
export type GraphDisplayMode = "main" | "focus" | "full";

// Node kind to numeric group for coloring
const KIND_GROUP: Record<string, number> = {
  file: 0,
  function: 1,
  method: 1,
  constructor: 1,
  class: 2,
  struct: 2,
  interface: 2,
  trait: 2,
  type_alias: 3,
  enum: 3,
  import: 4,
  export: 4,
  constant: 5,
  variable: 5,
  property: 5,
  field: 5,
  parameter: 5,
  test: 6,
  route: 7,
  component: 7,
};

export function nodeKindToGroup(kind: string): number {
  return KIND_GROUP[kind] ?? 7;
}
