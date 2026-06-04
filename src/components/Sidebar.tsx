import { useState, useCallback, useEffect } from "react";
import { FileTree } from "./FileTree";
import { openFolder, buildCodeGraph } from "../api/commands";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import type { FsEntry } from "../api/commands";
import { useGraphStore } from "../hooks/useGraphStore";

interface SidebarProps {
  onFileOpen: (path: string) => void;
}

export function Sidebar({ onFileOpen }: SidebarProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [building, setBuilding] = useState(false);
  const requestReload = useGraphStore((s) => s.requestReload);

  const handleOpenFolder = useCallback(async () => {
    const selected = await dialogOpen({
      multiple: false,
      directory: true,
    });

    if (typeof selected === "string") {
      try {
        const result = await openFolder(selected);
        setRoot(result.root);
        setEntries(result.entries);
        requestReload();

        // Auto-build graph if not present
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
  }, [requestReload]);

  // Listen for "open-folder" custom event from App.tsx Ctrl+K Ctrl+O
  useEffect(() => {
    const handler = () => handleOpenFolder();
    window.addEventListener("open-folder", handler);
    return () => window.removeEventListener("open-folder", handler);
  }, [handleOpenFolder]);

  if (!root) {
    return (
      <div
        className="flex flex-col h-full items-center justify-center text-xs"
        style={{ background: "#252526" }}
      >
        <button
          onClick={handleOpenFolder}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs cursor-pointer transition-colors"
        >
          Open Folder
        </button>
        <p className="text-gray-500 mt-2">Ctrl+K Ctrl+O</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {building && (
        <div className="px-3 py-1.5 text-xs text-yellow-400 border-b border-gray-700 bg-[#1e1e1e] flex items-center gap-2">
          <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
          Building code graph…
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        <FileTree root={root} entries={entries} onFileOpen={onFileOpen} />
      </div>
    </div>
  );
}
