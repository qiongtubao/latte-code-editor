import { useMemo } from "react";
import type { GraphData } from "./graphTypes";
import { detectCommunities } from "./graphUtils";

export interface GraphAnalysis {
  communityMap: Map<string, number>;
  totalStats: {
    nodes: number;
    edges: number;
    communities: number;
  };
}

export function useGraphAnalysis(graphData: GraphData | null): GraphAnalysis {
  return useMemo(() => {
    if (!graphData) {
      return {
        communityMap: new Map(),
        totalStats: { nodes: 0, edges: 0, communities: 0 },
      };
    }

    const communities = detectCommunities(graphData.nodes, graphData.edges);
    const communityMap = new Map<string, number>();
    for (const community of communities) {
      for (const nodeId of community.nodeIds) {
        communityMap.set(nodeId, community.rank);
      }
    }

    return {
      communityMap,
      totalStats: {
        nodes: graphData.nodes.length,
        edges: graphData.edges.length,
        communities: communities.length,
      },
    };
  }, [graphData]);
}
