// 图谱 store：按 workspace 隔离的 graphData / sim / selection 状态
//
// 设计同 useEditorStore：
// - byWorkspace: Record<workspaceId, WorkspaceGraph>
// - 对外暴露字段（graphData/simNodes/...）通过 project() 从 activeWorkspaceId 派生
// - 切换 workspace 不丢数据
import { create } from "zustand";
import type { GraphData, SimResult, SimNode } from "./graphTypes";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent } from "../utils/debug/inject";
import { useDebugStore } from "../utils/debug/store";

const log = createDebugLogger("graph");

interface WorkspaceGraph {
  graphData: GraphData | null;
  loading: boolean;
  error: string | null;
  simNodes: SimNode[];
  simEdges: SimResult["edges"];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  loadVersion: number;
}

function emptyGraph(): WorkspaceGraph {
  return {
    graphData: null,
    loading: false,
    error: null,
    simNodes: [],
    simEdges: [],
    selectedNodeId: null,
    hoveredNodeId: null,
    highlightedNodeIds: new Set(),
    loadVersion: 0,
  };
}

interface GraphStore {
  byWorkspace: Record<string, WorkspaceGraph>;

  // 派生字段
  graphData: GraphData | null;
  loading: boolean;
  error: string | null;
  simNodes: SimNode[];
  simEdges: SimResult["edges"];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  loadVersion: number;

  // actions（按当前 active workspace 写）
  setGraphData: (data: GraphData) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSimResult: (result: SimResult) => void;
  setSelectedNode: (id: string | null) => void;
  setHoveredNode: (id: string | null) => void;
  setHighlightedNodes: (ids: Set<string>) => void;
  /** 重新触发 graph reload（切到新 workspace 也会自动调用） */
  requestReload: () => void;
  /** 删除一个 workspace 的所有 graph 状态 */
  evictWorkspace: (workspaceId: string) => void;
  reset: () => void;
}

function project(state: GraphStore): Partial<GraphStore> {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!wsId) {
    return {
      graphData: null,
      loading: false,
      error: null,
      simNodes: [],
      simEdges: [],
      selectedNodeId: null,
      hoveredNodeId: null,
      highlightedNodeIds: new Set(),
      loadVersion: 0,
    };
  }
  const ws = state.byWorkspace[wsId] ?? emptyGraph();
  return { ...ws };
}

/** 把某个 workspace 的状态写回 store，同时重算派生字段。 */
function mutateByWs(
  state: GraphStore,
  wsId: string,
  newWs: WorkspaceGraph,
): Partial<GraphStore> {
  const byWorkspace = { ...state.byWorkspace, [wsId]: newWs };
  return { byWorkspace, ...project({ ...state, byWorkspace }) };
}

export const useGraphStore = create<GraphStore>((set) => {
  // 订阅 workspace 切换
  useWorkspaceStore.subscribe(() => {
    set((s) => project(s));
  });

  return {
    byWorkspace: {},
    graphData: null,
    loading: false,
    error: null,
    simNodes: [],
    simEdges: [],
    selectedNodeId: null,
    hoveredNodeId: null,
    highlightedNodeIds: new Set(),
    loadVersion: 0,
    // 所有 setter 都要把 byWorkspace 一并写回
    // project() 会读到旧的 byWorkspace，把 projected 字段全部清空（之前是个隐性 bug：
    // 只要 workspace 那边有一次重新 setState，graphData/simNodes 立刻被擦成默认值，
    // 图谱看上去就"消失了")。mutate() 复用 useEditorStore 的写法，写 byWorkspace + 派生字段。
    setGraphData: (data) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, graphData: data, error: null };
        return mutateByWs(s, wsId, newWs);
      });
    },
    setLoading: (loading) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, { ...ws, loading });
      });
    },

    setError: (error) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, { ...ws, error });
      });
    },

    setSimResult: (result) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, {
          ...ws,
          simNodes: result.nodes,
          simEdges: result.edges,
        });
      });
    },

    setSelectedNode: (id) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, { ...ws, selectedNodeId: id });
      });
    },

    setHoveredNode: (id) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, { ...ws, hoveredNodeId: id });
      });
    },

    setHighlightedNodes: (ids) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, { ...ws, highlightedNodeIds: ids });
      });
    },

    requestReload: () => {
      const lockKey = "graph:requestReload";
      if (!useDebugStore.getState().tryAcquireLock(lockKey)) {
        log.warn("graph.requestReload.skipped", "locked", {});
        return;
      }
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) {
        useDebugStore.getState().releaseLock(lockKey);
        return;
      }
      log.info("graph.requestReload", "reload requested", { workspaceId: wsId });
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        return mutateByWs(s, wsId, {
          ...ws,
          loadVersion: ws.loadVersion + 1,
          graphData: null,
          simNodes: [],
          simEdges: [],
          error: null,
        });
      });
      useDebugStore.getState().releaseLock(lockKey);
    },

    evictWorkspace: (workspaceId) => {
      set((s) => {
        const { [workspaceId]: _drop, ...rest } = s.byWorkspace;
        return { byWorkspace: rest, ...project({ ...s, byWorkspace: rest }) };
      });
    },

    reset: () => set({ byWorkspace: {} }),
  };
});

// Register graph events for debug injection.
registerDebugEvent("graph.requestReload", async () => {
  useGraphStore.getState().requestReload();
});
registerDebugEvent("graph.rebuild", async () => {
  // A rebuild is a destructive op: clear cached graph data and request reload.
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!wsId) return;
  useGraphStore.getState().evictWorkspace(wsId);
  useGraphStore.getState().requestReload();
}, { dangerous: true });
