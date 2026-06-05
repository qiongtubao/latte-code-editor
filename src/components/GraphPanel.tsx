import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useGraphStore } from "../hooks/useGraphStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { CanvasGraph } from "./CanvasGraph";
import { graphGetData, graphFindDefinitions } from "../api/graphCommands";
import { openFile, buildCodeGraph } from "../api/commands";
import type { GraphNode, SimResult } from "../hooks/graphTypes";
import { nodeKindToGroup } from "../hooks/graphTypes";
import { NODE_COLORS } from "./graphRenderer";

type GraphMode = "module" | "full";

export function GraphPanel() {
  const {
    graphData, loading, error, simNodes, simEdges,
    selectedNodeId, hoveredNodeId, highlightedNodeIds, loadVersion,
    setGraphData, setLoading, setError, setSimResult,
    setSelectedNode, setHoveredNode, requestReload,
  } = useGraphStore();
  const { openFileOrSwitch } = useEditorStore();
  const workerRef = useRef<Worker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simStarted = useRef(false);
  const [mode, setMode] = useState<GraphMode>("module");
  const [rebuilding, setRebuilding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);

  // Load graph data
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
  }, [loadVersion, setGraphData, setLoading, setError]);

  // Filter nodes
  const filteredData = useMemo(() => {
    if (!graphData) return null;
    if (mode === "module") {
      const fileNodes = graphData.nodes.filter((n) => n.kind === "file");
      const fileIds = new Set(fileNodes.map((n) => n.id));
      const edges = graphData.edges.filter(
        (e) => e.kind === "imports" && fileIds.has(e.source) && fileIds.has(e.target),
      );
      return { nodes: fileNodes, edges };
    }
    return graphData;
  }, [graphData, mode]);

  // Start worker
  useEffect(() => {
    if (!filteredData || simStarted.current) return;
    simStarted.current = true;

    const sNodes = filteredData.nodes.map((n) => ({
      id: n.id, kind: n.kind, name: n.name,
      file_path: n.file_path, start_line: n.start_line,
      group: nodeKindToGroup(n.kind),
    }));
    const sEdges = filteredData.edges.map((e) => ({
      source: e.source, target: e.target, kind: e.kind,
    }));

    const worker = new Worker(new URL("./forceLayout.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    const w = containerRef.current?.clientWidth || 800;
    const h = containerRef.current?.clientHeight || 600;
    worker.postMessage({ nodes: sNodes, edges: sEdges, width: w, height: h });

    worker.onmessage = (e: MessageEvent<SimResult>) => setSimResult(e.data);

    return () => { worker.terminate(); workerRef.current = null; simStarted.current = false; };
  }, [filteredData, setSimResult]);

  // Resize observer
  useEffect(() => {
    if (!workerRef.current || !filteredData) return;
    const cb = () => {
      if (!containerRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width > 0 && height > 0) {
        workerRef.current?.postMessage({
          nodes: filteredData.nodes.map((n) => ({
            id: n.id, kind: n.kind, name: n.name,
            file_path: n.file_path, start_line: n.start_line,
            group: nodeKindToGroup(n.kind),
          })),
          edges: filteredData.edges.map((e) => ({
            source: e.source, target: e.target, kind: e.kind,
          })),
          width, height,
        });
      }
    };
    const observer = new ResizeObserver(cb);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [filteredData]);

  // Node click
  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      setSelectedNode(nodeId);
      const node = filteredData?.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      try {
        const result = await openFile(node.file_path);
        useEditorStore.getState().setTargetLine(node.start_line);
        openFileOrSwitch(result);
      } catch (e) {
        console.error("Cannot open file:", e);
      }
    },
    [filteredData, setSelectedNode, openFileOrSwitch],
  );

  // Rebuild
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

  // Switch mode
  const switchMode = useCallback((m: GraphMode) => {
    if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; }
    simStarted.current = false;
    setSimResult({ nodes: [], edges: [] });
    setMode(m);
  }, [setSimResult]);

  // Zoom fit
  const handleZoomFit = useCallback(() => {
    if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; }
    simStarted.current = false;
    setSimResult({ nodes: [], edges: [] });
  }, [setSimResult]);

  // Search
  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    try {
      const resp = await graphFindDefinitions(q);
      setSearchResults(resp.nodes);
    } catch {
      setSearchResults([]);
    }
  }, [searchQuery]);

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;

  return (
    <div className="flex flex-col h-full" style={{ background: "#1e1e1e" }}>
      {/* Header */}
      <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-700 bg-[#252526]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-300">Code Graph</span>
            <button
              onClick={() => switchMode("module")}
              className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                mode === "module" ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-400 hover:text-gray-200"
              }`}
            >
              Module
            </button>
            <button
              onClick={() => switchMode("full")}
              className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                mode === "full" ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-400 hover:text-gray-200"
              }`}
            >
              Full
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">{nodeCount}n / {edgeCount}e</span>
            <button onClick={handleZoomFit} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer text-xs" title="Reset zoom">⊞</button>
            <button onClick={handleRebuild} disabled={rebuilding} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer disabled:opacity-50 text-xs" title="Rebuild graph">{rebuilding ? "⟳" : "↻"}</button>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 mt-1.5">
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder="Search symbols (Enter)..."
            className="flex-1 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded text-xs outline-none focus:border-[#007acc]"
          />
          {searchResults.length > 0 && (
            <button onClick={() => { setSearchResults([]); setSearchQuery(""); }}
              className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer text-xs"
            >× ({searchResults.length})</button>
          )}
        </div>

        {/* Search results */}
        {searchResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-[#333] border border-gray-700 rounded text-xs">
            {searchResults.slice(0, 20).map((r) => (
              <div key={r.id} onClick={async () => {
                try {
                  const result = await openFile(r.file_path);
                  useEditorStore.getState().setTargetLine(r.start_line);
                  openFileOrSwitch(result);
                } catch {}
              }} className="flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-[#094771]">
                <span className="w-2 h-2 rounded-full" style={{ background: NODE_COLORS[nodeKindToGroup(r.kind)] }} />
                <span className="text-gray-200">{r.name}</span>
                <span className="text-gray-500">{r.kind}</span>
                <span className="text-gray-600 ml-auto truncate">{r.file_path}:{r.start_line}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative">
        {loading && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">Loading graph…</div>}
        {error && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm px-4 text-center"><div><p className="text-yellow-400 mb-1">⚠ No graph data</p><p className="text-xs">{error}</p></div></div>}
        {!loading && !error && simNodes.length === 0 && filteredData && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">No nodes to display</div>}
        {simNodes.length > 0 && (
          <CanvasGraph simNodes={simNodes} simEdges={simEdges} selectedNodeId={selectedNodeId} hoveredNodeId={hoveredNodeId} highlightedNodeIds={highlightedNodeIds} onNodeClick={handleNodeClick} onNodeHover={setHoveredNode} />
        )}
      </div>

      {/* Legend */}
      <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-700 bg-[#252526] flex flex-wrap gap-3">
        {mode === "full" && (
          <>
            <span><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#cc7832" }} /> File</span>
            <span><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#6a8759" }} /> Function</span>
            <span><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#6897bb" }} /> Class</span>
          </>
        )}
        {mode === "module" && <span className="text-gray-400">Module dependency — files connected by imports</span>}
        <span className="text-gray-600 ml-auto">{nodeCount} visible</span>
      </div>
    </div>
  );
}
