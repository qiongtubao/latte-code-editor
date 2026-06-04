import { useState } from "react";
import { useEffect, useRef, useCallback } from "react";
import { useGraphStore } from "../hooks/useGraphStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { CanvasGraph } from "./CanvasGraph";
import { graphGetData } from "../api/graphCommands";
import { buildCodeGraph, openFile } from "../api/commands";
import type { GraphNode, SimResult } from "../hooks/graphTypes";
import { nodeKindToGroup } from "../hooks/graphTypes";

export function GraphPanel() {
  const {
    graphData, loading, error, simNodes, simEdges,
    selectedNodeId, hoveredNodeId, highlightedNodeIds,
    loadVersion,
    setGraphData, setLoading, setError, setSimResult,
    setSelectedNode, setHoveredNode,
  } = useGraphStore();
  const { openFileOrSwitch } = useEditorStore();
  const requestReload = useGraphStore((s) => s.requestReload);
  const [rebuilding, setRebuilding] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simStarted = useRef(false);

  // Load graph data (reloads when loadVersion changes = folder opened)
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      simStarted.current = false;
      try {
        const response = await graphGetData();
        if (cancelled) return;
        setGraphData(response.data);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadVersion]);

  // Start Web Worker for force layout
  useEffect(() => {
    if (!graphData || simStarted.current) return;
    simStarted.current = true;

    const nodes = graphData.nodes.map((n: GraphNode) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      file_path: n.file_path,
      start_line: n.start_line,
      group: nodeKindToGroup(n.kind),
    }));

    const edges = graphData.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
    }));

    const worker = new Worker(
      new URL("./forceLayout.worker.ts", import.meta.url),
      { type: "module" }
    );

    workerRef.current = worker;

    const width = containerRef.current?.clientWidth || 800;
    const height = containerRef.current?.clientHeight || 600;

    worker.postMessage({ nodes, edges, width, height });

    worker.onmessage = (e: MessageEvent<SimResult>) => {
      setSimResult(e.data);
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
      simStarted.current = false;
    };
  }, [graphData, setSimResult]);

  // Update worker dimensions when container resizes
  useEffect(() => {
    if (!workerRef.current || !graphData) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          workerRef.current?.postMessage({
            nodes: graphData.nodes.map((n: GraphNode) => ({
              id: n.id,
              kind: n.kind,
              name: n.name,
              file_path: n.file_path,
              start_line: n.start_line,
              group: nodeKindToGroup(n.kind),
            })),
            edges: graphData.edges.map((e) => ({
              source: e.source,
              target: e.target,
              kind: e.kind,
            })),
            width,
            height,
          });
        }
      }
    });

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [graphData]);

  // Handle node click → open file in editor
  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      setSelectedNode(nodeId);
      const node = graphData?.nodes.find((n) => n.id === nodeId);
      if (!node) return;

      try {
        const result = await openFile(node.file_path);
        openFileOrSwitch(result);
      } catch (e) {
        console.error("Cannot open file for node:", e);
      }
    },
    [graphData, setSelectedNode, openFileOrSwitch],
  );

  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await buildCodeGraph();
      requestReload();
    } catch (e) {
      console.error("Rebuild failed:", e);
    } finally {
      setRebuilding(false);
    }
  }, [requestReload]);

  const stats = graphData?.stats;

  return (
    <div className="flex flex-col h-full" style={{ background: "#1e1e1e" }}>
      {/* Header */}
      <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-700 bg-[#252526] flex items-center justify-between">
        <span className="font-medium text-gray-300">Code Graph</span>
        <div className="flex items-center gap-3">
          {stats && (
            <span className="text-gray-500">
              {stats.total_nodes} nodes / {stats.total_edges} edges
            </span>
          )}
          <button
            onClick={handleRebuild}
            disabled={rebuilding}
            className="px-2 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Rebuild code graph from source"
          >
            {rebuilding ? "⟳" : "↻"}
          </button>
        </div>
      </div>

      {/* Loading / Error / Canvas */}
      <div ref={containerRef} className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
            Loading graph…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm px-4 text-center">
            <div>
              <p className="text-yellow-400 mb-1">⚠ No graph data</p>
              <p className="text-xs">{error}</p>
            </div>
          </div>
        )}
        {!loading && !error && simNodes.length > 0 && (
          <CanvasGraph
            simNodes={simNodes}
            simEdges={simEdges}
            selectedNodeId={selectedNodeId}
            hoveredNodeId={hoveredNodeId}
            highlightedNodeIds={highlightedNodeIds}
            onNodeClick={handleNodeClick}
            onNodeHover={setHoveredNode}
          />
        )}
      </div>

      {/* Legend */}
      <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-700 bg-[#252526] flex flex-wrap gap-3">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#cc7832" }} /> File
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#6a8759" }} /> Function
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#6897bb" }} /> Class
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#9876aa" }} /> Type
        </span>
      </div>
    </div>
  );
}
