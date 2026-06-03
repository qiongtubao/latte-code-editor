import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PromptModal } from "./PromptModal.js";

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
 * Position-clamped context-menu state. Coordinates are viewport-relative
 * (CSS pixels) so the menu can be rendered with `position: fixed`.
 */
interface ContextMenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

/** Open modal: which kind of create + the parent directory's rel path. */
type ModalState =
  | { kind: "create-file"; parentPath: string }
  | { kind: "create-dir"; parentPath: string };

/**
 * Compute the parent rel-path of `p`. The root's parent is `""` (the
 * workspace root) — which is the value `cmd_list_dir` expects for the
 * root listing. Returns `""` for entries at the workspace root.
 */
function parentPathOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.substring(0, idx);
}

/** Clamp a (x, y) so an item of size (w, h) stays inside the viewport. */
function clampPosition(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(x, window.innerWidth - w)),
    y: Math.max(0, Math.min(y, window.innerHeight - h)),
  };
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
 * - Right-click on a row opens a small context menu (New File / New Folder
 *   / ─ / Delete). Delete is gated by a native confirm dialog from
 *   `cmd_confirm_delete`; create flows go through a `PromptModal`.
 */
export function FileTree({ workspace, onFileOpen }: FileTreeProps) {
  // Keyed by the workspace-relative path used in IPC calls. `""` is the root.
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const bannerTimer = useRef<number | null>(null);

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
    setContextMenu(null);
    setModal(null);
    setModalError(null);
    setBannerError(null);
    void fetchChildren("");
  }, [workspace, fetchChildren]);

  // Dismiss the context menu on any mousedown outside the menu ul. We
  // use `mousedown` (not `click` or `contextmenu`) so the menu closes
  // before any new click on a row re-opens it. The handler is attached
  // only while the menu is open to avoid a global listener at rest.
  useEffect(() => {
    if (contextMenu === null) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-testid="file-tree-contextmenu"]')) {
        return; // click inside the menu — let the menu handle it
      }
      setContextMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [contextMenu]);

  // Cancel any pending banner timer on unmount so we don't setState on
  // an unmounted component. Also clear on workspace change (handled by
  // the effect above via the `setBannerError(null)` call).
  useEffect(() => {
    return () => {
      if (bannerTimer.current !== null) {
        clearTimeout(bannerTimer.current);
        bannerTimer.current = null;
      }
    };
  }, []);

  const showBanner = (msg: string) => {
    setBannerError(msg);
    if (bannerTimer.current !== null) clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => {
      setBannerError(null);
      bannerTimer.current = null;
    }, 5000);
  };

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

  const onContextMenu = (entry: FsEntry, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 200x124 are the menu's max bounding box; clamped to viewport.
    const pos = clampPosition(e.clientX, e.clientY, 200, 124);
    setContextMenu({ x: pos.x, y: pos.y, entry });
  };

  const handleNewFile = (entry: FsEntry) => {
    setContextMenu(null);
    setModalError(null);
    setModal({ kind: "create-file", parentPath: entry.path });
  };
  const handleNewDir = (entry: FsEntry) => {
    setContextMenu(null);
    setModalError(null);
    setModal({ kind: "create-dir", parentPath: entry.path });
  };

  const handleDelete = async (entry: FsEntry) => {
    setContextMenu(null);
    let confirmed: boolean;
    try {
      confirmed = await invoke<boolean>("cmd_confirm_delete", { path: entry.path });
    } catch (err) {
      showBanner(`confirm dialog failed: ${String(err)}`);
      return;
    }
    if (!confirmed) return;
    try {
      await invoke("cmd_delete_entry", { path: entry.path });
    } catch (err) {
      showBanner(`delete failed: ${String(err)}`);
      return;
    }
    // Drop expanded state for the deleted dir (if any) so we don't try
    // to render its (now-stale) cached children on next expand.
    if (entry.isDir) {
      setExpanded((prev) => {
        if (!prev.has(entry.path)) return prev;
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
    }
    await fetchChildren(parentPathOf(entry.path));
  };

  const submitModal = async (name: string) => {
    if (modal === null) return;
    const parent = modal.parentPath;
    const newPath = parent === "" ? name : `${parent}/${name}`;
    const cmd = modal.kind === "create-file" ? "cmd_create_file" : "cmd_create_dir";
    try {
      await invoke(cmd, { path: newPath });
      setModal(null);
      setModalError(null);
      await fetchChildren(parent);
    } catch (err) {
      // Keep the modal open and surface the error inline.
      setModalError(String(err));
    }
  };

  if (workspace === null) return null;

  return (
    <div className="relative flex">
      <div
        data-testid="file-tree"
        className="w-[280px] h-full overflow-y-auto bg-zinc-900 text-zinc-200 text-xs border-r border-zinc-700"
      >
        {bannerError !== null && (
          <div
            data-testid="file-tree-error"
            role="alert"
            className="px-2 py-1 bg-red-900/60 text-red-100 border-b border-red-800 whitespace-pre-wrap break-words"
          >
            {bannerError}
          </div>
        )}
        <ul className="py-1">
          <TreeNode
            depth={0}
            entries={childrenByPath[""] ?? []}
            expanded={expanded}
            loading={loading}
            onToggle={onToggle}
            onFileClick={onFileOpen}
            onContextMenu={onContextMenu}
            childrenByPath={childrenByPath}
          />
        </ul>
      </div>

      {contextMenu !== null && (
        <ul
          data-testid="file-tree-contextmenu"
          role="menu"
          className="fixed z-40 min-w-[180px] py-1 rounded border border-zinc-700 bg-zinc-800 text-zinc-100 shadow-lg text-xs"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {contextMenu.entry.isDir && (
            <>
              <li>
                <button
                  type="button"
                  data-testid="ctx-item-new-file"
                  role="menuitem"
                  className="w-full text-left px-3 py-1 hover:bg-zinc-700"
                  onClick={() => handleNewFile(contextMenu.entry)}
                >
                  New File
                </button>
              </li>
              <li>
                <button
                  type="button"
                  data-testid="ctx-item-new-dir"
                  role="menuitem"
                  className="w-full text-left px-3 py-1 hover:bg-zinc-700"
                  onClick={() => handleNewDir(contextMenu.entry)}
                >
                  New Folder
                </button>
              </li>
              <li aria-hidden="true" className="my-1 border-t border-zinc-700" />
            </>
          )}
          <li>
            <button
              type="button"
              data-testid="ctx-item-delete"
              role="menuitem"
              className="w-full text-left px-3 py-1 hover:bg-red-700/60 text-red-200"
              onClick={() => void handleDelete(contextMenu.entry)}
            >
              Delete
            </button>
          </li>
        </ul>
      )}

      <PromptModal
        open={modal !== null}
        title={modal?.kind === "create-dir" ? "New Folder" : "New File"}
        label="Name"
        error={modalError}
        submitLabel="Create"
        onCancel={() => {
          setModal(null);
          setModalError(null);
        }}
        onSubmit={(v) => void submitModal(v)}
      />
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
  onContextMenu: (entry: FsEntry, e: React.MouseEvent) => void;
  childrenByPath: Record<string, FsEntry[]>;
}

function TreeNode({
  depth,
  entries,
  expanded,
  loading,
  onToggle,
  onFileClick,
  onContextMenu,
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
              data-testid={`tree-row-${entry.path}`}
              className="flex items-center gap-1 px-1 py-0.5 hover:bg-zinc-800 cursor-pointer select-none"
              style={{ paddingLeft: 4 + depth * 12 }}
              onClick={() => {
                if (entry.isDir) {
                  onToggle(childRel, true);
                } else {
                  onFileClick(entry.path, entry.name);
                }
              }}
              onContextMenu={(e) => onContextMenu(entry, e)}
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
                  onContextMenu={onContextMenu}
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
