import { useState, useEffect, useCallback, useRef } from "react";
import { graphFindDefinitions } from "../api/graphCommands";
import { openFile } from "../api/commands";
import type { GraphData } from "../hooks/graphTypes";
import { NODE_COLORS } from "./graphRenderer";
import { useEditorStore } from "../hooks/useEditorStore";

interface DefinitionPopupProps {
  word: string;
  callerFile?: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export function DefinitionPopup({ word, callerFile, position, onClose }: DefinitionPopupProps) {
  const [results, setResults] = useState<GraphData["nodes"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function search() {
      setLoading(true);
      try {
        const resp = await graphFindDefinitions(word, callerFile);
        if (!cancelled) setResults(resp.nodes);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void search();
    return () => { cancelled = true; };
  }, [word, callerFile]);

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
    onClose();
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
    return NODE_COLORS[groupMap[kind] ?? 7] || "var(--fg-3)";
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
    background: "var(--surface-3)",
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
      <div className="flex items-center justify-between px-3 py-1.5 text-xs border-b border-edge bg-surface-3 select-none">
        <span className="text-fg font-medium">
          {loading
            ? "Searching..."
            : results.length >= 200
              ? `${results.length}+ definitions for "${word}" — refine the search to narrow`
              : `${results.length} definition(s) for "${word}"`}
        </span>
        <button
          onClick={onClose}
          className="text-fg-3 hover:text-fg cursor-pointer text-sm leading-none px-1"
        >
          ×
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto text-xs">
        {loading && (
          <div className="px-3 py-4 text-fg-3 text-center">Searching graph...</div>
        )}
        {error && (
          <div className="px-3 py-4 text-warn text-center">{error}</div>
        )}
        {!loading && !error && results.length === 0 && (
          <div className="px-3 py-4 text-fg-3 text-center">
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
              className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer border-b border-edge last:border-0 ${callerFile && node.file_path === callerFile ? "bg-ok-bg hover:bg-ok-bg" : "hover:bg-control"}`}
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1"
                style={{ background: nodeColor(node.kind) }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg font-medium truncate">
                    {node.name}
                  </span>
                  <span className="text-fg flex-shrink-0">
                    {kindLabel(node.kind)}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-fg truncate mt-0.5">
                  <span>{node.file_path}:{node.start_line}</span>
                  {callerFile && node.file_path === callerFile && (
                    <span className="text-ok text-[9px] border border-ok rounded px-1 leading-tight">current</span>
                  )}
                </div>
                {node.signature && (
                  <div className="text-fg-2 font-mono truncate mt-0.5">
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
