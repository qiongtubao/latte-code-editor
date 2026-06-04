/// <reference lib="webworker" />

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force";

export interface SimNode {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  start_line: number;
  group: number;
}

export interface SimEdge {
  source: string;
  target: string;
  kind: string;
}

interface SimResult {
  nodes: Array<{
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    group: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: string;
  }>;
}

interface WorkerMessage {
  nodes: SimNode[];
  edges: SimEdge[];
  width: number;
  height: number;
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const { nodes: rawNodes, edges, width, height } = e.data;

  // Add initial positions to input nodes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simNodes: any[] = rawNodes.map((n) => ({
    ...n,
    x: width / 2 + (Math.random() - 0.5) * width * 0.5,
    y: height / 2 + (Math.random() - 0.5) * height * 0.5,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simulation = forceSimulation<any>(simNodes)
    .force(
      "link",
      forceLink<any, any>(edges)
        .id((d: any) => d.id)
        .distance(80)
        .strength(0.3),
    )
    .force("charge", forceManyBody().strength(-200))
    .force("center", forceCenter(width / 2, height / 2))
    .force("collide", forceCollide().radius(20))
    .alphaDecay(0.02)
    .on("tick", () => {
      const result: SimResult = {
        nodes: simNodes.map((n: any) => ({
          id: n.id,
          x: n.x,
          y: n.y,
          vx: n.vx ?? 0,
          vy: n.vy ?? 0,
          group: n.group,
        })),
        edges: edges.map((e: any) => ({
          source: typeof e.source === "string" ? e.source : (e.source as any).id,
          target: typeof e.target === "string" ? e.target : (e.target as any).id,
          kind: e.kind,
        })),
      };
      self.postMessage(result);
    });

  // Override onmessage to allow stop
  self.onmessage = (stopMsg: MessageEvent) => {
    if (stopMsg.data === "stop") {
      simulation.stop();
    }
  };
};
