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
  id: number;
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

// Node kind to numeric group for coloring
export function nodeKindToGroup(kind: string): number {
  switch (kind) {
    case "file": return 0;
    case "function":
    case "method": return 1;
    case "class":
    case "interface":
    case "struct": return 2;
    case "type":
    case "type_alias":
    case "enum": return 3;
    case "import":
    case "export": return 4;
    case "constant":
    case "variable": return 5;
    case "test": return 6;
    default: return 7;
  }
}
