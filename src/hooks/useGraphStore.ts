import { create } from "zustand";
import type { GraphData, SimResult, SimNode } from "./graphTypes";

interface GraphStore {
  // Raw data
  graphData: GraphData | null;
  loading: boolean;
  error: string | null;

  // Simulation results (from Worker)
  simNodes: SimNode[];
  simEdges: SimResult["edges"];

  // Interaction state
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;

  // Version counter: increment to force graph reload (e.g., after folder open)
  loadVersion: number;

  // Actions
  setGraphData: (data: GraphData) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSimResult: (result: SimResult) => void;
  setSelectedNode: (id: string | null) => void;
  setHoveredNode: (id: string | null) => void;
  setHighlightedNodes: (ids: Set<string>) => void;
  /** Call after opening a folder to trigger graph reload */
  requestReload: () => void;
  reset: () => void;
}

export const useGraphStore = create<GraphStore>((set) => ({
  graphData: null,
  loading: false,
  error: null,
  simNodes: [],
  simEdges: [],
  selectedNodeId: null,
  hoveredNodeId: null,
  highlightedNodeIds: new Set(),
  loadVersion: 0,

  setGraphData: (data) =>
    set({ graphData: data, error: null }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  setSimResult: (result) =>
    set({ simNodes: result.nodes, simEdges: result.edges }),

  setSelectedNode: (id) =>
    set({ selectedNodeId: id }),

  setHoveredNode: (id) =>
    set({ hoveredNodeId: id }),

  setHighlightedNodes: (ids) =>
    set({ highlightedNodeIds: ids }),

  requestReload: () =>
    set((state) => ({
      loadVersion: state.loadVersion + 1,
      graphData: null,
      simNodes: [],
      simEdges: [],
      error: null,
    })),

  reset: () =>
    set({
      graphData: null,
      simNodes: [],
      simEdges: [],
      selectedNodeId: null,
      hoveredNodeId: null,
      highlightedNodeIds: new Set(),
      loadVersion: 0,
    }),
}));
