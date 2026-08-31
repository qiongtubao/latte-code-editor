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
 * CanvasGraph already owns a continuous render loop, so simulation ticks do not
 * need a React commit. This boundary pulls the latest Zustand snapshot at frame
 * time and lazily rebuilds the hit-test map only when hit testing is requested.
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
      onNodeClick={onNodeClick}
      onNodeHover={handleNodeHover}
      onNodeContextMenu={onNodeContextMenu}
    />
  );
}

export const GraphStoreCanvas = memo(GraphStoreCanvasComponent);
