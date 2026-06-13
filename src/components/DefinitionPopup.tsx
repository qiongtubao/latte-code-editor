import { useState, useEffect, useCallback, useRef } from "react";
import { graphFindDefinitions } from "../api/graphCommands";
import { openFile } from "../api/commands";
import type { GraphData } from "../hooks/graphTypes";
import { NODE_COLORS } from "./graphRenderer";
import { useEditorStore } from "../hooks/useEditorStore";

interface DefinitionPopupProps {
  word: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export function DefinitionPopup({ word, position, onClose }: DefinitionPopupProps) {
  const [results, setResults] = useState<GraphData["nodes"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function search() {
      setLoading(true);
      try {
        const resp = await graphFindDefinitions(word);
        if (!cancelled) setResults(resp.nodes);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    search();
    return () => { cancelled = true; };
  }, [word]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Close on Escape
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const handleJump = useCallback(async (node: GraphData["nodes"][0]) => {
    try {
      const result = await openFile(node.file_path);
      useEditorStore.getState().openFileOrSwitch(result, node.start_line);
    } catch (e) {
      console.error("Cannot jump to definition:", e);
    }
  }, [onClose]);

  const nodeColor = (kind: string): string => {
    const groupMap: Record<string, number> = {
      file: 0,
      function: 1,
      method: 1,
      class: 2,
      interface: 2,
      struct: 2,
      type: 3,
      type_alias: 3,
      enum: 3,
      import: 4,
      export: 4,
      constant: 5,
      variable: 5,
    };
    return NODE_COLORS[groupMap[kind] ?? 7] || "#808080";
  };

  const kindLabel = (kind: string): string => {
    const labels: Record<string, string> = {
      function: "fn",
      method: "method",
      class: "class",
      interface: "interface",
      struct: "struct",
      type: "type",
      type_alias: "type",
      enum: "enum",
      constant: "const",
      variable: "var",
    };
    return labels[kind] || kind;
  };

  // Constrain to viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(position.x, window.innerWidth - 380),
    top: Math.min(position.y, window.innerHeight - 300),
    zIndex: 1000,
    width: "360px",
    maxHeight: "280px",
    background: "#2d2d2d",
    border: "1px solid #454545",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div ref={popupRef} style={style}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 text-xs border-b border-gray-700 bg-[#333] select-none">
        <span className="text-gray-300 font-medium">
          {loading
            ? "Searching..."
            : results.length >= 200
              ? `${results.length}+ definitions for "${word}" — refine the search to narrow`
              : `${results.length} definition(s) for "${word}"`}
        </span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white cursor-pointer text-sm leading-none px-1"
        >
          ×
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto text-xs">
        {loading && (
          <div className="px-3 py-4 text-gray-500 text-center">Searching graph...</div>
        )}
        {error && (
          <div className="px-3 py-4 text-yellow-400 text-center">{error}</div>
        )}
        {!loading && !error && results.length === 0 && (
          <div className="px-3 py-4 text-gray-500 text-center">
            No definitions found for "{word}"
          </div>
        )}
        {results.map((node) => {
          const fileName = node.file_path.split("/").pop() || node.file_path;
          return (
            <div
              key={node.id}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => handleJump(node)}
              onDoubleClick={() => handleJump(node)}
              className="flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#3a3a3a] border-b border-gray-800 last:border-0"
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1"
                style={{ background: nodeColor(node.kind) }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-gray-200 font-medium truncate">
                    {node.name}
                  </span>
                  <span className="text-gray-500 flex-shrink-0">
                    {kindLabel(node.kind)}
                  </span>
                </div>
                <div className="text-gray-500 truncate mt-0.5">
                  {node.file_path}:{node.start_line}
                </div>
                {node.signature && (
                  <div className="text-gray-500 font-mono truncate mt-0.5 opacity-70">
                    {node.signature}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
