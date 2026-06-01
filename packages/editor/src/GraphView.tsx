import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GraphNode, GraphEdge, WorkerOut } from "./workers/protocol.js";

interface GraphNeighbor { node_id: string; name: string; kind: string; edge: string }

export function GraphView({ center }: { center: string }) {
  const [positions, setPositions] = useState<Record<string,{x:number;y:number}>>({});
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL("./workers/graph.worker.ts", import.meta.url), { type: "module" });
    workerRef.current.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (e.data.type === "tick") setPositions(e.data.positions);
    };
    // Surface worker load/runtime errors (bad URL, import failure) instead
    // of silently showing an empty graph.
    workerRef.current.onerror = (e) => { console.error("graph worker error:", e); };
    return () => { workerRef.current?.terminate(); };
  }, []);

  useEffect(() => {
    if (!center) return;
    (async () => {
      // Falsy `def` means "no definition found" — bail without sending the
      // worker an empty graph.
      const def = await invoke<unknown>("cmd_definition", { symbol: center });
      if (!def) return;
      const neighbors = await invoke<GraphNeighbor[]>("cmd_neighbors", { nodeId: center, depth: 2 });
      const nodes: GraphNode[] = [{ id: center, name: center, kind: "center" }, ...neighbors.map((n) => ({ id: n.node_id, name: n.name, kind: n.kind }))];
      const edges: GraphEdge[] = neighbors.map((n) => ({ from: center, to: n.node_id, kind: n.edge }));
      workerRef.current?.postMessage({ type: "init", nodes, edges });
      for (let i = 0; i < 200; i++) workerRef.current?.postMessage({ type: "tick" });
    })().catch((err) => {
      // Match FileTree/CommandPalette: don't let a rejected IPC leak to the
      // global unhandledrejection handler.
      console.error("graph view failed:", err);
    });
  }, [center]);

  return (
    <svg viewBox="-200 -150 400 300" className="w-full h-full bg-zinc-900">
      <g>
        {Object.entries(positions).map(([id, p]) => (
          <g key={id} transform={`translate(${p.x},${p.y})`}>
            <circle r={id === center ? 7 : 4} fill={id === center ? "#60a5fa" : "#a1a1aa"} />
            <text y={-8} textAnchor="middle" fontSize={9} fill="#d4d4d8">{id}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
