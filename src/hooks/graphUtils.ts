/**
 * Graph utilities: community detection, subgraph extraction, impact analysis.
 */
export interface RawNode {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  start_line?: number;
}

export interface RawEdge {
  id?: string;
  source: string;
  target: string;
  kind: string;
}

/** A detected community (connected component). */
export interface Community {
  id: number;
  nodeIds: Set<string>;
  /** Average x/y for placement */
  cx: number;
  cy: number;
  /** Size rank */
  rank: number;
}

/**
 * Find all connected components in the graph using BFS.
 * Returns communities sorted by size (largest first).
 */
export function detectCommunities(
  nodes: RawNode[],
  edges: RawEdge[],
): Community[] {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  const visited = new Set<string>();
  const communities: Community[] = [];

  for (const node of nodes) {
    if (visited.has(node.id)) continue;

    const component = new Set<string>();
    const queue = [node.id];
    visited.add(node.id);

    while (queue.length > 0) {
      const cur = queue.pop()!;
      component.add(cur);
      for (const neighbor of adj.get(cur) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.size > 0) {
      communities.push({
        id: communities.length,
        nodeIds: component,
        cx: 0,
        cy: 0,
        rank: 0,
      });
    }
  }

  // Sort by size descending
  communities.sort((a, b) => b.nodeIds.size - a.nodeIds.size);
  communities.forEach((c, i) => (c.rank = i));

  return communities;
}

/**
 * Extract subgraph around a node (BFS up to `depth` hops).
 * Includes ALL edge kinds connecting the nodes: calls, imports, contains, etc.
 */
export function extractSubgraph(
  nodes: RawNode[],
  edges: RawEdge[],
  centerId: string,
  depth: number,
): { nodes: RawNode[]; edges: RawEdge[] } {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Build adjacency AND edge index for fast lookup
  const adj = new Map<string, Set<string>>();
  const edgeIndex = new Map<string, RawEdge[]>();  // source|target → edges
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
    // Index edges by both source and target for quick retrieval
    if (!edgeIndex.has(e.source)) edgeIndex.set(e.source, []);
    if (!edgeIndex.has(e.target)) edgeIndex.set(e.target, []);
    edgeIndex.get(e.source)!.push(e);
    edgeIndex.get(e.target)!.push(e);
  }

  const visited = new Set<string>();
  const resultNodes: RawNode[] = [];
  const resultEdgeSet = new Set<string>();
  const resultEdges: RawEdge[] = [];

  const queue: Array<[string, number]> = [[centerId, 0]];
  visited.add(centerId);

  while (queue.length > 0) {
    const [curId, d] = queue.shift()!;
    const n = nodeMap.get(curId);
    if (n) resultNodes.push(n);

    if (d >= depth) continue;

    for (const neighbor of adj.get(curId) ?? []) {
      // Use the edge index to find edges between curId and neighbor
      for (const e of edgeIndex.get(curId) ?? []) {
        if (
          (e.source === curId && e.target === neighbor) ||
          (e.source === neighbor && e.target === curId)
        ) {
          const key = `${e.source}→${e.target}:${e.kind}`;
          if (!resultEdgeSet.has(key)) {
            resultEdgeSet.add(key);
            resultEdges.push(e);
          }
        }
      }

      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, d + 1]);
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges };
}

/** Result of a focused subgraph extraction with caller/callee separation. */
export interface FocusSubgraph {
  center: RawNode;
  callers: RawNode[];
  callees: RawNode[];
  edges: RawEdge[];
  totalCallers: number;
  totalCallees: number;
  truncated: boolean;
}

/**
 * Extract a depth=1 focus subgraph: center node + direct callers (left) + callees (right).
 * Truncates to `maxNeighbors` total, sorted by connection count descending.
 * Returns callers and callees separately so the layout can position them left/right.
 */
export function extractFocusSubgraph(
  nodes: RawNode[],
  edges: RawEdge[],
  centerId: string,
  maxNeighbors: number,
): FocusSubgraph | null {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const center = nodeMap.get(centerId);
  if (!center) return null;

  // Count connection scores for sorting by importance
  const callerScore = new Map<string, number>();
  const calleeScore = new Map<string, number>();
  const resultEdges: RawEdge[] = [];
  const edgeSet = new Set<string>();

  for (const e of edges) {
    if (e.source === centerId && e.kind === "calls") {
      const target = nodeMap.get(e.target);
      if (target) {
        calleeScore.set(e.target, (calleeScore.get(e.target) ?? 0) + 1);
        const key = `${e.source}→${e.target}:${e.kind}`;
        if (!edgeSet.has(key)) { edgeSet.add(key); resultEdges.push(e); }
      }
    }
    if (e.target === centerId && e.kind === "calls") {
      const source = nodeMap.get(e.source);
      if (source) {
        callerScore.set(e.source, (callerScore.get(e.source) ?? 0) + 1);
        const key = `${e.source}→${e.target}:${e.kind}`;
        if (!edgeSet.has(key)) { edgeSet.add(key); resultEdges.push(e); }
      }
    }
  }

  // Sort by score descending and truncate
  const sortByScore = (map: Map<string, number>): RawNode[] =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => nodeMap.get(id)!)
      .filter((n): n is RawNode => n != null);

  const allCallers = sortByScore(callerScore);
  const allCallees = sortByScore(calleeScore);
  const totalCallers = allCallers.length;
  const totalCallees = allCallees.length;

  // Allocate: give more slots to callers or callees whichever is more important
  const callerSlots = Math.min(allCallers.length, Math.ceil(maxNeighbors / 2));
  const calleeSlots = Math.min(allCallees.length, maxNeighbors - callerSlots);
  const truncated = allCallers.length > callerSlots || allCallees.length > calleeSlots;

  const callers = allCallers.slice(0, callerSlots);
  const callees = allCallees.slice(0, calleeSlots);

  return { center, callers, callees, edges: resultEdges, totalCallers, totalCallees, truncated };
}

