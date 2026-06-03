import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * One entry in a directory listing. Mirrors the Rust `FsEntry` in
 * `crates/latte-editor/src/cmd/fs.rs` (camelCase via `#[serde(rename_all)]`).
 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface FileTreeProps {
  /** Absolute workspace path, or `null` if no workspace is open. */
  workspace: string | null;
  /** Called with the workspace-relative `path` and the file's `name` when the user clicks a file. */
  onFileOpen: (path: string, name: string) => void;
}

/**
 * Recursive file tree sidebar.
 *
 * - Hides nothing itself: the parent layout is responsible for not rendering
 *   this component when `workspace` is `null`.
 * - `cmd_list_dir` is filtered server-side (`node_modules`, `.git`, `target`),
 *   so the tree never sees those entries.
 * - Each directory is fetched lazily on first expand. Collapsing keeps the
 *   cached children so a re-expand is instant.
 */
export function FileTree({ workspace, onFileOpen }: FileTreeProps) {
  // Keyed by the workspace-relative path used in IPC calls. `""` is the root.
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Fetch the children of `rel`. Caller is responsible for adding the
  // directory to `expanded` (or for treating this as a re-fetch).
  const fetchChildren = useCallback(async (rel: string) => {
    setLoading((prev) => {
      if (prev.has(rel)) return prev;
      const next = new Set(prev);
      next.add(rel);
      return next;
    });
    try {
      const entries = await invoke<FsEntry[]>("cmd_list_dir", {
        path: rel === "" ? null : rel,
      });
      setChildrenByPath((prev) => ({ ...prev, [rel]: entries }));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(rel);
        return next;
      });
    }
  }, []);

  // On workspace change: clear everything and fetch the root.
  useEffect(() => {
    if (workspace === null) return;
    setChildrenByPath({});
    setExpanded(new Set());
    setLoading(new Set());
    void fetchChildren("");
  }, [workspace, fetchChildren]);

  if (workspace === null) return null;

  const onToggle = (rel: string, isDir: boolean) => {
    if (!isDir) {
      // Files don't toggle — they're opened on click. The click is handled
      // by the row's own onClick (see TreeNode below).
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) {
        next.delete(rel);
      } else {
        next.add(rel);
        if (!childrenByPath[rel]) {
          void fetchChildren(rel);
        }
      }
      return next;
    });
  };

  return (
    <div
      data-testid="file-tree"
      className="w-[280px] h-full overflow-y-auto bg-zinc-900 text-zinc-200 text-xs border-r border-zinc-700"
    >
      <ul className="py-1">
        <TreeNode
          depth={0}
          entries={childrenByPath[""] ?? []}
          expanded={expanded}
          loading={loading}
          onToggle={onToggle}
          onFileClick={onFileOpen}
          childrenByPath={childrenByPath}
        />
      </ul>
    </div>
  );
}

interface TreeNodeProps {
  depth: number;
  entries: FsEntry[];
  expanded: Set<string>;
  loading: Set<string>;
  onToggle: (rel: string, isDir: boolean) => void;
  onFileClick: (path: string, name: string) => void;
  childrenByPath: Record<string, FsEntry[]>;
}

function TreeNode({
  depth,
  entries,
  expanded,
  loading,
  onToggle,
  onFileClick,
  childrenByPath,
}: TreeNodeProps) {
  return (
    <>
      {entries.map((entry) => {
        const childRel = entry.path;
        const isOpen = expanded.has(childRel);
        const isLoading = loading.has(childRel);
        return (
          <li key={entry.path}>
            <div
              className="flex items-center gap-1 px-1 py-0.5 hover:bg-zinc-800 cursor-pointer select-none"
              style={{ paddingLeft: 4 + depth * 12 }}
              onClick={() => {
                if (entry.isDir) {
                  onToggle(childRel, true);
                } else {
                  onFileClick(entry.path, entry.name);
                }
              }}
            >
              {entry.isDir ? (
                <span className="w-3 inline-block text-zinc-400">
                  {isLoading ? "…" : isOpen ? "▾" : "▸"}
                </span>
              ) : (
                <span className="w-3 inline-block" />
              )}
              <span className="truncate">{entry.name}</span>
            </div>
            {entry.isDir && isOpen && childrenByPath[childRel] && (
              <ul>
                <TreeNode
                  depth={depth + 1}
                  entries={childrenByPath[childRel]}
                  expanded={expanded}
                  loading={loading}
                  onToggle={onToggle}
                  onFileClick={onFileClick}
                  childrenByPath={childrenByPath}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}
