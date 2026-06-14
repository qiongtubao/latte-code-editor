import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useGraphStore } from "../hooks/useGraphStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { useSettingsStore } from "../hooks/useSettingsStore";
import { CanvasGraph } from "./CanvasGraph";
import type { SimRenderNode } from "./graphRenderer";
import { invoke } from "@tauri-apps/api/core";
import { graphGetData, graphSearch } from "../api/graphCommands";
import { openFile, listDirectory, buildCodeGraph, searchInFiles, type SearchMatch } from "../api/commands";
import {
  getDefaultSubgraph, detectCommunities, extractFocusSubgraph,
  type RawNode, type RawEdge,
} from "../hooks/graphUtils";
import type { GraphNode, SimResult, GraphDisplayMode } from "../hooks/graphTypes";
import { nodeKindToGroup } from "../hooks/graphTypes";
import { NODE_COLORS } from "./graphRenderer";

export function GraphPanel({ folderRoot = null }: { folderRoot?: string | null }) {
  const {
    graphData, loading, error, simNodes, simEdges,
    selectedNodeId, hoveredNodeId, highlightedNodeIds, loadVersion,
    setGraphData, setLoading, setError, setSimResult,
    setSelectedNode, setHoveredNode, setHighlightedNodes, requestReload,
  } = useGraphStore();
  const { openFileOrSwitch } = useEditorStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  // 递增锁：每次 layout effect 跑都 ++，旧 worker 来的 tick 比对版本号后丢弃，
  // 避免 communityMap 抖动时被前一个 worker 的过期 setSimResult 覆盖。
  const layoutVersionRef = useRef(0);
  const [displayMode, setDisplayMode] = useState<GraphDisplayMode>("main");
  const [displayLabel, setDisplayLabel] = useState("");
  const [graphMode, setGraphMode] = useState<"code" | "docs">("code");
  const [rebuilding, setRebuilding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTextResults, setSearchTextResults] = useState<SearchMatch[]>([]);
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
  const [searchTab, setSearchTab] = useState<"symbols" | "files" | "text">("symbols");
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [focusMeta, setFocusMeta] = useState<{ total: number; callers: number; callees: number; truncated: boolean } | null>(null);
  const [docSimRender, setDocSimRender] = useState<{ nodes: SimRenderNode[]; edges: { source: string; target: string; kind: string; weight: number }[] } | null>(null);
  const [docRefreshKey, setDocRefreshKey] = useState(0);

  // Reset doc sim when switching to docs mode
  useEffect(() => {
    if (graphMode === "docs") {
      setDocSimRender(null);
      setDocRefreshKey((k) => k + 1);
    }
  }, [graphMode]);

  // Load graph data
  // 载入当前 active workspace 的图谱数据。loadVersion 变化时（包括切 workspace、显式 reload）重跑。
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await graphGetData();
        if (cancelled) return;
        setGraphData(response.data);
      } catch (e) {
        console.error("[GP] graphGetData FAILED:", e);
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

  // 布局 effect。
  //
  // 之前两个坑：
  // 1. `simStarted.current` 从来没被置为 true，是死代码——导致 cleanup 重置后下一次仍然照跑。
  // 2. `communityMap` 是新 useMemo 出来的 Map 引用，每次 graphData 变更都不同对象，触发了
  //    layout effect 在 worker 还没收敛时就 terminate 掉重建，graph 永远画不出来。
  //
  // 修法：用一个递增的 layoutVersion 锁住当前这一轮 worker，旧 worker 来的 tick 直接丢弃。
  // communityMap 仍然进 deps，但仅在 user 切换 displayMode / focusedNodeId / graphData
  // 这些"真正要重算"的情况下重启 worker。
  useEffect(() => {
    if (!filteredData) return;
    const myVersion = ++layoutVersionRef.current;
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

    const makeCircle = (): SimResult => {
      const cx = (containerRef.current?.clientWidth ?? 800) / 2;
      const cy = (containerRef.current?.clientHeight ?? 600) / 2;
      const r = Math.min(cx, cy) * 0.3;
      return { nodes: sNodes.map((n, i) => ({ id: n.id, x: cx + Math.cos((i / sNodes.length) * Math.PI * 2) * r, y: cy + Math.sin((i / sNodes.length) * Math.PI * 2) * r, vx: 0, vy: 0, group: n.group })), edges: sEdges };
    };
    if (sNodes.length <= 3) { setSimResult(makeCircle()); return; }

    const w = new Worker(new URL("./forceLayout.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    const t = setTimeout(() => {
      // 3s 还没收到任何 tick：worker 卡住了，直接用圆形兜底
      if (layoutVersionRef.current === myVersion && workerRef.current === w) {
        setSimResult(makeCircle());
      }
    }, 3000);
    w.onmessage = (e: MessageEvent<SimResult & { type?: string }>) => {
      if (e.data?.type === "ready") return;
      // 旧 worker 迟到的 tick：忽略，避免把已经重置的 sim 写回去
      if (layoutVersionRef.current !== myVersion) return;
      clearTimeout(t);
      setSimResult(e.data);
    };
    w.postMessage({ nodes: sNodes, edges: sEdges, width: containerRef.current?.clientWidth || 800, height: containerRef.current?.clientHeight || 600 });
    return () => {
      clearTimeout(t);
      w.terminate();
      if (workerRef.current === w) workerRef.current = null;
    };
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
    try { const r = await openFile(node.file_path); openFileOrSwitch(r, node.start_line ?? null); } catch (e) { console.error("[GP] openFile failed:", e, "node.path:", node.file_path); }
  }, [filteredData, setSelectedNode, openFileOrSwitch]);
  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    try { await buildCodeGraph(); requestReload(); } catch (e) { console.error("Rebuild:", e); } finally { setRebuilding(false); }
  }, [requestReload]);

  // 切换 Main/Full：杀掉当前 worker、清 sim，让 layout effect 用新 displayMode 重建。
  // 递增 layoutVersion 让旧 worker 的迟到的 tick 全部失效。
  const switchMode = useCallback((m: GraphDisplayMode) => {
    layoutVersionRef.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    setSimResult({ nodes: [], edges: [] });
    setDisplayMode(m);
    setFocusedNodeId(null);
    setFocusMeta(null);
    setDisplayLabel("");
  }, [setSimResult]);

  // 重新跑布局：清 sim + 自增版本号，让 layout effect 重启 worker。
  const handleZoomFit = useCallback(() => {
    layoutVersionRef.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    setSimResult({ nodes: [], edges: [] });
    setDisplayLabel("");
  }, [setSimResult]);

  const handleNodeContextMenu = useCallback((nodeId: string, x: number, y: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    setContextMenu({ x: x - (rect?.left ?? 0), y: y - (rect?.top ?? 0), nodeId });
    setSelectedNode(nodeId);
  }, [setSelectedNode]);

  // 搜索结果点击：统一打开文件 + 跳到节点行 + 切到 focus 模式把该节点的关联图画出来。
  //
  // 之前两个坑：
  // - 只对 kind==="file" 调 openFile，symbol 不打开（已修）
  // - 清掉 simResult 但 layout effect 不重启，画布变白（已修）
  //
  // 现在要解决的：点完搜索结果后图谱必须切到该节点的关联视图（callers / callees），
  // 不是停在主视图。filteredData 在 displayMode==="focus" + focusedNodeId 时
  // 走 extractFocusSubgraph 把 [callers, center, callees] 排好，layout effect 的
  // focus 分支再画图。
  const handleSearchSelect = useCallback(async (node: GraphNode) => {
    setSearchResults([]);
    setSearchQuery(node.name);
    // 先切 focus：filteredData 会立即重算成 center + direct callers + direct callees
    setDisplayMode("focus");
    setFocusedNodeId(node.id);
    setSelectedNode(node.id);
    // 再打开文件（异步，不阻塞图谱切换）
    try {
      const r = await openFile(node.file_path);
      openFileOrSwitch(r, node.start_line ?? null);
    } catch (e) {
      console.error("[GP] searchSelect openFile failed:", e, "path:", node.file_path);
    }
  }, [setDisplayMode, setFocusedNodeId, setSelectedNode, openFileOrSwitch]);
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
        openFileOrSwitch(r, m.line_number);
      }
    } catch (e) { console.error("[GP] searchTextClick failed:", e, "path:", m.file_path); }
  }, [openFileOrSwitch]);
  const handleContextJumpToCode = useCallback(async () => {
    if (!contextMenu) return;
    const { nodeId } = contextMenu; setContextMenu(null);
    const node = filteredData?.nodes.find((n) => n.id === nodeId); if (!node) return;
    try { const r = await openFile(node.file_path); openFileOrSwitch(r, node.start_line ?? null); } catch (e) { console.error("[GP] contextJump openFile failed:", e, "path:", node.file_path); }
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
      <div className="text-xs text-gray-400 border-b border-gray-700 bg-[#252526]">
        {/* Major view selector: Code Graph | Doc Graph */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider">View</span>
            <div className="flex bg-[#1e1e1e] rounded p-0.5">
              <button
                onClick={() => setGraphMode("code")}
                className={`px-3 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${graphMode === "code" ? "bg-[#007acc] text-white shadow" : "text-gray-400 hover:text-gray-200"}`}
              >{'\u{1F4BB}'} Code Graph</button>
              <button
                onClick={() => setGraphMode("docs")}
                className={`px-3 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${graphMode === "docs" ? "bg-[#007acc] text-white shadow" : "text-gray-400 hover:text-gray-200"}`}
              >{'\u{1F4C4}'} Doc Graph</button>
            </div>
          </div>
          {graphMode === "code" && (
            <div className="flex items-center gap-1">
              {(["main", "full"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`px-2 py-0.5 rounded cursor-pointer transition-colors text-[10px] ${displayMode === m ? "bg-[#3a3a3a] text-gray-200" : "text-gray-500 hover:text-gray-300"}`}
                >{m === "main" ? "Main" : "Full"}</button>
              ))}
              {displayMode === "focus" && (
                <span className="flex items-center gap-1 ml-1">
                  <span className="px-1.5 py-0.5 bg-[#094771] text-blue-200 rounded text-[10px]">Focus</span>
                  <button onClick={() => switchMode("main")} className="px-1 py-0.5 bg-[#3a3a3a] text-gray-300 rounded cursor-pointer text-[10px] hover:bg-[#4a4a4a]">×</button>
                </span>
              )}
              <span className="text-gray-500 text-[10px] ml-1">{displayLabel || `${nodeCount}n`}</span>
              <button onClick={handleZoomFit} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer text-xs">⊞</button>
              <button onClick={handleRebuild} disabled={rebuilding} className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer disabled:opacity-50 text-xs">{rebuilding ? "⟳" : "↻"}</button>
            </div>
          )}
          {graphMode === "docs" && (
            <button className="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-0.5" disabled>↻ refresh docs</button>
          )}
        </div>
        {/* Search (code mode only) */}
        {graphMode === "code" && (
          <div className="flex items-center gap-1 px-3 py-1.5">
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
        )}

        {/* Search results */}
        {searchResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-[#333] border border-gray-700 rounded text-xs">
            {searchResults.slice(0, 20).map((r) => (
              <div key={r.id} onClick={() => handleSearchSelect(r)} className="flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-[#094771]">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: NODE_COLORS[nodeKindToGroup(r.kind)] }} />
                <span style={{ color: "#86efac" }} className="truncate">{r.kind === "file" ? "" : r.name}</span>
                <span className="text-purple-300 shrink-0">{r.kind}</span>
                <span style={{ color: "#86efac" }} className="ml-auto shrink-0 truncate">{r.file_path}</span>
                <span style={{ color: "#93c5fd" }} className="shrink-0 font-medium">{r.start_line}</span>
              </div>
            ))}
          </div>
        )}

        {/* Text search results */}
        {searchTextResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-[#333] border border-gray-700 rounded text-xs">
            {searchTextResults.slice(0, 20).map((r, i) => (
              <div key={i} onClick={() => handleSearchTextClick(r)} className="flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-[#094771]">
                <span style={{ color: "#86efac" }} className="shrink-0 w-16 truncate">{r.file_path.split("/").pop()}</span>
                <span style={{ color: "#93c5fd" }} className="shrink-0 font-medium w-10 text-right">{r.line_number}</span>
                <span className="text-gray-300 truncate">{r.line_content}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative">
        {graphMode === "code" && (<>
        {loading && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">Loading graph…</div>}
        {error && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm px-4 text-center"><p className="text-yellow-400 mb-1">No graph data</p><p className="text-xs">{error}</p></div>}
        {!loading && !error && !hasWorker && filteredData && filteredData.nodes.length > 0 && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">Layout… ({filteredData.nodes.length} nodes)</div>}
        {!loading && !error && !hasWorker && filteredData && filteredData.nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">No nodes to display</div>}
        {hasWorker && (
          <CanvasGraph simNodes={simNodes} simEdges={simEdges}
            selectedNodeId={selectedNodeId} hoveredNodeId={hoveredNodeId}
            highlightedNodeIds={highlightedNodeIds}
            onNodeClick={handleNodeClick} onNodeHover={setHoveredNode}
            onNodeContextMenu={handleNodeContextMenu} />
        )}
        </>)}
        {graphMode === "docs" && docSimRender && (
          <CanvasGraph
            simNodes={docSimRender.nodes}
            simEdges={docSimRender.edges}
            selectedNodeId={null}
            hoveredNodeId={null}
            highlightedNodeIds={new Set()}
            onNodeClick={(id) => {
              const node = docSimRender.nodes.find((n) => n.id === id);
              if (node && (node as unknown as { path?: string }).path) {
                openFile((node as unknown as { path: string }).path).then((f) => useEditorStore.getState().openFileOrSwitch(f));
              }
            }}
            onNodeHover={() => {}}
          />
        )}
        {graphMode === "docs" && !docSimRender && (
          <DocGraphView
            folderRoot={folderRoot}
            onOpen={(path) => openFile(path).then((f) => useEditorStore.getState().openFileOrSwitch(f))}
            onDocSim={(nodes, edges) => setDocSimRender(nodes.length > 0 ? { nodes, edges } : null)}
          />
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

function DocGraphView({
  folderRoot,
  onOpen,
  onDocSim,
}: {
  folderRoot: string | null;
  onOpen: (path: string) => void;
  onDocSim: (nodes: SimRenderNode[], edges: { source: string; target: string; kind: string; weight: number }[]) => void;
}) {
  const docsInputDir = useSettingsStore((s) => s.docsInputDir);
  const [groups, setGroups] = useState<{ type: string; entries: { name: string; path: string; is_dir: boolean }[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!folderRoot) { setGroups([]); onDocSim([], []); return; }
    try {
      const abs = folderRoot.endsWith("/") ? folderRoot + docsInputDir : `${folderRoot}/${docsInputDir}`;

      // Recursively list all .md files in the docs directory
      const allFiles: { name: string; path: string; is_dir: boolean }[] = [];
      const queue = [abs];
      while (queue.length > 0) {
        const dir = queue.pop()!;
        const entries = await listDirectory(dir).catch(() => []);
        for (const e of entries as { name: string; path: string; is_dir: boolean }[]) {
          if (e.name.startsWith(".")) continue;
          if (e.is_dir) { queue.push(e.path); }
          else if (e.name.endsWith(".md")) { allFiles.push(e); }
        }
      }

      const map: Record<string, { name: string; path: string; is_dir: boolean }[]> = {};
      for (const e of allFiles) {
        const rel = e.path.replace(abs + "/", "").split("/");
        const dirName = rel.length > 1 ? rel[0] : "(root)";
        (map[dirName] ??= []).push(e);
      }
      const sorted = Object.entries(map)
        .filter(([, v]) => v.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, entries]) => ({
          type,
          entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
        }));
      setGroups(sorted);

      // Build doc sim for the graph canvas
      await import("../utils/docGraph").then(async ({ buildDocSim }) => {
        const sim = await buildDocSim(allFiles, async (p) => {
          try { return await invoke<string>("get_file_content", { path: p }); }
          catch { return ""; }
        });
        onDocSim(sim.nodes, sim.edges);
      });
    } finally {
      setLoading(false);
    }
  }, [folderRoot, docsInputDir, onDocSim]);


  useEffect(() => { refresh(); }, [refresh]);

  if (!folderRoot) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Open a workspace first to see docs.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-gray-300 font-medium">Document Graph</div>
          <div className="text-gray-500 text-[10px]">From {docsInputDir} · {groups.reduce((s, g) => s + g.entries.length, 0)} files</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              if (!folderRoot) return;
              import("../api/docGen").then(({ scanProjectForDocs, writeDocStub }) => {
                scanProjectForDocs(folderRoot).then((result) => {
                  const names = result.suggested_docs.slice(0, 40).map(d => d.title).join(", ");
                  const ok = window.confirm(
                    `Found ${result.suggested_docs.length} doc suggestions.\n\n` +
                    `Top: ${names}\n\n` +
                    `Generate all to ${docsInputDir}?`
                  );
                  if (ok) {
                    Promise.all(result.suggested_docs.map((s) =>
                      writeDocStub(`${folderRoot}/${docsInputDir}`, s, result.suggested_docs).catch(() => "")
                    )).then(() => refresh());
                  }
                }).catch((e) => setError(String(e)));
              });
            }}
            className="px-2 py-0.5 bg-[#007acc] hover:bg-[#005a9e] text-white rounded text-[10px]"
          >🔍 Scan</button>
          <button onClick={refresh} className="px-2 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded text-[10px]">↻</button>
        </div>
      </div>
      {loading && <div className="text-gray-500 text-center py-4">Loading…</div>}
      {error && <div className="text-yellow-400 text-center py-4">⚠ {error}</div>}
      {!loading && !error && groups.length === 0 && (
        <div className="text-gray-500 text-center py-8">No docs found in {docsInputDir}</div>
      )}
      {groups.map((g) => (
        <div key={g.type} className="mb-3">
          <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider mb-1 sticky top-0 bg-[#1e1e1e] py-1">{g.type}</div>
          <div className="grid grid-cols-2 gap-1">
            {g.entries.map((e) => (
              <div
                key={e.path}
                onClick={() => !e.is_dir && onOpen(e.path)}
                className={`p-2 bg-[#2a2a2a] hover:bg-[#333] rounded border border-gray-700 ${e.is_dir ? "opacity-50 cursor-default" : "cursor-pointer"}`}
              >
                <div className="text-gray-300 truncate">{e.is_dir ? "📁" : "📄"} {e.name}</div>
                <div className="text-[10px] text-gray-500 truncate">{e.path.split("/").slice(-2).join("/")}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
