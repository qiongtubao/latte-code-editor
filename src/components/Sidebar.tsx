import { useState, useCallback, useEffect } from "react";
import { FileTree } from "./FileTree";
import { WorkspaceSearch } from "./WorkspaceSearch";
import { DocPanel } from "./DocPanel";
import { buildCodeGraph, listDirectory, searchInFiles, replaceInFiles } from "../api/commands";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import type { FsEntry } from "../api/commands";
import { useGraphStore } from "../hooks/useGraphStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";

interface SidebarProps {
  folderRoot: string | null;
  onFileOpen: (path: string) => void;
}
type SidebarPanel = "explorer" | "search" | "docs";

/**
 * 侧边栏：按当前 active workspace 显示项目根目录的文件树 + 搜索面板
 * 多工作区改造：
 * - folderRoot 从 useWorkspaceStore 派生
 * - 顶层目录条目用 listDirectory 主动拉取
 * - 打开文件夹直接走 useWorkspaceStore.openFolder
 */
export function Sidebar({ folderRoot, onFileOpen }: SidebarProps) {
  const [building, setBuilding] = useState(false);
  const [panel, setPanel] = useState<SidebarPanel>("explorer");
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);
  const requestReload = useGraphStore((s) => s.requestReload);
  const openFolder = useWorkspaceStore((s) => s.openFolder);

  // folderRoot 变化时拉顶层条目
  useEffect(() => {
    if (!folderRoot) {
      setRootEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const entries = await listDirectory(folderRoot);
        if (!cancelled) setRootEntries(entries);
      } catch (e) {
        if (!cancelled) {
          console.error("listDirectory failed:", e);
          setRootEntries([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderRoot]);

  const handleOpenFolder = useCallback(async () => {
    const selected = await dialogOpen({ multiple: false, directory: true });
    if (typeof selected === "string") {
      try {
        const result = await openFolder(selected);
        requestReload();
        if (!result.has_graph) {
          setBuilding(true);
          try {
            const buildResult = await buildCodeGraph();
            console.log(
              `Graph built: ${buildResult.nodes_created} nodes, ${buildResult.edges_created} edges`,
            );
          } catch (e) {
            console.error("Graph build failed:", e);
          } finally {
            setBuilding(false);
            requestReload();
          }
        }
      } catch (e) {
        console.error("Failed to open folder:", e);
      }
    }
  }, [openFolder, requestReload]);

  // Listen for "open-folder" custom event
  useEffect(() => {
    const handler = () => handleOpenFolder();
    window.addEventListener("open-folder", handler);
    return () => window.removeEventListener("open-folder", handler);
  }, [handleOpenFolder]);

  // Listen for "focus-search" custom event (from App.tsx Ctrl+Shift+F)
  useEffect(() => {
    const handler = () => setPanel("search");
    window.addEventListener("focus-search", handler);
    return () => window.removeEventListener("focus-search", handler);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "f") {
        e.preventDefault();
        setPanel("search");
      }
      if (e.ctrlKey && e.shiftKey && e.key === "e") {
        e.preventDefault();
        setPanel("explorer");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSearch = useCallback(async (q: string, inc?: string, exc?: string) => {
    return searchInFiles(q, inc, exc);
  }, []);

  const handleReplace = useCallback(async (q: string, r: string, inc?: string, exc?: string) => {
    return replaceInFiles(q, r, inc, exc);
  }, []);

  if (!folderRoot) {
    return (
      <div
        className="flex flex-col h-full items-center justify-center text-xs"
        style={{ background: "var(--surface-2)" }}
      >
        <button
          onClick={handleOpenFolder}
          className="px-3 py-1.5 bg-accent hover:bg-accent text-white rounded text-xs cursor-pointer transition-colors"
        >
          Open Folder
        </button>
        <p className="text-fg-3 mt-2">Ctrl+K Ctrl+O</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex text-xs border-b border-edge bg-surface-3">
        <button
          onClick={() => setPanel("explorer")}
          className={`flex items-center gap-1 px-3 py-1.5 cursor-pointer border-b-[2px] transition-colors ${
            panel === "explorer"
              ? "border-accent text-fg"
              : "border-transparent text-fg-3 hover:text-fg"
          }`}
        >
          📁 Explorer
        </button>
        <button
          onClick={() => setPanel("search")}
          className={`flex items-center gap-1 px-3 py-1.5 cursor-pointer border-b-[2px] transition-colors ${
            panel === "search"
              ? "border-accent text-fg"
              : "border-transparent text-fg-3 hover:text-fg"
          }`}
        >
          🔍 Search
        </button>
        <button
          onClick={() => setPanel("docs")}
          className={`flex items-center gap-1 px-3 py-1.5 cursor-pointer border-b-[2px] transition-colors ${
            panel === "docs"
              ? "border-accent text-fg"
              : "border-transparent text-fg-3 hover:text-fg"
          }`}
        >
          📄 Docs
        </button>
      </div>
      {building && (
        <div className="px-3 py-1.5 text-xs text-warn border-b border-edge bg-surface flex items-center gap-2">
          <span className="inline-block w-2 h-2 bg-warn rounded-full animate-pulse" />
          Building code graph…
        </div>
      )}

      <div className={panel === "explorer" ? "flex-1 overflow-hidden flex flex-col" : "hidden"}>
        <FileTree root={folderRoot} entries={rootEntries} onFileOpen={onFileOpen} />
      </div>
      <div className={panel === "search" ? "flex-1 overflow-hidden flex flex-col" : "hidden"}>
        <WorkspaceSearch onSearch={handleSearch} onReplace={handleReplace} />
      </div>
      <div className={panel === "docs" ? "flex-1 overflow-hidden flex flex-col" : "hidden"}>
        <DocPanel onDocOpen={onFileOpen} folderRoot={folderRoot} />
      </div>
    </div>
  );
}
