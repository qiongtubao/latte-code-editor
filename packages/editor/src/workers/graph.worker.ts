import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import type { WorkerIn, WorkerOut } from "./protocol.js";

let nodes: any[] = [];
let edges: any[] = [];
let sim: any = null;

function postPositions() {
  const positions: Record<string,{x:number;y:number}> = {};
  for (const n of nodes as any[]) positions[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
  (self as any).postMessage({ type: "tick", positions } satisfies WorkerOut);
}

(self as any).onmessage = (e: MessageEvent<WorkerIn>) => {
  if (e.data.type === "init") {
    nodes = e.data.nodes as any[];
    edges = e.data.edges as any[];
    sim = forceSimulation(nodes)
      .force("link", forceLink(edges).id((d:any) => d.id).distance(60))
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(14))
      .on("tick", postPositions);
  } else if (e.data.type === "tick") {
    sim?.tick();
    postPositions();
  }
};
