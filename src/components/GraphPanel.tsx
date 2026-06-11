import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useGraphStore } from "../hooks/useGraphStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { useSettingsStore } from "../hooks/useSettingsStore";
import { CanvasGraph } from "./CanvasGraph";
import { graphGetData, graphSearch } from "../api/graphCommands";
import { openFile, buildCodeGraph, searchInFiles, type SearchMatch } from "../api/commands";
import {
  getDefaultSubgraph, detectCommunities, extractFocusSubgraph,
  type RawNode, type RawEdge,
} from "../hooks/graphUtils";
import type { GraphNode, SimResult, GraphDisplayMode } from "../hooks/graphTypes";
import { nodeKindToGroup } from "../hooks/graphTypes";
import { NODE_COLORS } from "./graphRenderer";

export function GraphPanel() {
  const {
    graphData, loading, error, simNodes, simEdges,
    selectedNodeId, hoveredNodeId, highlightedNodeIds, loadVersion,
    setGraphData, setLoading, setError, setSimResult,
    setSelectedNode, setHoveredNode, setHighlightedNodes, requestReload,
  } = useGraphStore();
  const { openFileOrSwitch } = useEditorStore();
  const workerRef = useRef<Worker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simStarted = useRef(false);
  const [displayMode, setDisplayMode] = useState<GraphDisplayMode>("main");
  const [displayLabel, setDisplayLabel] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
  const [searchTextResults, setSearchTextResults] = useState<SearchMatch[]>([]);
  const [searchTab, setSearchTab] = useState<"symbols" | "files" | "text">("symbols");
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [focusMeta, setFocusMeta] = useState<{ total: number; callers: number; callees: number; truncated: boolean } | null>(null);

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

  // Filtered data
  const filteredData = useMemo(() => {
    if (!graphData) return null;
    const rawNodes: RawNode[] = graphData.nodes;
    const rawEdges: RawEdge[] = graphData.edges;

    if (displayMode === "main") {
      const sigNodes = rawNodes.filter((n) => n.kind !== "file" && n.kind !== "import");
      const sigIds = new Set(sigNodes.map((n) => n.id));
      const sigEdges = rawEdges.filter((e) => sigIds.has(e.source) && sigIds.has(e.target));
      const sub = sigNodes.length > 0 ? getDefaultSubgraph(sigNodes, sigEdges, 80) : getDefaultSubgraph(rawNodes, rawEdges, 80);
      if (sub.nodes.length === 0 && rawNodes.length > 0) {
        const fb = rawNodes.slice(0, 30);
        const fbId = new Set(fb.map((n) => n.id));
        return { nodes: fb, edges: rawEdges.filter((e) => fbId.has(e.source) && fbId.has(e.target)) };
      }
      if (sub.nodes.length > 0) setDisplayLabel(sub.label);
      if (sub.centerId) queueMicrotask(() => setSelectedNode(sub.centerId!));
      return sub;
    }

    if (displayMode === "focus" && focusedNodeId) {
      const focus = extractFocusSubgraph(rawNodes, rawEdges, focusedNodeId, 30);
      if (focus) {
        setDisplayLabel(`focus: ${focus.center.name}`);
        setFocusMeta({ total: focus.totalCallers + focus.totalCallees, callers: focus.callers.length, callees: focus.callees.length, truncated: focus.truncated });
        const allNodes = [...focus.callers, focus.center, ...focus.callees];
        const ids = new Set(allNodes.map((n) => n.id));
        return { nodes: allNodes, edges: focus.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
      }
      return { nodes: [], edges: [] };
    }
    return graphData;
  }, [graphData, displayMode, focusedNodeId, setSelectedNode]);

  const communityMap = useMemo(() => {
    if (!graphData) return new Map<string, number>();
    const map = new Map<string, number>();
    detectCommunities(graphData.nodes, graphData.edges).forEach((c) => { for (const id of c.nodeIds) map.set(id, c.rank); });
    return map;
  }, [graphData]);

  const totalStats = useMemo(() => {
    if (!graphData) return { nodes: 0, edges: 0, communities: 0 };
    const c = detectCommunities(graphData.nodes, graphData.edges);
    return { nodes: graphData.nodes.length, edges: graphData.edges.length, communities: c.length };
  }, [graphData]);

  // Layout
  useEffect(() => {
    if (!filteredData || simStarted.current) return;
    simStarted.current = true;

    const sNodes = filteredData.nodes.map((n) => ({
      id: n.id, kind: n.kind, name: n.name, file_path: n.file_path, start_line: n.start_line ?? 0,
      group: nodeKindToGroup(n.kind), community: communityMap.get(n.id) ?? 0,
    }));
    const sEdges = filteredData.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

    if (displayMode === "focus" && focusedNodeId) {
      const cx = (containerRef.current?.clientWidth ?? 800) / 2;
      const cy = (containerRef.current?.clientHeight ?? 600) / 2;
      const ci = sNodes.findIndex((n) => n.id === focusedNodeId);
      if (ci >= 0) {
        const callers = sNodes.slice(0, ci);
        const callees = sNodes.slice(ci + 1);
        const gap = Math.min(280, Math.max(140, cx * 0.35));
        setSimResult({
          nodes: [
            ...callers.map((n, i) => ({ id: n.id, x: cx - gap, y: cy - ((callers.length - 1) * 28) / 2 + i * 28, vx: 0, vy: 0, group: n.group })),
            { id: focusedNodeId, x: cx, y: cy, vx: 0, vy: 0, group: nodeKindToGroup(filteredData.nodes[ci].kind) },
            ...callees.map((n, i) => ({ id: n.id, x: cx + gap, y: cy - ((callees.length - 1) * 28) / 2 + i * 28, vx: 0, vy: 0, group: n.group })),
          ],
          edges: sEdges,
        });
        return;
      }
    }

    const circle = (): SimResult => {
      const cx = (containerRef.current?.clientWidth ?? 800) / 2;
      const cy = (containerRef.current?.clientHeight ?? 600) / 2;
      const r = Math.min(cx, cy) * 0.3;
      return { nodes: sNodes.map((n, i) => ({ id: n.id, x: cx + Math.cos((i / sNodes.length) * Math.PI * 2) * r, y: cy + Math.sin((i / sNodes.length) * Math.PI * 2) * r, vx: 0, vy: 0, group: n.group })), edges: sEdges };
    };
    if (sNodes.length <= 3) { setSimResult(circle()); return; }

    const w = new Worker(new URL("./forceLayout.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    const t = setTimeout(() => { if (workerRef.current === w) setSimResult(circle()); }, 3000);
    w.onmessage = (e: MessageEvent<SimResult>) => { clearTimeout(t); setSimResult(e.data); };
    w.onerror = () => { clearTimeout(t); setSimResult(circle()); };
    w.postMessage({ nodes: sNodes, edges: sEdges, width: containerRef.current?.clientWidth || 800, height: containerRef.current?.clientHeight || 600 });
    return () => { clearTimeout(t); w.terminate(); workerRef.current = null; simStarted.current = false; };
  }, [filteredData, setSimResult, communityMap, displayMode, focusedNodeId]);

  // Resize
  useEffect(() => {
    if (!workerRef.current || !filteredData) return;
    const o = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width > 0 && height > 0) workerRef.current?.postMessage({ nodes: filteredData.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name, file_path: n.file_path, start_line: n.start_line ?? 0, group: nodeKindToGroup(n.kind), community: communityMap.get(n.id) ?? 0 })), edges: filteredData.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind })), width, height });
    });
    if (containerRef.current) o.observe(containerRef.current);
    return () => o.disconnect();
  }, [filteredData, communityMap]);

  // ========== Callbacks ==========
  const handleNodeClick = useCallback(async (nodeId: string) => {
    setSelectedNode(nodeId);
    const node = filteredData?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    try { const r = await openFile(node.file_path); useEditorStore.getState().setTargetLine(node.start_line ?? null); openFileOrSwitch(r); } catch { /* ignore */ }
  }, [filteredData, setSelectedNode, openFileOrSwitch]);

  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    try { await buildCodeGraph(); requestReload(); } catch (e) { console.error("Rebuild:", e); } finally { setRebuilding(false); }
  }, [requestReload]);

  const switchMode = useCallback((m: GraphDisplayMode) => {
    workerRef.current?.terminate(); workerRef.current = null; simStarted.current = false;
    setSimResult({ nodes: [], edges: [] }); setDisplayMode(m); setFocusedNodeId(null); setFocusMeta(null); setDisplayLabel("");
  }, [setSimResult]);

  const handleZoomFit = useCallback(() => {
    workerRef.current?.terminate(); workerRef.current = null; simStarted.current = false;
    setSimResult({ nodes: [], edges: [] }); setDisplayLabel("");
  }, [setSimResult]);

  const handleNodeContextMenu = useCallback((nodeId: string, x: number, y: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    setContextMenu({ x: x - (rect?.left ?? 0), y: y - (rect?.top ?? 0), nodeId });
    setSelectedNode(nodeId);
  }, [setSelectedNode]);

  const handleSearchSelect = useCallback(async (node: GraphNode) => {
    setSearchResults([]); setSearchQuery(node.name);
    if (node.kind === "file") {
      try { const r = await openFile(node.file_path); openFileOrSwitch(r); } catch { /* ignore */ }
      return;
    }
    setFocusedNodeId(node.id); setSelectedNode(node.id);
    workerRef.current?.terminate(); workerRef.current = null; simStarted.current = false;
    setSimResult({ nodes: [], edges: [] });
    if (graphData) {
      const ids = new Set<string>(); ids.add(node.id);
      for (const e of graphData.edges) { if (e.source === node.id) ids.add(e.target); if (e.target === node.id) ids.add(e.source); }
      setHighlightedNodes(ids);
    }
    setDisplayMode("focus"); setDisplayLabel(`focus: ${node.name}`);
    try { const r = await openFile(node.file_path); useEditorStore.getState().setTargetLine(node.start_line ?? null); openFileOrSwitch(r); } catch { /* ignore */ }
  }, [graphData, setSelectedNode, setSimResult, setHighlightedNodes, openFileOrSwitch]);

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    try {
      if (searchTab === "text") {
        setSearchTextResults(await searchInFiles(q));
        setSearchResults([]);
        return;
      }
      const resp = await graphSearch(q);
      let results: GraphNode[];
      if (searchTab === "files") {
        results = resp.nodes.filter((n) => n.kind === "file");
        if (results.length === 0) results = resp.nodes.filter((n) => n.file_path.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
      } else {
        results = resp.nodes.filter((n) => n.kind !== "file");
      }
      setSearchTextResults([]);
      if (results.length === 1) { handleSearchSelect(results[0]); } else { setSearchResults(results); }
    } catch { setSearchResults([]); }
  }, [searchQuery, searchTab, handleSearchSelect]);

  const handleSearchTextClick = useCallback(async (m: SearchMatch) => {
    setSearchTextResults([]); setSearchQuery(m.file_path.split("/").pop() ?? "");
    try {
      const root = await graphGetData();
      const node = root.data.nodes.find((n) => n.file_path === m.file_path);
      if (node) {
        const r = await openFile(node.file_path);
        useEditorStore.getState().setTargetLine(m.line_number);
        openFileOrSwitch(r);
      }
    } catch { /* ignore */ }
  }, [openFileOrSwitch]);

  const handleContextJumpToCode = useCallback(async () => {
    if (!contextMenu) return;
    const { nodeId } = contextMenu; setContextMenu(null);
    const node = filteredData?.nodes.find((n) => n.id === nodeId); if (!node) return;
    try { const r = await openFile(node.file_path); useEditorStore.getState().setTargetLine(node.start_line ?? null); openFileOrSwitch(r); } catch { /* ignore */ }
  }, [contextMenu, filteredData, openFileOrSwitch]);

  const handleContextExpand = useCallback(() => {
    if (!contextMenu) return; setContextMenu(null);
    handleSearchSelect({ id: contextMenu.nodeId, name: "", kind: "", file_path: "", start_line: 0, qualified_name: "", language: "", end_line: 0, signature: null } as GraphNode);
  }, [contextMenu, handleSearchSelect]);

  const handleContextCopyName = useCallback(() => {
    if (!contextMenu) return; setContextMenu(null);
    const node = filteredData?.nodes.find((n) => n.id === contextMenu.nodeId);
    if (node) navigator.clipboard.writeText(node.name).catch(() => {});
  }, [contextMenu, filteredData]);

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;
  const hasWorker = simNodes.length > 0;

  return (
    <div className="flex flex-col h-full" style={{ background: "#1e1e1e" }}>
      <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-700 bg-[#252526]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="font-medium text-gray-300 mr-1">Code Graph</span>
            {(["main", "full"] as const).map((m) => (
              <button key={m} onClick={() => switchMode(m)} className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${displayMode === m ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-400 hover:text-gray-200"}`}>{m === "main" ? "Main" : "Full"}</button>
            ))}
            {displayMode === "focus" && <span className="flex items-center gap-1 ml-1"><span className="px-1.5 py-0.5 bg-[#094771] text-blue-200 rounded text-[10px]">Focus</span><button onClick={() => switchMode("main")} className="px-1 py-0.5 bg-[#3a3a3a] text-gray-300 rounded cursor-pointer text-[10px] hover:bg-[#4a4a4a]">×</button></span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">{displayLabel || `${nodeCount}n`}</span>
            <button onClick={handleZoomFit} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer text-xs">⊞</button>
            <button onClick={handleRebuild} disabled={rebuilding} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer disabled:opacity-50 text-xs">{rebuilding ? "⟳" : "↻"}</button>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-1 mt-1.5">
          {(["symbols", "files", "text"] as const).map((tab) => (
            <button key={tab} onClick={() => { setSearchTab(tab); setSearchResults([]); setSearchTextResults([]); }} className={`px-2 py-0.5 rounded text-[10px] cursor-pointer ${searchTab === tab ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-400"}`}>{tab}</button>
          ))}
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder={`Search ${searchTab}...`}
            className="flex-1 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded text-xs outline-none focus:border-[#007acc]" />
          {(searchResults.length > 0 || searchTextResults.length > 0) && (
            <button onClick={() => { setSearchResults([]); setSearchTextResults([]); setSearchQuery(""); }} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer text-xs">×</button>
          )}
        </div>

        {/* Search results */}
        {searchResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-[#333] border border-gray-700 rounded text-xs">
            {searchResults.slice(0, 20).map((r) => (
              <div key={r.id} onClick={() => handleSearchSelect(r)} className="flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-[#094771]">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: NODE_COLORS[nodeKindToGroup(r.kind)] }} />
                <span className="text-gray-200 truncate">{r.kind === "file" ? "" : r.name}</span>
                <span className="text-gray-500 shrink-0">{r.kind}</span>
                <span className="text-gray-600 ml-auto shrink-0 truncate">{r.file_path}:{r.start_line}</span>
              </div>
            ))}
          </div>
        )}

        {/* Text search results */}
        {searchTextResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-[#333] border border-gray-700 rounded text-xs">
            {searchTextResults.slice(0, 20).map((r, i) => (
              <div key={i} onClick={() => handleSearchTextClick(r)} className="flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-[#094771]">
                <span className="text-gray-300 shrink-0 w-16 truncate">{r.file_path.split("/").pop()}</span>
                <span className="text-yellow-400 shrink-0">{r.line_number}</span>
                <span className="text-gray-400 truncate">{r.line_content}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative">
        {loading && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">Loading graph…</div>}
        {error && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm px-4 text-center"><p className="text-yellow-400 mb-1">⚠ No graph data</p><p className="text-xs">{error}</p></div>}
        {!loading && !error && !hasWorker && filteredData && filteredData.nodes.length > 0 && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">Layout… ({filteredData.nodes.length} nodes)</div>}
        {!loading && !error && !hasWorker && filteredData && filteredData.nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">No nodes to display</div>}
        {hasWorker && (
          <CanvasGraph simNodes={simNodes} simEdges={simEdges}
            selectedNodeId={selectedNodeId} hoveredNodeId={hoveredNodeId}
            highlightedNodeIds={highlightedNodeIds}
            onNodeClick={handleNodeClick} onNodeHover={setHoveredNode}
            onNodeContextMenu={handleNodeContextMenu} />
        )}

        {contextMenu && (
          <>
            <div className="absolute inset-0 z-10" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
            <div className="absolute z-20 bg-[#2d2d2d] border border-gray-600 rounded shadow-xl py-1 text-xs min-w-[140px]" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <div className="px-3 py-1 text-gray-500 border-b border-gray-700 truncate max-w-[200px]">{filteredData?.nodes.find((x) => x.id === contextMenu.nodeId)?.name ?? contextMenu.nodeId}</div>
              <button onClick={handleContextJumpToCode} className="w-full text-left px-3 py-1.5 text-gray-200 hover:bg-[#094771] flex items-center gap-2 cursor-pointer"><span>📄</span><span>Jump to Code</span></button>
              <button onClick={handleContextExpand} className="w-full text-left px-3 py-1.5 text-gray-200 hover:bg-[#094771] flex items-center gap-2 cursor-pointer"><span>🔍</span><span>Expand as Center</span></button>
              <button onClick={handleContextCopyName} className="w-full text-left px-3 py-1.5 text-gray-200 hover:bg-[#094771] flex items-center gap-2 cursor-pointer"><span>📋</span><span>Copy Name</span></button>
            </div>
          </>
        )}
      </div>

      {/* Bottom bar */}
      <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-700 bg-[#252526] flex flex-wrap gap-3 items-center">
        {displayMode === "full" && <><span><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#cc7832" }} /> File</span><span style={{ background: "#6a8759" }}> Function</span><span style={{ background: "#6897bb" }}> Class/Struct</span><span style={{ background: "#c586c0" }}> Import</span></>}
        {displayMode === "main" && <span className="text-gray-400">{totalStats.communities > 1 ? `${totalStats.communities} communities · ${displayLabel}` : displayLabel}</span>}
        {displayMode === "focus" && focusMeta && <span className="text-gray-400">{focusMeta.callers} callers · {focusMeta.callees} callees{focusMeta.truncated && <span className="text-yellow-500 ml-1">(truncated from {focusMeta.total})</span>}</span>}
        <span className="text-gray-600 ml-auto">{nodeCount}n / {edgeCount}e</span>
      </div>
    </div>
  );
}
