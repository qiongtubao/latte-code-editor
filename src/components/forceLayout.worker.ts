/// <reference lib="webworker" />
import {
  forceSimulation, forceLink, forceManyBody,
  forceCenter, forceCollide, forceX, forceY,
  type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
export interface InputNode {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  start_line: number;
  group: number;
  community?: number;
}

export interface InputEdge {
  source: string;
  target: string;
  kind: string;
}

interface SimNodeDatum extends SimulationNodeDatum {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  start_line: number;
  group: number;
  community?: number;
}

type SimLinkDatum = SimulationLinkDatum<SimNodeDatum> & { kind: string };

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
  nodes: InputNode[];
  edges: InputEdge[];
  width: number;
  height: number;
  centerId?: string;
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const { nodes: rawNodes, edges: rawEdges, width, height } = e.data;

  const nodeMap = new Map(rawNodes.map((n: InputNode) => [n.id, n]));

  const simNodes: SimNodeDatum[] = rawNodes.map((n: InputNode) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    file_path: n.file_path,
    start_line: n.start_line,
    group: n.group,
    community: n.community,
    x: width / 2 + (Math.random() - 0.5) * width * 0.5,
    y: height / 2 + (Math.random() - 0.5) * height * 0.5,
  }));

  // Add community clustering: pull nodes in same community closer
  const communities = new Map<number, SimNodeDatum[]>();
  for (const n of simNodes) {
    const c = n.community ?? 0;
    if (!communities.has(c)) communities.set(c, []);
    communities.get(c)!.push(n);
  }

  const simEdges: SimLinkDatum[] = rawEdges.map((e: InputEdge) => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
  }));

  const simulation = forceSimulation<SimNodeDatum>(simNodes)
    .force(
      "link",
      forceLink<SimNodeDatum, SimLinkDatum>(simEdges)
        .id((d: SimNodeDatum) => d.id)
        .distance((d: SimLinkDatum) => {
          const kind: string = d.kind;
          return kind === "calls" ? 100 : kind === "contains" ? 60 : 80;
        })
        .strength((d: SimLinkDatum) => {
          const kind: string = d.kind;
          return kind === "calls" ? 0.6 : kind === "contains" ? 0.2 : 0.3;
        }),
    )
    .force("charge", forceManyBody<SimNodeDatum>().strength(-400))
    .force("collide", forceCollide<SimNodeDatum>().radius(30))
    .alphaDecay(0.02)
    .alpha(1);

  // Center anchoring: focus node stays center, others spread around
  const { centerId } = e.data;
  if (centerId && simNodes.find((n: SimNodeDatum) => n.id === centerId)) {
    // Strong anchor for center node
    simulation.force("centerX", forceX<SimNodeDatum>(width / 2).strength(0.05));
    simulation.force("centerY", forceY<SimNodeDatum>(height / 2).strength(0.05));
  } else {
    simulation.force("center", forceCenter(width / 2, height / 2));
  }

  simulation.on("tick", () => {
    const result: SimResult = {
      nodes: simNodes.map((n: SimNodeDatum) => ({
        id: n.id,
        x: n.x ?? 0,
        y: n.y ?? 0,
        vx: n.vx ?? 0,
        vy: n.vy ?? 0,
        group: n.group,
      })),
      edges: rawEdges.map((e: InputEdge) => ({
        source: typeof e.source === "string" ? e.source : (e.source as unknown as { id: string }).id,
        target: typeof e.target === "string" ? e.target : (e.target as unknown as { id: string }).id,
        kind: e.kind,
      })),
    };
    self.postMessage(result);
  });

  // Allow stop
  self.onmessage = (stopMsg: MessageEvent) => {
    if (stopMsg.data === "stop") {
      simulation.stop();
    }
  };
};