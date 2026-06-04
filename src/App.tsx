import { useCallback, useEffect, useState } from "react";
import { EditorPanel } from "./components/EditorPanel";
import { GraphPanel } from "./components/GraphPanel";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { OutlinePanel } from "./components/OutlinePanel";
import type { FsEntry } from "./api/commands";
import { StatusBar } from "./components/StatusBar";
import { DefinitionPopup } from "./components/DefinitionPopup";
import { openFile } from "./api/commands";
import { useEditorStore } from "./hooks/useEditorStore";
import { useGraphStore } from "./hooks/useGraphStore";

type ActivePanel = "editor" | "graph" | "split";

function App() {
  const [activePanel, setActivePanel] = useState<ActivePanel>("split");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { openFileOrSwitch } = useEditorStore();
  const { cursorWord } = useEditorStore();
  const [defPopup, setDefPopup] = useState<{ word: string; x: number; y: number } | null>(null);
  const [folderRoot, setFolderRoot] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FsEntry[]>([]);
  const { filePath } = useEditorStore();
  const { graphData } = useGraphStore();

  // Only show outline column when there are symbols for the current file
  const hasOutline = !!(filePath && graphData?.nodes.some((n) => n.file_path === filePath && n.kind !== "file"));

  // Handle file open from sidebar
  const handleFileOpen = useCallback(
    async (path: string) => {
      try {
        const result = await openFile(path);
        openFileOrSwitch(result);
      } catch (e) {
        console.error("Failed to open file:", e);
      }
    },
    [openFileOrSwitch],
  );

  // Global keyboard shortcuts
  useEffect(() => {
    let ctrlK = false;

    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        ctrlK = true;
        setTimeout(() => { ctrlK = false; }, 500);
        return;
      }

      if (ctrlK && ((e.ctrlKey || e.metaKey) && e.key === "o")) {
        e.preventDefault();
        ctrlK = false;
        window.dispatchEvent(new CustomEvent("open-folder"));
        return;
      }

      // F12: Go to definition
      if (e.key === "F12") {
        e.preventDefault();
        const word = useEditorStore.getState().cursorWord;
        if (word) {
          setDefPopup({ word, x: 200, y: 80 });
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex flex-col h-screen">
      {/* Panel switcher bar */}
      <div className="flex items-center gap-0 text-xs bg-[#2d2d2d] border-b border-gray-700 select-none">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="px-2 py-1.5 border-r border-gray-700 cursor-pointer transition-colors hover:text-gray-200 text-gray-400"
          title="Toggle Sidebar (Ctrl+B)"
        >
          {sidebarOpen ? "◀" : "▶"}
        </button>
        <button
          onClick={() => setActivePanel("editor")}
          className={`px-3 py-1.5 border-r border-gray-700 cursor-pointer transition-colors ${
            activePanel === "editor" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Editor
        </button>
        <button
          onClick={() => setActivePanel("graph")}
          className={`px-3 py-1.5 border-r border-gray-700 cursor-pointer transition-colors ${
            activePanel === "graph" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Graph
        </button>
        <button
          onClick={() => setActivePanel("split")}
          className={`px-3 py-1.5 cursor-pointer transition-colors ${
            activePanel === "split" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Split
        </button>
      </div>

      {/* Definition Popup */}
      {defPopup && (
        <DefinitionPopup
          word={defPopup.word}
          position={{ x: defPopup.x, y: defPopup.y }}
          onClose={() => setDefPopup(null)}
        />
      )}

      {/* Body: sidebar + main content (flex-row) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar (left) */}
        {sidebarOpen && (
          <div className="w-60 flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
            <Sidebar
              folderRoot={folderRoot}
              folderEntries={folderEntries}
              onFolderChange={(root, entries) => { setFolderRoot(root); setFolderEntries(entries); }}
              onFileOpen={handleFileOpen}
            />
          </div>
        )}

        {/* Main content (right) */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab bar (only in editor/split modes) */}
          {(activePanel === "editor" || activePanel === "split") && <TabBar />}

          {/* Outline + editor/graph side by side */}
          <div className="flex-1 flex overflow-hidden">
            {(activePanel === "editor" || activePanel === "split") && hasOutline && (
              <div className="w-48 flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
                <OutlinePanel />
              </div>
            )}
            {(activePanel === "editor" || activePanel === "split") && (
              <div
                className={`overflow-hidden ${
                  activePanel === "split" ? "w-1/2 border-r border-gray-700" : "flex-1"
                }`}
              >
                <EditorPanel onCtrlClick={(word, x, y) => setDefPopup({ word, x, y })} />
              </div>
            )}
            {(activePanel === "graph" || activePanel === "split") && (
              <div
                className={`overflow-hidden ${
                  activePanel === "split" ? "w-1/2" : "flex-1"
                }`}
              >
                <GraphPanel />
              </div>
            )}
          </div>
        </div>
      </div>

      <StatusBar />
    </div>
  );
}

export default App;
