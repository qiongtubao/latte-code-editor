import { useCallback, useEffect, useRef, useState } from "react";
import { EditorPanel } from "./components/EditorPanel";
import { GraphPanel } from "./components/GraphPanel";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { OutlinePanel } from "./components/OutlinePanel";
import { ResizeDivider } from "./components/ResizeDivider";
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
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [outlineWidth, setOutlineWidth] = useState(180);
  const [editorFlex, setEditorFlex] = useState(0.5);
  const containerRef = useRef<HTMLDivElement>(null);
  const { openFileOrSwitch } = useEditorStore();
  const { cursorWord, filePath } = useEditorStore();
  const { graphData } = useGraphStore();
  const [defPopup, setDefPopup] = useState<{ word: string; x: number; y: number } | null>(null);
  const [folderRoot, setFolderRoot] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FsEntry[]>([]);

  const hasOutline = !!(filePath && graphData?.nodes.some((n) => n.file_path === filePath && n.kind !== "file"));

  const handleFileOpen = useCallback(async (path: string) => {
    try {
      const result = await openFile(path);
      openFileOrSwitch(result);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }, [openFileOrSwitch]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b") {
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
        <button onClick={() => setSidebarOpen((v) => !v)}
          className="px-2 py-1.5 border-r border-gray-700 cursor-pointer transition-colors hover:text-gray-200 text-gray-400"
          title="Toggle Sidebar (Ctrl+B)">{sidebarOpen ? "◀" : "▶"}</button>
        <button onClick={() => setActivePanel("editor")}
          className={`px-3 py-1.5 border-r border-gray-700 cursor-pointer transition-colors ${activePanel === "editor" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}>Editor</button>
        <button onClick={() => setActivePanel("graph")}
          className={`px-3 py-1.5 border-r border-gray-700 cursor-pointer transition-colors ${activePanel === "graph" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}>Graph</button>
        <button onClick={() => setActivePanel("split")}
          className={`px-3 py-1.5 cursor-pointer transition-colors ${activePanel === "split" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}>Split</button>
      </div>

      {/* Definition Popup */}
      {defPopup && (
        <DefinitionPopup word={defPopup.word} position={{ x: defPopup.x, y: defPopup.y }} onClose={() => setDefPopup(null)} />
      )}

      {/* Body: sidebar + main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <>
            <div className="flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col" style={{ width: sidebarWidth }}>
              <Sidebar folderRoot={folderRoot} folderEntries={folderEntries}
                onFolderChange={(r, e) => { setFolderRoot(r); setFolderEntries(e); }} onFileOpen={handleFileOpen} />
            </div>
            <ResizeDivider size={sidebarWidth} onResize={setSidebarWidth} minSize={150} maxSize={600} />
          </>
        )}

        {/* Main content (right) */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {(activePanel === "editor" || activePanel === "split") && <TabBar />}

          {/* Outline + editor/graph */}
          <div ref={containerRef} className="flex-1 flex overflow-hidden">
            {(activePanel === "editor" || activePanel === "split") && hasOutline && (
              <>
                <div className="flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col" style={{ width: outlineWidth }}>
                  <OutlinePanel />
                </div>
                <ResizeDivider size={outlineWidth} onResize={setOutlineWidth} minSize={100} maxSize={400} />
              </>
            )}
            {(activePanel === "editor" || activePanel === "split") && (
              <div className={`overflow-hidden ${activePanel === "split" ? "border-r border-gray-700" : ""}`}
                style={activePanel === "split" ? { flex: editorFlex } : { flex: 1 }}>
                <EditorPanel onCtrlClick={(word, x, y) => setDefPopup({ word, x, y })} />
              </div>
            )}
            {activePanel === "split" && (
              <div className="flex-shrink-0 w-[3px] cursor-col-resize hover:bg-[#007acc] bg-[#333] z-10 transition-colors"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startFlex = editorFlex;
                  const onMove = (ev: MouseEvent) => {
                    const dx = ev.clientX - startX;
                    const total = containerRef.current?.clientWidth ?? 800;
                    const newFlex = Math.max(0.2, Math.min(0.8, startFlex + dx / total));
                    setEditorFlex(newFlex);
                  };
                  const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }} />
            )}

            {(activePanel === "graph" || activePanel === "split") && (
              <div className="flex-1 overflow-hidden">
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
