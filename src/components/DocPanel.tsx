/**
 * Docs panel — third sidebar tab.
 *
 * Lists markdown files under `docs/` grouped by document type
 * (entities, concepts, features, etc.), mirroring latte-doc-wiki's
 * directory convention.
 */
import { useState, useEffect, useCallback } from "react";
import { listDirectory } from "../api/commands";
import type { FsEntry } from "../api/commands";

interface Props {
  onDocOpen: (path: string) => void;
  folderRoot: string | null;
}

interface DocGroup {
  type: string;
  entries: FsEntry[];
}

export function DocPanel({ onDocOpen, folderRoot }: Props) {
  const [groups, setGroups] = useState<DocGroup[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!folderRoot) { setGroups([]); return; }
    setLoading(true);
    try {
      const docsRoot = folderRoot + "/docs";
      const entries = await listDirectory(docsRoot).catch(() => [] as FsEntry[]);
      // Group by top-level directory
      const map: Record<string, FsEntry[]> = {};
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const key = e.is_dir ? e.name : "(files)";
        (map[key] ??= []).push(e);
      }
      const sorted: DocGroup[] = Object.entries(map)
        .filter(([, v]) => v.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, entries]) => ({
          type,
          entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
        }));
      setGroups(sorted);
    } finally {
      setLoading(false);
    }
  }, [folderRoot]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="flex-1 overflow-y-auto text-xs">
      <div className="px-2 py-1 text-fg-3 text-[10px] border-b border-edge flex justify-between items-center">
        <span>{loading ? "Loading docs..." : groups.reduce((s, g) => s + g.entries.length, 0) + " docs"}</span>
        <button onClick={refresh} className="text-fg-2 hover:text-fg" title="Refresh">↻</button>
      </div>
      {!folderRoot && (
        <div className="px-3 py-6 text-fg-3 text-center">
          Open a folder to see docs
        </div>
      )}
      {groups.map((g) => (
        <div key={g.type}>
          <div className="px-2 py-1 text-fg-2 font-medium text-[10px] uppercase tracking-wider bg-surface-2 sticky top-0">
            {g.type}
          </div>
          {g.entries.map((e) => (
            <div
              key={e.path}
              className="flex items-center px-3 py-1 cursor-pointer hover:bg-control text-fg gap-2"
              onClick={() => onDocOpen(e.path)}
            >
              <span className="shrink-0">{e.is_dir ? "📁" : "📄"}</span>
              <span className="truncate">{e.name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
