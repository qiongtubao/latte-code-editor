/// <reference lib="webworker" />
import {
  forceSimulation, forceLink, forceManyBody,
  forceCenter, forceCollide, forceX, forceY,
  type SimulationLinkDatum, type SimulationNodeDatum,
  type Simulation,
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

/**
 * 单例 simulation：所有 message 都走同一个 handler
 * 之前代码有 bug：第二个 `self.onmessage = ...` 覆盖了第一个，
 * 导致主线程 postMessage 的数据实际跑到"stop"分支里，
 * 仿真永远不启动，hasWorker 永远 false，canvas 永远不渲染。
 */
let simulation: Simulation<SimNodeDatum, SimLinkDatum> | null = null;
console.log("[worker] module loaded");
// 发送 ready 确认，让主线程知道 worker 已加载（某些 WebView 不转发 worker console）
self.postMessage({ type: "ready" });
self.onmessage = (e: MessageEvent<WorkerMessage | string>) => {
  console.log("[worker] onmessage, type=", typeof e.data, "nodes?", (e.data as WorkerMessage).nodes?.length);
  // "stop" 是控制消息
  if (typeof e.data === "string" && e.data === "stop") {
    simulation?.stop();
    return;
  }

  // 重新进入布局前先清掉旧的
  simulation?.stop();
  simulation = null;

  const { nodes: rawNodes, edges: rawEdges, width, height, centerId } = e.data as WorkerMessage;
  console.log("[worker] simulating", rawNodes.length, "nodes,", rawEdges.length, "edges");
  const simNodes: SimNodeDatum[] = rawNodes.map((n) => ({
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

  // Community clustering
  const communities = new Map<number, SimNodeDatum[]>();
  for (const n of simNodes) {
    const c = n.community ?? 0;
    if (!communities.has(c)) communities.set(c, []);
    communities.get(c)!.push(n);
  }

  const simEdges: SimLinkDatum[] = rawEdges.map((e) => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
  }));

  simulation = forceSimulation<SimNodeDatum>(simNodes)
    .force(
      "link",
      forceLink<SimNodeDatum, SimLinkDatum>(simEdges)
        .id((d) => d.id)
        .distance((d) => {
          const kind = d.kind;
          return kind === "calls" ? 100 : kind === "contains" ? 60 : 80;
        })
        .strength((d) => {
          const kind = d.kind;
          return kind === "calls" ? 0.6 : kind === "contains" ? 0.2 : 0.3;
        }),
    )
    .force("charge", forceManyBody<SimNodeDatum>().strength(-400))
    .force("collide", forceCollide<SimNodeDatum>().radius(30))
    .alphaDecay(0.02)
    .alpha(1);

  // Center anchoring: focus node stays center
  if (centerId && simNodes.find((n) => n.id === centerId)) {
    simulation.force("centerX", forceX<SimNodeDatum>(width / 2).strength(0.05));
    simulation.force("centerY", forceY<SimNodeDatum>(height / 2).strength(0.05));
  } else {
    simulation.force("center", forceCenter(width / 2, height / 2));
  }

  simulation.on("tick", () => {
    if (!simulation) return;
    const result: SimResult = {
      nodes: simNodes.map((n) => ({
        id: n.id,
        x: n.x ?? 0,
        y: n.y ?? 0,
        vx: n.vx ?? 0,
        vy: n.vy ?? 0,
        group: n.group,
      })),
      edges: rawEdges.map((e) => ({
        source: typeof e.source === "string" ? e.source : (e.source as unknown as { id: string }).id,
        target: typeof e.target === "string" ? e.target : (e.target as unknown as { id: string }).id,
        kind: e.kind,
      })),
    };
    self.postMessage(result);
  });
};
