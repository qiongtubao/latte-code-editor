import { useState, useCallback } from "react";
import type { FsEntry } from "../api/commands";
import { listDirectory, createFile, createFolder, deleteEntry } from "../api/commands";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface FileTreeProps {
  root: string;
  entries: FsEntry[];
  onFileOpen: (path: string) => void;
}

interface CtxMenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

function FileTreeItem({
  entry,
  depth,
  onFileOpen,
  onContextMenu,
}: {
  entry: FsEntry;
  depth: number;
  onFileOpen: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
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

    if (!children) {
      setLoading(true);
      try {
        setChildren(await listDirectory(entry.path));
      } catch {
        setChildren([]);
      }
      setLoading(false);
    }
    setExpanded(true);
  }, [entry, expanded, children, onFileOpen]);

  const ext = entry.name.split(".").pop()?.toLowerCase();
  const padLeft = depth * 16;

  let icon = "📄";
  if (entry.is_dir) {
    icon = expanded ? "📂" : "📁";
  } else {
    const iconMap: Record<string, string> = {
      ts: "🟦", tsx: "⚛️", js: "🟨", jsx: "⚛️",
      rs: "🦀", py: "🐍", json: "📋", md: "📝",
      css: "🎨", html: "🌐", toml: "⚙️", yaml: "⚙️", yml: "⚙️",
    };
    icon = iconMap[ext || ""] || "📄";
  }

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-0.5 cursor-pointer select-none hover:bg-[#2a2d2e] text-xs truncate"
        style={{ paddingLeft: `${padLeft + 8}px` }}
        onClick={handleToggle}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, entry); }}
        title={entry.path}
      >
        <span className="flex-shrink-0 w-4 text-center text-xs">
          {loading ? "⏳" : icon}
        </span>
        <span className="truncate text-gray-300">{entry.name}</span>
      </div>

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
              depth={depth + 1}
              onFileOpen={onFileOpen}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ root, entries, onFileOpen }: FileTreeProps) {
  const rootName = root.split("/").pop() || root.split("\\").pop() || root;
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const promptAndCreate = useCallback(
    async (parentPath: string, isFolder: boolean) => {
      const name = window.prompt(isFolder ? "Folder name:" : "File name:");
      if (!name || !name.trim()) return;
      const fullPath = `${parentPath}/${name.trim()}`;
      try {
        if (isFolder) await createFolder(fullPath);
        else await createFile(fullPath);
        setRefreshVersion((v) => v + 1);
      } catch (e) {
        alert(`Failed: ${e}`);
      }
    },
    [],
  );

  const handleDelete = useCallback(async (targetPath: string) => {
    if (!window.confirm(`Delete "${targetPath.split("/").pop()}"?`)) return;
    try {
      await deleteEntry(targetPath);
      setRefreshVersion((v) => v + 1);
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  }, []);

  const buildMenuItems = (): ContextMenuItem[] => {
    if (!ctxMenu) return [];
    const { entry } = ctxMenu;
    const items: ContextMenuItem[] = [];

    if (entry.is_dir) {
      items.push({ label: "New File", onClick: () => promptAndCreate(entry.path, false) });
      items.push({ label: "New Folder", onClick: () => promptAndCreate(entry.path, true) });
      items.push({ label: "", separator: true, onClick: () => {} });
    }

    items.push({ label: "Delete", shortcut: "Del", onClick: () => handleDelete(entry.path) });
    return items;
  };

  return (
    <div key={refreshVersion} className="h-full overflow-y-auto text-sm" style={{ background: "#252526" }}>
      <div className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-400 border-b border-gray-700">
        <span>📂</span>
        <span className="truncate">{rootName}</span>
      </div>

      {entries.length === 0 && (
        <div className="text-gray-500 text-xs px-3 py-2 italic">empty folder</div>
      )}
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.path}
          entry={entry}
          depth={0}
          onFileOpen={onFileOpen}
          onContextMenu={handleContextMenu}
        />
      ))}

      {ctxMenu && (
        <ContextMenu
          items={buildMenuItems()}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
