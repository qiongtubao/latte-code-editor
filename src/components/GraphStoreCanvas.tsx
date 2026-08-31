import { memo, useCallback, useRef } from "react";
import { useGraphStore } from "../hooks/useGraphStore";
import { CanvasGraph } from "./CanvasGraph";
import type { SimRenderNode } from "./graphRenderer";

interface GraphStoreCanvasProps {
  onNodeClick: (nodeId: string) => void;
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
}

const handleNodeHover = (nodeId: string | null) => {
  useGraphStore.getState().setHoveredNode(nodeId);
};

/**
 * CanvasGraph owns a coalesced dirty-frame scheduler, so simulation ticks do not
 * need a React commit or a permanent RAF loop. This boundary pulls the latest
 * Zustand snapshot at draw time and lazily rebuilds hit-test maps.
 */
function GraphStoreCanvasComponent({
  onNodeClick,
  onNodeContextMenu,
}: GraphStoreCanvasProps) {
  const nodeMapCache = useRef<{
    nodes: SimRenderNode[] | null;
    map: Map<string, SimRenderNode>;
  }>({ nodes: null, map: new Map() });

  const getRenderState = useCallback(() => {
    const state = useGraphStore.getState();
    return {
      simNodes: state.simNodes,
      simEdges: state.simEdges,
      selectedNodeId: state.selectedNodeId,
      hoveredNodeId: state.hoveredNodeId,
      highlightedNodeIds: state.highlightedNodeIds,
    };
  }, []);

  const getNodeMap = useCallback(() => {
    const nodes = useGraphStore.getState().simNodes;
    if (nodeMapCache.current.nodes !== nodes) {
      nodeMapCache.current = {
        nodes,
        map: new Map(nodes.map((node) => [node.id, node])),
      };
    }
    return nodeMapCache.current.map;
  }, []);

  const getHoveredNodeId = useCallback(
    () => useGraphStore.getState().hoveredNodeId,
    [],
  );

  const subscribeRenderState = useCallback((invalidate: () => void) =>
    useGraphStore.subscribe((state, previousState) => {
      if (
        state.simNodes !== previousState.simNodes ||
        state.simEdges !== previousState.simEdges ||
        state.selectedNodeId !== previousState.selectedNodeId ||
        state.hoveredNodeId !== previousState.hoveredNodeId ||
        state.highlightedNodeIds !== previousState.highlightedNodeIds
      ) {
        invalidate();
      }
    }), []);

  const initialState = useGraphStore.getState();
  return (
    <CanvasGraph
      simNodes={initialState.simNodes}
      simEdges={initialState.simEdges}
      selectedNodeId={initialState.selectedNodeId}
      hoveredNodeId={initialState.hoveredNodeId}
      highlightedNodeIds={initialState.highlightedNodeIds}
      getRenderState={getRenderState}
      getNodeMap={getNodeMap}
      getHoveredNodeId={getHoveredNodeId}
      subscribeRenderState={subscribeRenderState}
      onNodeClick={onNodeClick}
      onNodeHover={handleNodeHover}
      onNodeContextMenu={onNodeContextMenu}
    />
  );
}

export const GraphStoreCanvas = memo(GraphStoreCanvasComponent);
