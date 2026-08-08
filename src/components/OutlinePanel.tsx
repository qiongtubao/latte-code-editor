import { useMemo, useCallback } from "react";
import { useEditorStore } from "../hooks/useEditorStore";
import { useGraphStore } from "../hooks/useGraphStore";
import { openFile } from "../api/commands";
import { NODE_COLORS } from "./graphRenderer";

const KIND_LABELS: Record<string, string> = {
  function: "fn",
  method: "fn",
  class: "cls",
  interface: "iface",
  struct: "struct",
  type: "type",
  type_alias: "type",
  enum: "enum",
  constant: "const",
  variable: "var",
  import: "import",
  file: "file",
};

const KIND_ORDER: Record<string, number> = {
  class: 0,
  interface: 1,
  struct: 2,
  enum: 3,
  type: 4,
  type_alias: 5,
  function: 6,
  method: 7,
  constant: 8,
  variable: 9,
  import: 10,
};

export function OutlinePanel() {
  const { filePath } = useEditorStore();
  const { graphData } = useGraphStore();

  const symbols = useMemo(() => {
    if (!graphData || !filePath) return [];

    // Normalize paths
    const normalizedFilePath = filePath.replace(/\\/g, "/");

    return graphData.nodes
      .filter((n) => {
        const nPath = n.file_path.replace(/\\/g, "/");
        return nPath === normalizedFilePath && n.kind !== "file";
      })
      .sort((a, b) => {
        const aOrder = KIND_ORDER[a.kind] ?? 99;
        const bOrder = KIND_ORDER[b.kind] ?? 99;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.start_line - b.start_line;
      });
  }, [graphData, filePath]);

  const handleSymbolClick = useCallback(
    async (node: (typeof symbols)[0]) => {
      try {
        const result = await openFile(node.file_path);
        useEditorStore.getState().openFileOrSwitch(result, node.start_line);
      } catch (e) {
        console.error("Cannot open file:", e);
      }
    },
    [],
  );
  // Hide entirely when nothing to show
  if (!filePath || symbols.length === 0) {
    return null;
  }

  const nodeColor = (kind: string): string => {
    const groupMap: Record<string, number> = {
      file: 0, function: 1, method: 1,
      class: 2, interface: 2, struct: 2,
      type: 3, type_alias: 3, enum: 3,
      import: 4, export: 4,
      constant: 5, variable: 5,
    };
    return NODE_COLORS[groupMap[kind] ?? 7] || "var(--fg-3)";
  };

  return (
    <div className="text-xs overflow-y-auto" style={{ background: "var(--surface-2)", maxHeight: "200px" }}>
      <div className="px-3 py-1 text-fg-3 font-medium border-b border-edge">
        Outline ({symbols.length})
      </div>
      {symbols.map((node) => (
        <div
          key={node.id}
          onClick={() => handleSymbolClick(node)}
          className="flex items-center gap-2 px-3 py-0.5 cursor-pointer hover:bg-surface-3 truncate"
          title={`${node.kind}: ${node.name} (line ${node.start_line})`}
        >
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: nodeColor(node.kind) }}
          />
          <span className="text-fg-2 w-8 flex-shrink-0 text-right font-mono">
            {node.start_line}
          </span>
          <span className="text-fg truncate">{node.name}</span>
        </div>
      ))}
    </div>
  );
}
