// 图谱 store：按 workspace 隔离的 graphData / sim / selection 状态
//
// 设计同 useEditorStore：
// - byWorkspace: Record<workspaceId, WorkspaceGraph>
// - 对外暴露字段（graphData/simNodes/...）通过 project() 从 activeWorkspaceId 派生
// - 切换 workspace 不丢数据
import { create } from "zustand";
import type { GraphData, SimResult, SimNode } from "./graphTypes";
import { useWorkspaceStore } from "./useWorkspaceStore";

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

export const useGraphStore = create<GraphStore>((set, get) => {
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

    setGraphData: (data) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, graphData: data, error: null };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    setLoading: (loading) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, loading };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    setError: (error) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, error };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    setSimResult: (result) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = {
          ...ws,
          simNodes: result.nodes,
          simEdges: result.edges,
        };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    setSelectedNode: (id) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, selectedNodeId: id };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    setHoveredNode: (id) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, hoveredNodeId: id };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    setHighlightedNodes: (ids) => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = { ...ws, highlightedNodeIds: ids };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    requestReload: () => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!wsId) return;
      set((s) => {
        const ws = s.byWorkspace[wsId] ?? emptyGraph();
        const newWs: WorkspaceGraph = {
          ...ws,
          loadVersion: ws.loadVersion + 1,
          graphData: null,
          simNodes: [],
          simEdges: [],
          error: null,
        };
        return { ...project({ ...s, byWorkspace: { ...s.byWorkspace, [wsId]: newWs } }) };
      });
    },

    evictWorkspace: (workspaceId) => {
      set((s) => {
        const { [workspaceId]: _drop, ...rest } = s.byWorkspace;
        return { ...project({ ...s, byWorkspace: rest }) };
      });
    },

    reset: () => set({ byWorkspace: {} }),
  };
});