/** Check if a node ID is unresolved (contains * placeholder). */
export function isUnresolved(id: string): boolean {
  return id.includes(":*") || id.includes("*:");
}
export function getDefaultSubgraph(
  nodes: RawNode[],
  edges: RawEdge[],
  maxNodes: number,
): { nodes: RawNode[]; edges: RawEdge[]; label: string; centerId: string | null } {
  if (nodes.length === 0) return { nodes: [], edges: [], label: "empty", centerId: null };

  // Build adjacency: caller → callees
  const callCount = new Map<string, number>();  // how many callers each function has
  const callerMap = new Map<string, string[]>(); // function → list of callers
  for (const e of edges) {
    if (e.kind !== "calls") continue;
    const callee = e.target;
    const caller = e.source;
    callCount.set(callee, (callCount.get(callee) ?? 0) + 1);
    if (!callerMap.has(callee)) callerMap.set(callee, []);
    callerMap.get(callee)!.push(caller);
  }

  // Strategy 1: Find the most important "main" function
  // Prefer main in src/ over tests/ or utils/
  let centerId: string | null = null;
  let label = "";

  const mains = nodes.filter(
    (n) => n.name === "main" && (n.kind === "function" || n.kind === "method"),
  );
  const mainNode = mains.find((n) => n.file_path.startsWith("src/"))
    ?? mains.find((n) => !n.file_path.includes("utils/") && !n.file_path.includes("test/"))
    ?? mains[0];
  if (mainNode) {
    centerId = mainNode.id;
    label = `main: ${mainNode.name} (${mainNode.file_path})`;
  } else {
    // Strategy 2: Find the function with the MOST callers
    let bestScore = 0;
    for (const n of nodes) {
      if (n.kind === "file" || n.kind === "import" || n.kind === "export") continue;
      const score = callCount.get(n.id) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        centerId = n.id;
        label = `entry: ${n.name}`;
      }
    }
  }

  if (centerId) {
    // Try depth=2 first, fall back to depth=1 if too many nodes
    for (const depth of [2, 1]) {
      const sub = extractSubgraph(nodes, edges, centerId, depth);
      if (sub.nodes.length <= maxNodes) {
        return { ...sub, label, centerId };
      }
    }
    // 2-hop still too big: take 1-hop and limit
    const sub = extractSubgraph(nodes, edges, centerId, 1);
    return { ...sub, label, centerId: centerId! };
  }

  // Strategy 3: Largest community
  const communities = detectCommunities(nodes, edges);
  if (communities.length === 0) return { nodes: [], edges: [], label: "empty", centerId: null };

  for (const c of communities) {
    if (c.nodeIds.size <= maxNodes) {
      const cnodes = nodes.filter((n) => c.nodeIds.has(n.id));
      const cset = new Set(c.nodeIds);
      const cedges = edges.filter((e) => cset.has(e.source) && cset.has(e.target));
      const first = cnodes[0]?.id ?? null;
      const mainLabel = `community #${c.rank + 1} (${cnodes.length} nodes)`;
      return { nodes: cnodes, edges: cedges, label: mainLabel, centerId: first };
    }
  }

  // Last resort: top-N from largest community
  const largest = communities[0];
  const cnodes = nodes.filter((n) => largest.nodeIds.has(n.id)).slice(0, maxNodes);
  const cset = new Set(cnodes.map((n) => n.id));
  const cedges = edges.filter((e) => cset.has(e.source) && cset.has(e.target));
  return {
    nodes: cnodes,
    edges: cedges,
    label: `largest community (showing ${cnodes.length}/${largest.nodeIds.size} nodes)`,
    centerId: cnodes[0]?.id ?? null,
  };
}

/**
 * Group nodes by community for coloring.
 */
export function assignCommunityColors(
  nodes: RawNode[],
  edges: RawEdge[],
): Map<string, number> {
  const communities = detectCommunities(nodes, edges);
  const colorMap = new Map<string, number>();
  communities.forEach((c) => {
    for (const id of c.nodeIds) {
      colorMap.set(id, c.rank);
    }
  });
  return colorMap;
}
