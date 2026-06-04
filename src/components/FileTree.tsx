import { useState, useCallback } from "react";
import type { FsEntry } from "../api/commands";
import { listDirectory } from "../api/commands";
import { openFile } from "../api/commands";

interface FileTreeProps {
  root: string;
  entries: FsEntry[];
  onFileOpen: (path: string) => void;
}

function FileTreeItem({
  entry,
  rootPath,
  depth,
  onFileOpen,
}: {
  entry: FsEntry;
  rootPath: string;
  depth: number;
  onFileOpen: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleToggle = useCallback(async () => {
    if (!entry.is_dir) {
      onFileOpen(entry.path);
      return;
    }

    if (expanded) {
      setExpanded(false);
      return;
    }

    // Load children if not loaded
    if (!children) {
      setLoading(true);
      try {
        const result = await listDirectory(entry.path);
        setChildren(result);
      } catch {
        setChildren([]);
      }
      setLoading(false);
    }

    setExpanded(true);
  }, [entry, expanded, children, onFileOpen]);

  const ext = entry.name.split(".").pop()?.toLowerCase();
  const padLeft = depth * 16;

  // File type icon
  let icon = "📄";
  if (entry.is_dir) {
    icon = expanded ? "📂" : "📁";
  } else {
    const iconMap: Record<string, string> = {
      ts: "🟦",
      tsx: "⚛️",
      js: "🟨",
      jsx: "⚛️",
      rs: "🦀",
      py: "🐍",
      json: "📋",
      md: "📝",
      css: "🎨",
      html: "🌐",
      toml: "⚙️",
      yaml: "⚙️",
      yml: "⚙️",
    };
    icon = iconMap[ext || ""] || "📄";
  }

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-0.5 cursor-pointer select-none hover:bg-[#2a2d2e] text-xs truncate"
        style={{ paddingLeft: `${padLeft + 8}px` }}
        onClick={handleToggle}
        onContextMenu={(e) => e.preventDefault()}
        title={entry.path}
      >
        <span className="flex-shrink-0 w-4 text-center text-xs">
          {loading ? "⏳" : icon}
        </span>
        <span className="truncate text-gray-300">{entry.name}</span>
      </div>

      {/* Children (lazy loaded) */}
      {expanded && children && (
        <div>
          {children.length === 0 && (
            <div
              className="text-gray-600 text-xs px-2 py-0.5 italic"
              style={{ paddingLeft: `${padLeft + 24}px` }}
            >
              empty
            </div>
          )}
          {children.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              rootPath={rootPath}
              depth={depth + 1}
              onFileOpen={onFileOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ root, entries, onFileOpen }: FileTreeProps) {
  const rootName = root.split("/").pop() || root.split("\\").pop() || root;

  return (
    <div className="h-full overflow-y-auto text-sm" style={{ background: "#252526" }}>
      {/* Root folder header */}
      <div className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-400 border-b border-gray-700">
        <span>📂</span>
        <span className="truncate">{rootName}</span>
      </div>

      {/* File list */}
      {entries.length === 0 && (
        <div className="text-gray-500 text-xs px-3 py-2 italic">empty folder</div>
      )}
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.path}
          entry={entry}
          rootPath={root}
          depth={0}
          onFileOpen={onFileOpen}
        />
      ))}
    </div>
  );
}
