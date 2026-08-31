import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useGraphStore } from "../hooks/useGraphStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { useSettingsStore } from "../hooks/useSettingsStore";
import { CanvasGraph } from "./CanvasGraph";
import { GraphStoreCanvas } from "./GraphStoreCanvas";
import type { SimRenderNode } from "./graphRenderer";
import { invoke } from "@tauri-apps/api/core";
import { graphGetData, graphSearch } from "../api/graphCommands";
import { openFile, listDirectory, buildCodeGraph, searchInFiles, type SearchMatch } from "../api/commands";
import {
  getDefaultSubgraph, detectCommunities, extractFocusSubgraph,
  type RawNode, type RawEdge,
} from "../hooks/graphUtils";
import type {
  GraphNode,
  SimResult,
  GraphDisplayMode,
  GraphRevealRequest,
} from "../hooks/graphTypes";
import { nodeKindToGroup } from "../hooks/graphTypes";
import { NODE_COLORS } from "./graphRenderer";
import { toWorkspaceRel } from "../chatBridge";
import { createAnimationFrameCoalescer } from "../utils/animationFrameCoalescer";
import {
  FORCE_POSITION_STRIDE,
  type ForceLayoutOutputMessage,
} from "./forceLayoutProtocol";

const EMPTY_HIGHLIGHTED_NODE_IDS = new Set<string>();

