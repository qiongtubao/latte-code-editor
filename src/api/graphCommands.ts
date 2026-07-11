import { invoke } from "@tauri-apps/api/core";
import type { GraphData } from "../hooks/graphTypes";

export interface GraphGetDataResponse {
  data: GraphData;
}

export interface GraphSearchResponse {
  nodes: GraphData["nodes"];
}

export interface GraphSubgraphResponse {
  data: GraphData;
}

export async function graphGetData(): Promise<GraphGetDataResponse> {
  return invoke<GraphGetDataResponse>("graph_get_data");
}

export async function graphSearch(query: string): Promise<GraphSearchResponse> {
  return invoke<GraphSearchResponse>("graph_search", { query });
}
export async function graphFindDefinitions(name: string, callerPath?: string): Promise<GraphSearchResponse> {
  return invoke<GraphSearchResponse>("graph_find_definitions", { name, callerPath });
}

export async function graphGetSubgraph(
  nodeId: string,
  depth: number,
): Promise<GraphSubgraphResponse> {
  return invoke<GraphSubgraphResponse>("graph_get_subgraph", {
    nodeId,
    depth,
  });
}
