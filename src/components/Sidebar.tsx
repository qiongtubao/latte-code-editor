import { useState, useCallback, useEffect } from "react";
import { FileTree } from "./FileTree";
import { WorkspaceSearch } from "./WorkspaceSearch";
import { openFolder, buildCodeGraph, searchInFiles, replaceInFiles } from "../api/commands";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import type { FsEntry } from "../api/commands";
import { useGraphStore } from "../hooks/useGraphStore";

interface SidebarProps {
  folderRoot: string | null;
  folderEntries: FsEntry[];
  onFolderChange: (root: string, entries: FsEntry[]) => void;
  onFileOpen: (path: string) => void;
}

type SidebarPanel = "explorer" | "search";

export function Sidebar({ folderRoot, folderEntries, onFolderChange, onFileOpen }: SidebarProps) {
  const [building, setBuilding] = useState(false);
  const [panel, setPanel] = useState<SidebarPanel>("explorer");
  const requestReload = useGraphStore((s) => s.requestReload);

  const handleOpenFolder = useCallback(async () => {
    const selected = await dialogOpen({ multiple: false, directory: true });
    if (typeof selected === "string") {
      try {
        const result = await openFolder(selected);
        onFolderChange(result.root, result.entries);
        requestReload();
        if (!result.has_graph) {
          setBuilding(true);
          try {
            const buildResult = await buildCodeGraph();
            console.log(`Graph built: ${buildResult.nodes_created} nodes, ${buildResult.edges_created} edges`);
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
  }, [onFolderChange, requestReload]);

  // Listen for "open-folder" custom event
  useEffect(() => {
    const handler = () => handleOpenFolder();
    window.addEventListener("open-folder", handler);
    return () => window.removeEventListener("open-folder", handler);
  }, [handleOpenFolder]);

  // Keyboard shortcuts: Ctrl+Shift+F => search
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

  // No folder opened: show only the open button
  if (!folderRoot) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-xs" style={{ background: "#252526" }}>
        <button onClick={handleOpenFolder} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs cursor-pointer transition-colors">Open Folder</button>
        <p className="text-gray-500 mt-2">Ctrl+K Ctrl+O</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Panel tabs */}
      <div className="flex text-xs border-b border-gray-700 bg-[#2d2d2d]">
        <button onClick={() => setPanel("explorer")} className={`flex items-center gap-1 px-3 py-1.5 cursor-pointer border-b-[2px] transition-colors ${panel === "explorer" ? "border-[#007acc] text-gray-200" : "border-transparent text-gray-500 hover:text-gray-300"}`}>
          📁 Explorer
        </button>
        <button onClick={() => setPanel("search")} className={`flex items-center gap-1 px-3 py-1.5 cursor-pointer border-b-[2px] transition-colors ${panel === "search" ? "border-[#007acc] text-gray-200" : "border-transparent text-gray-500 hover:text-gray-300"}`}>
          🔍 Search
        </button>
      </div>

      {/* Build progress */}
      {building && (
        <div className="px-3 py-1.5 text-xs text-yellow-400 border-b border-gray-700 bg-[#1e1e1e] flex items-center gap-2">
          <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
          Building code graph…
        </div>
      )}

      {/* Panel content */}
      {panel === "explorer" ? (
        <div className="flex-1 overflow-hidden">
          <FileTree root={folderRoot} entries={folderEntries} onFileOpen={onFileOpen} />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <WorkspaceSearch onSearch={handleSearch} onReplace={handleReplace} />
        </div>
      )}
    </div>
  );
}