export function GraphPanel({
  folderRoot = null,
  revealRequest = null,
  onRevealHandled,
}: {
  folderRoot?: string | null;
  revealRequest?: GraphRevealRequest | null;
  onRevealHandled?: (requestId: number) => void;
}) {
  const graphData = useGraphStore((state) => state.graphData);
  const loading = useGraphStore((state) => state.loading);
  const error = useGraphStore((state) => state.error);
  const loadVersion = useGraphStore((state) => state.loadVersion);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const hasWorker = useGraphStore((state) => state.simNodes.length > 0);
  const setGraphData = useGraphStore((state) => state.setGraphData);
  const setLoading = useGraphStore((state) => state.setLoading);
  const setError = useGraphStore((state) => state.setError);
  const setSimResult = useGraphStore((state) => state.setSimResult);
  const setSelectedNode = useGraphStore((state) => state.setSelectedNode);
  const setHighlightedNodes = useGraphStore((state) => state.setHighlightedNodes);
  const requestReload = useGraphStore((state) => state.requestReload);
  const openFileOrSwitch = useEditorStore((state) => state.openFileOrSwitch);
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
  const [docSearchQuery, setDocSearchQuery] = useState("");


  // Reset doc sim when switching to docs mode
  useEffect(() => {
    if (graphMode === "docs") {
      setDocSimRender(null);
    }
  }, [graphMode]);

  // Filtered doc sim: when docSearchQuery is non-empty, restrict the canvas
  // to nodes whose label/id/path matches + their 1-hop neighbours. Edges
  // are kept only between surviving nodes.
  const filteredDocSim = useMemo(() => {
    if (!docSimRender) return null;
    const q = docSearchQuery.trim().toLowerCase();
    if (q.length === 0) return docSimRender;
    const matched = new Set<string>();
    for (const n of docSimRender.nodes) {
      if (n.id.toLowerCase().includes(q) || (n.label ?? "").toLowerCase().includes(q)) {
        matched.add(n.id);
      }
    }
    if (matched.size === 0) return { nodes: [], edges: [] };
    // 1-hop expansion
    const expanded = new Set(matched);
    for (const e of docSimRender.edges) {
      if (matched.has(e.source) || matched.has(e.target)) {
        expanded.add(e.source);
        expanded.add(e.target);
      }
    }
    return {
      nodes: docSimRender.nodes.filter((n) => expanded.has(n.id)),
      edges: docSimRender.edges.filter((e) => expanded.has(e.source) && expanded.has(e.target)),
    };
  }, [docSimRender, docSearchQuery]);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const requestedWorkspaceId = activeWorkspaceId;
    const requestedLoadVersion = loadVersion;
    let cancelled = false;

    const requestIsCurrent = () => {
      if (cancelled) return false;
      const workspace = useGraphStore.getState().byWorkspace[requestedWorkspaceId];
      return workspace?.loadVersion === requestedLoadVersion;
    };
    const clearRequestLoading = () => {
      const workspace = useGraphStore.getState().byWorkspace[requestedWorkspaceId];
      if (workspace?.loading && workspace.loadVersion === requestedLoadVersion) {
        setLoading(false, requestedWorkspaceId);
      }
    };

    async function load() {
      setLoading(true, requestedWorkspaceId);
      try {
        const response = await graphGetData();
        if (!requestIsCurrent()) return;
        setGraphData(response.data, requestedWorkspaceId);
      } catch (e) {
        if (!requestIsCurrent()) return;
        console.error("[GP] graphGetData FAILED:", e);
        setError(String(e), requestedWorkspaceId);
      } finally {
        if (requestIsCurrent()) clearRequestLoading();
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearRequestLoading();
    };
  }, [activeWorkspaceId, loadVersion, setGraphData, setLoading, setError]);
  // A prop rather than a window event: requests made while this module is still
  // downloading remain present and are applied immediately after mount.
  useEffect(() => {
    if (!revealRequest) return;
    setFocusedNodeId(revealRequest.nodeId);
    setSelectedNode(revealRequest.nodeId);
    setDisplayMode("focus");
    setSearchResults([]);
    useGraphStore.getState().setHighlightedNodes(new Set());
    setSearchQuery("");
    onRevealHandled?.(revealRequest.requestId);
  }, [onRevealHandled, revealRequest, setSelectedNode]);

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
      if (sub.nodes.length > 0) queueMicrotask(() => setDisplayLabel(sub.label));
      if (sub.centerId) queueMicrotask(() => setSelectedNode(sub.centerId!));
      return sub;
    }

    if (displayMode === "focus" && focusedNodeId) {
      const focus = extractFocusSubgraph(rawNodes, rawEdges, focusedNodeId, 30);
      if (focus) {
        // useMemo 是渲染阶段，这里直接 setState 会触发 React 的
        // "Cannot update a component while rendering" 并多跑一轮渲染。
        // 与上方 setSelectedNode 一致，用 queueMicrotask 推到渲染之后。
        const label = `focus: ${focus.center.name}`;
        const meta = { total: focus.totalCallers + focus.totalCallees, callers: focus.callers.length, callees: focus.callees.length, truncated: focus.truncated };
        queueMicrotask(() => {
          setDisplayLabel(label);
          setFocusMeta(meta);
        });
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
    const tickPublisher = createAnimationFrameCoalescer<Float32Array>((positions) => {
      // Recheck at flush time: the layout may have been replaced or unmounted
      // after this result was queued but before the animation frame ran.
      if (
        layoutVersionRef.current !== myVersion ||
        workerRef.current !== w ||
        positions.length !== sNodes.length * FORCE_POSITION_STRIDE
      ) return;

      setSimResult({
        nodes: sNodes.map((node, index) => {
          const offset = index * FORCE_POSITION_STRIDE;
          return {
            id: node.id,
            x: positions[offset],
            y: positions[offset + 1],
            // Renderers do not consume velocity; retain the public SimNode
            // contract without transferring two unused floats per node.
            vx: 0,
            vy: 0,
            group: node.group,
          };
        }),
        edges: sEdges,
      });
    });
    const t = setTimeout(() => {
      // 3s 还没收到任何 tick：worker 卡住了，直接用圆形兜底
      if (layoutVersionRef.current === myVersion && workerRef.current === w) {
        setSimResult(makeCircle());
      }
    }, 3000);
    w.onmessage = (e: MessageEvent<ForceLayoutOutputMessage>) => {
      if ("type" in e.data) return;
      // 旧 worker 迟到的 tick：忽略，避免把已经重置的 sim 写回去
      if (
        layoutVersionRef.current !== myVersion ||
        workerRef.current !== w
      ) return;
      clearTimeout(t);
      tickPublisher.schedule(e.data.positions);
    };
    w.postMessage({ nodes: sNodes, edges: sEdges, width: containerRef.current?.clientWidth || 800, height: containerRef.current?.clientHeight || 600 });
    return () => {
      clearTimeout(t);
      tickPublisher.cancel();
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
    setHighlightedNodes(new Set());
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
  }, [setDisplayMode, setFocusedNodeId, setSelectedNode, openFileOrSwitch, setHighlightedNodes]);
  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    try {
      if (searchTab === "text") {
        setSearchTextResults(await searchInFiles(q));
        setSearchResults([]);
        // 文本搜索命中的是文件行，不是图谱节点，清掉上一次的节点高亮
        setHighlightedNodes(new Set());
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
      if (results.length === 1) {
        // 单个结果直接跳过去，不需要在图上高亮一堆
        setHighlightedNodes(new Set());
        void handleSearchSelect(results[0]);
      } else {
        setSearchResults(results);
        // 把命中节点交给画布高亮。此前 setHighlightedNodes 从未被调用，
        // highlightedNodeIds 恒为空集，Canvas2DRenderer 里的 isHighlight
        // 分支永远走不到 —— 消费端一直是通的，缺的是触发端。
        setHighlightedNodes(new Set(results.map((n) => n.id)));
      }
    } catch {
      setSearchResults([]);
      setHighlightedNodes(new Set());
    }
  }, [searchQuery, searchTab, handleSearchSelect, setHighlightedNodes]);

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
    void handleSearchSelect({ id: contextMenu.nodeId, name: "", kind: "", file_path: "", start_line: 0, qualified_name: "", language: "", end_line: 0, signature: null } as GraphNode);
  }, [contextMenu, handleSearchSelect]);

  const handleContextCopyName = useCallback(() => {
    if (!contextMenu) return; setContextMenu(null);
    const node = filteredData?.nodes.find((n) => n.id === contextMenu.nodeId);
    if (node) navigator.clipboard.writeText(node.name).catch(() => {});
  }, [contextMenu, filteredData]);

  // 节点 → chat：引用打进 chat 输入框（App.tsx ask-agent → chatBridge）。
  // filteredData 的 RawNode 只有 start_line，endLine/qualified_name
  // 从 store 里的完整 GraphNode（同 id）补齐。
  const handleContextAskAgent = useCallback(() => {
    if (!contextMenu) return; setContextMenu(null);
    const raw = filteredData?.nodes.find((n) => n.id === contextMenu.nodeId);
    if (!raw) return;
    const full = graphData?.nodes.find((n) => n.id === raw.id);
    window.dispatchEvent(new CustomEvent("ask-agent", {
      detail: {
        path: toWorkspaceRel(raw.file_path, folderRoot),
        startLine: full?.start_line ?? raw.start_line,
        endLine: full?.end_line,
        symbol: full?.qualified_name ?? raw.name,
      },
    }));
  }, [contextMenu, filteredData, graphData, folderRoot]);

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--surface)" }}>
      <div className="text-xs text-fg-2 border-b border-edge bg-surface-2">
        {/* Major view selector: Code Graph | Doc Graph */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-edge">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase text-fg-3 font-semibold tracking-wider">View</span>
            <div className="flex bg-surface rounded p-0.5">
              <button
                onClick={() => setGraphMode("code")}
                className={`px-3 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${graphMode === "code" ? "bg-accent text-white shadow" : "text-fg-2 hover:text-fg"}`}
              >{'\u{1F4BB}'} Code Graph</button>
              <button
                onClick={() => setGraphMode("docs")}
                className={`px-3 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${graphMode === "docs" ? "bg-accent text-white shadow" : "text-fg-2 hover:text-fg"}`}
              >{'\u{1F4C4}'} Doc Graph</button>
            </div>
          </div>
          {graphMode === "code" && (
            <div className="flex items-center gap-1">
              {(["main", "full"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`px-2 py-0.5 rounded cursor-pointer transition-colors text-[10px] ${displayMode === m ? "bg-control text-fg" : "text-fg-3 hover:text-fg"}`}
                >{m === "main" ? "Main" : "Full"}</button>
              ))}
              {displayMode === "focus" && (
                <span className="flex items-center gap-1 ml-1">
                  <span className="px-1.5 py-0.5 bg-info text-accent-2 rounded text-[10px]">Focus</span>
                  <button onClick={() => switchMode("main")} className="px-1 py-0.5 bg-control text-fg rounded cursor-pointer text-[10px] hover:bg-control-hover">×</button>
                </span>
              )}
              <span className="text-fg-3 text-[10px] ml-1">{displayLabel || `${nodeCount}n`}</span>
              <button onClick={handleZoomFit} className="px-1.5 py-0.5 bg-control hover:bg-control-hover text-fg rounded cursor-pointer text-xs">⊞</button>
              <button onClick={handleRebuild} disabled={rebuilding} className="px-1.5 py-0.5 bg-control hover:bg-control-hover text-fg rounded cursor-pointer disabled:opacity-50 text-xs">{rebuilding ? "⟳" : "↻"}</button>
            </div>
          )}
          {graphMode === "docs" && (
            <button className="text-[10px] text-fg-3 hover:text-fg px-2 py-0.5" disabled>↻ refresh docs</button>
          )}
        </div>
        {/* Search (code mode only) */}
        {graphMode === "code" && (
          <div className="flex items-center gap-1 px-3 py-1.5">
            {(["symbols", "files", "text"] as const).map((tab) => (
              <button key={tab} onClick={() => { setSearchTab(tab); setSearchResults([]); setSearchTextResults([]); }} className={`px-2 py-0.5 rounded text-[10px] cursor-pointer ${searchTab === tab ? "bg-accent text-white" : "bg-control text-fg-2"}`}>{tab}</button>
            ))}
            <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
              placeholder={`Search ${searchTab}...`}
              className="flex-1 px-2 py-0.5 bg-control text-fg border border-edge rounded text-xs outline-none focus:border-accent" />
            {(searchResults.length > 0 || searchTextResults.length > 0) && (
              <button onClick={() => { setSearchResults([]); setSearchTextResults([]); setSearchQuery(""); }} className="px-1.5 py-0.5 bg-control hover:bg-control-hover text-fg rounded cursor-pointer text-xs">×</button>
            )}
          </div>
        )}

        {/* Search results */}
        {searchResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-surface-3 border border-edge rounded text-xs">
            {searchResults.slice(0, 20).map((r) => (
              <div key={r.id} onClick={() => handleSearchSelect(r)} className="flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-info">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: NODE_COLORS[nodeKindToGroup(r.kind)] }} />
                <span style={{ color: "var(--ok)" }} className="truncate">{r.kind === "file" ? "" : r.name}</span>
                <span className="text-accent-2 shrink-0">{r.kind}</span>
                <span style={{ color: "var(--ok)" }} className="ml-auto shrink-0 truncate">{r.file_path}</span>
                <span style={{ color: "var(--accent-2)" }} className="shrink-0 font-medium">{r.start_line}</span>
              </div>
            ))}
          </div>
        )}

        {/* Text search results */}
        {searchTextResults.length > 0 && (
          <div className="mt-1 max-h-24 overflow-y-auto bg-surface-3 border border-edge rounded text-xs">
            {searchTextResults.slice(0, 20).map((r, i) => (
              <div
                key={i}
                onClick={() => void handleSearchTextClick(r)}
                className="px-2 py-0.5 text-fg truncate cursor-pointer hover:bg-info"
              >{r.file_path}:{r.line_number} — {r.line_content}</div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas container */}
      <div ref={containerRef} className="flex-1 relative">
        {graphMode === "code" && (<>
        {loading && <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-sm">Loading graph…</div>}
        {error && <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-sm px-4 text-center"><p className="text-warn mb-1">No graph data</p><p className="text-xs">{error}</p></div>}
        {!loading && !error && !hasWorker && filteredData && filteredData.nodes.length > 0 && <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-sm">Layout… ({filteredData.nodes.length} nodes)</div>}
        {!loading && !error && !hasWorker && filteredData && filteredData.nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-sm">No nodes to display</div>}
        {hasWorker && (
          <GraphStoreCanvas
            onNodeClick={handleNodeClick}
            onNodeContextMenu={handleNodeContextMenu}
          />
        )}
        </>)}
        {graphMode === "docs" && docSimRender && filteredDocSim && (
          <>
            <div className="relative">
              <div className="px-3 py-1.5 text-xs border-b border-edge bg-surface-2 flex items-center gap-2">
                <input type="text" value={docSearchQuery} onChange={(e) => setDocSearchQuery(e.target.value)}
                  placeholder="Search docs by title..."
                  className="flex-1 px-2 py-0.5 bg-control text-fg border border-edge rounded text-xs outline-none focus:border-accent" />
                {docSearchQuery && <button onClick={() => setDocSearchQuery("")} className="px-1.5 py-0.5 bg-control hover:bg-control-hover text-fg rounded cursor-pointer text-xs">✕</button>}
                <span className="text-fg-3 text-[10px] shrink-0">{filteredDocSim.nodes.length}/{docSimRender.nodes.length}</span>
              </div>
              {/* Search dropdown: match titles */}
              {docSearchQuery.trim().length > 0 && docSimRender && (() => {
                const q = docSearchQuery.trim().toLowerCase();
                const matches = docSimRender.nodes.filter((n) =>
                  n.id.toLowerCase().includes(q) || (n as unknown as { label?: string }).label?.toLowerCase().includes(q)
                ).slice(0, 8);
                if (matches.length === 0) return null;
                return (
                  <div className="absolute left-3 right-3 top-full z-20 bg-surface-3 border border-edge rounded shadow-xl mt-0.5 max-h-48 overflow-y-auto">
                    {matches.map((n) => {
                      const node = n as unknown as { path?: string; label?: string };
                      return (
                        <div key={n.id}
                          onClick={() => {
                            setDocSearchQuery(n.id.split("/").pop() ?? n.id);
                            if (node.path) {
                              openFile(node.path).then((f) => useEditorStore.getState().openFileOrSwitch(f)).catch((e) => console.error("[GP] open doc node failed:", node.path, e));
                            }
                          }}
                          className="px-3 py-1.5 text-xs cursor-pointer hover:bg-info text-fg border-b border-edge last:border-0 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: NODE_COLORS[n.group] ?? "var(--fg-3)" }} />
                          <span className="truncate">{node.label ?? n.id}</span>
                          <span className="text-fg-3 text-[10px] shrink-0 ml-auto">{n.id}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
            <CanvasGraph simNodes={filteredDocSim.nodes} simEdges={filteredDocSim.edges}
              selectedNodeId={null} hoveredNodeId={null} highlightedNodeIds={EMPTY_HIGHLIGHTED_NODE_IDS}
              onNodeClick={(id) => {
                const node = docSimRender.nodes.find((n) => n.id === id);
                if (node && (node as unknown as { path?: string }).path) {
                  openFile((node as unknown as { path: string }).path).then((f) => useEditorStore.getState().openFileOrSwitch(f)).catch((e) => console.error("[GP] open doc node failed:", e));
                }
              }}
              onNodeHover={() => {}} />
          </>
        )}
        {graphMode === "docs" && !docSimRender && (
          <DocGraphView folderRoot={folderRoot}
            onOpen={(path) => openFile(path).then((f) => useEditorStore.getState().openFileOrSwitch(f))}
            onDocSim={(nodes, edges) => setDocSimRender(nodes.length > 0 ? { nodes, edges } : null)} />
        )}
      </div>

      {contextMenu && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
          <div className="absolute z-20 bg-surface-3 border border-edge rounded shadow-xl py-1 text-xs min-w-[140px]" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <div className="px-3 py-1 text-fg-3 border-b border-edge truncate max-w-[200px]">{filteredData?.nodes.find((x) => x.id === contextMenu.nodeId)?.name ?? contextMenu.nodeId}</div>
            <button onClick={handleContextJumpToCode} className="w-full text-left px-3 py-1.5 text-fg hover:bg-info flex items-center gap-2 cursor-pointer"><span>📄</span><span>Jump to Code</span></button>
            <button onClick={handleContextAskAgent} className="w-full text-left px-3 py-1.5 text-fg hover:bg-info flex items-center gap-2 cursor-pointer"><span>💬</span><span>在 chat 中询问</span></button>
            <button onClick={handleContextExpand} className="w-full text-left px-3 py-1.5 text-fg hover:bg-info flex items-center gap-2 cursor-pointer"><span>🔍</span><span>Expand as Center</span></button>
            <button onClick={handleContextCopyName} className="w-full text-left px-3 py-1.5 text-fg hover:bg-info flex items-center gap-2 cursor-pointer"><span>📋</span><span>Copy Name</span></button>
          </div>
        </>
      )}

      {/* Bottom bar */}
      <div className="px-3 py-1.5 text-xs text-fg-3 border-t border-edge bg-surface-2 flex flex-wrap gap-3 items-center">
        {displayMode === "full" && <><span><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#cc7832" }} /> File</span><span style={{ background: "#6a8759" }}> Function</span><span style={{ background: "#6897bb" }}> Class/Struct</span><span style={{ background: "#c586c0" }}> Import</span></>}
        {displayMode === "main" && <span className="text-fg-2">{totalStats.communities > 1 ? `${totalStats.communities} communities · ${displayLabel}` : displayLabel}</span>}
        {displayMode === "focus" && focusMeta && <span className="text-fg-2">{focusMeta.callers} callers · {focusMeta.callees} callees{focusMeta.truncated && <span className="text-warn ml-1">(truncated from {focusMeta.total})</span>}</span>}
        <span className="text-fg-3 ml-auto">{nodeCount}n / {edgeCount}e</span>
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
    setLoading(true);
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
      const { buildDocSim } = await import("../utils/docGraph");
      const sim = await buildDocSim(allFiles, async (p) => {
        try { return await invoke<string>("get_file_content", { path: p }); }
        catch { return ""; }
      });
      console.log("[DocGraphView] buildDocSim:", allFiles.length, "files ->", sim.nodes.length, "nodes,", sim.edges.length, "edges");
      onDocSim(sim.nodes, sim.edges);
    } finally {
      setLoading(false);
    }
  }, [folderRoot, docsInputDir, onDocSim]);


  useEffect(() => { void refresh(); }, [refresh]);

  if (!folderRoot) {
    return (
      <div className="flex items-center justify-center h-full text-fg-3 text-sm">
        Open a workspace first to see docs.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      {loading && <div className="mb-3 p-2 bg-info text-accent-2 rounded">Building doc graph...</div>}
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-fg font-medium">Document Graph</div>
          <div className="text-fg-3 text-[10px]">From {docsInputDir} · {groups.reduce((s, g) => s + g.entries.length, 0)} files</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              if (!folderRoot) return;
              try {
                const { scanProjectForDocs, writeDocStub } = await import("../api/docGen");
                const result = await scanProjectForDocs(folderRoot);
                const names = result.suggested_docs.slice(0, 40).map(d => d.title).join(", ");
                const ok = window.confirm(
                  `Found ${result.suggested_docs.length} doc suggestions.\n\n` +
                  `Top: ${names}\n\n` +
                  `Generate all to ${docsInputDir}?`
                );
                if (!ok) return;
                // 逐个写入并统计失败。此前是 .catch(() => "")，把写盘失败
                // 静默丢掉：用户点了「生成全部」，部分失败也毫无感知。
                const settled = await Promise.all(
                  result.suggested_docs.map((s) =>
                    writeDocStub(`${folderRoot}/${docsInputDir}`, s, result.suggested_docs)
                      .then(() => null)
                      .catch((e) => `${s.rel_path}: ${String(e)}`),
                  ),
                );
                const failures = settled.filter((f): f is string => f !== null);
                if (failures.length > 0) {
                  setError(
                    `${failures.length}/${result.suggested_docs.length} 个文档写入失败：` +
                    failures.slice(0, 5).join("；") +
                    (failures.length > 5 ? ` …另有 ${failures.length - 5} 个` : ""),
                  );
                }
                void refresh();
              } catch (e) {
                setError(String(e));
              }
            }}
            className="px-2 py-0.5 bg-accent hover:bg-accent text-white rounded text-[10px]"
          >🔍 Scan</button>
          <button onClick={refresh} className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg rounded text-[10px]">↻</button>
        </div>
      </div>
      {loading && <div className="text-fg-3 text-center py-4">Loading…</div>}
      {error && <div className="text-warn text-center py-4">⚠ {error}</div>}
      {!loading && !error && groups.length === 0 && (
        <div className="text-fg-3 text-center py-8">No docs found in {docsInputDir}</div>
      )}
      {groups.map((g) => (
        <div key={g.type} className="mb-3">
          <div className="text-[10px] uppercase text-fg-3 font-semibold tracking-wider mb-1 sticky top-0 bg-surface py-1">{g.type}</div>
          <div className="grid grid-cols-2 gap-1">
            {g.entries.map((e) => (
              <div
                key={e.path}
                onClick={() => !e.is_dir && onOpen(e.path)}
                className={`p-2 bg-surface-3 hover:bg-control rounded border border-edge ${e.is_dir ? "opacity-50 cursor-default" : "cursor-pointer"}`}
              >
                <div className="text-fg truncate">{e.is_dir ? "📁" : "📄"} {e.name}</div>
                <div className="text-[10px] text-fg-3 truncate">{e.path.split("/").slice(-2).join("/")}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
