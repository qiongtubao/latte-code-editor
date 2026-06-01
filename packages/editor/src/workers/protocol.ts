export interface GraphNode { id: string; name: string; kind: string }
export interface GraphEdge { from: string; to: string; kind: string }
export type WorkerIn = { type: "init"; nodes: GraphNode[]; edges: GraphEdge[] }
                    | { type: "tick" };
export type WorkerOut = { type: "tick"; positions: Record<string, {x:number;y:number}> };
