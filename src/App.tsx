import { useCallback, useEffect, useRef, useState } from "react";
import { EditorPanel } from "./components/EditorPanel";
import { GraphPanel } from "./components/GraphPanel";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { OutlinePanel } from "./components/OutlinePanel";
import { ResizeDivider } from "./components/ResizeDivider";
import { StatusBar } from "./components/StatusBar";
import { DefinitionPopup } from "./components/DefinitionPopup";
import { SettingsPanel } from "./components/SettingsPanel";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { QuickOpenModal } from "./components/QuickOpenModal";
import { openFile } from "./api/commands";
import { useEditorStore } from "./hooks/useEditorStore";
import { useGraphStore } from "./hooks/useGraphStore";
import { useWorkspaceStore } from "./hooks/useWorkspaceStore";
import { useQuickOpenStore } from "./hooks/useQuickOpenStore";
import { useGraphEvents } from "./hooks/useGraphEvents";
import { LspManagerPanel } from "./components/LspManagerPanel";
import { DebugBar } from "./components/DebugBar";
import { useDebugStore } from "./utils/debug/store";
import { invoke } from "./api/ipcDebug";
type ActivePanel = "editor" | "graph" | "split";
function App() {
  const [activePanel, setActivePanel] = useState<ActivePanel>("split");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [outlineWidth, setOutlineWidth] = useState(180);
  const [editorFlex, setEditorFlex] = useState(0.5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lspManagerOpen, setLspManagerOpen] = useState(false);
  const [injectOpen, setInjectOpen] = useState(false);
  const hydrateDebug = useDebugStore((s) => s.hydrate);
  const setDebugOn = useDebugStore((s) => s.setOn);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRRef = useRef(0);
  const lastSRef = useRef(0);
  const { openFileOrSwitch } = useEditorStore();
  const { filePath } = useEditorStore();
  const { graphData } = useGraphStore();
  const activeMeta = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? s.workspaces[s.activeWorkspaceId] : null,
  );
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openQuickOpen = useQuickOpenStore((s) => s.openModal);
  const [defPopup, setDefPopup] = useState<{ word: string; x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    hydrateDebug();
  }, [hydrateDebug]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (activeId) useGraphStore.getState().requestReload();
  }, [activeId]);

  const folderRoot = activeMeta?.project_root ?? null;
  const hasOutline = !!(
    filePath &&
    graphData?.nodes.some((n) => n.file_path === filePath && n.kind !== "file")
  );

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
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        openQuickOpen();
      } else if (e.ctrlKey && e.shiftKey && e.key === "f") {
        e.preventDefault();
        setSidebarOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setDebugOn(!useDebugStore.getState().isOn);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "R" || e.key === "r")) {
        if (!useDebugStore.getState().isOn) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastRRef.current < 250) return;
        lastRRef.current = now;
        void import("./utils/debug/inject").then((m) => m.replayLastAction());
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "S" || e.key === "s")) {
        if (!useDebugStore.getState().isOn) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastSRef.current < 250) return;
        lastSRef.current = now;
        const snap = {
          ts: new Date().toISOString(),
          stores: {
            editor: useEditorStore.getState(),
            workspace: useWorkspaceStore.getState(),
            graph: useGraphStore.getState(),
            lsp: null, // require()d lazily to avoid circular import
          },
        };
        console.info("latte:debug-snapshot", JSON.stringify(snap, null, 2));
        import("./hooks/useLspStore").then(({ useLspStore }) => {
          const s = useLspStore.getState();
          console.info(
            "latte:debug-snapshot-lsp",
            JSON.stringify(
              { status: s.status, settings: s.settings, error: s.error },
              null,
              2,
            ),
          );
        });
        invoke<unknown>("debug_dump_backend_state")
          .then((b) =>
            console.info("latte:debug-snapshot-backend", JSON.stringify(b, null, 2)),
          )
          .catch((e) => console.error("latte:debug-snapshot-backend-error", String(e)));
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "M" || e.key === "m")) {
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openQuickOpen]);

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceTabs />

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
          className={`px-3 py-1.5 border-r border-gray-700 cursor-pointer transition-colors ${activePanel === "editor" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}
        >
          Editor
        </button>
        <button
          onClick={() => setActivePanel("graph")}
          className={`px-3 py-1.5 border-r border-gray-700 cursor-pointer transition-colors ${activePanel === "graph" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}
        >
          Graph
        </button>
        <button
          onClick={() => setActivePanel("split")}
          className={`px-3 py-1.5 cursor-pointer transition-colors ${activePanel === "split" ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}
        >
          Split
        </button>
      </div>

      {defPopup && (
        <DefinitionPopup
          word={defPopup.word}
          position={{ x: defPopup.x, y: defPopup.y }}
          onClose={() => setDefPopup(null)}
        />
      )}

      <div className="flex-1 flex overflow-hidden">
        {sidebarOpen && (
          <>
            <div
              className="flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col"
              style={{ width: sidebarWidth }}
            >
              <Sidebar folderRoot={folderRoot} onFileOpen={handleFileOpen} />
            </div>
            <ResizeDivider
              size={sidebarWidth}
              onResize={setSidebarWidth}
              minSize={150}
              maxSize={600}
            />
          </>
        )}

        <div className="flex-1 flex flex-col overflow-hidden">
          {(activePanel === "editor" || activePanel === "split") && <TabBar />}

          <div ref={containerRef} className="flex-1 flex overflow-hidden">
            {(activePanel === "editor" || activePanel === "split") && hasOutline && (
              <>
                <div
                  className="flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col"
                  style={{ width: outlineWidth }}
                >
                  <OutlinePanel />
                </div>
                <ResizeDivider
                  size={outlineWidth}
                  onResize={setOutlineWidth}
                  minSize={100}
                  maxSize={400}
                />
              </>
            )}
            {(activePanel === "editor" || activePanel === "split") && (
              <div
                className={`overflow-hidden ${activePanel === "split" ? "border-r border-gray-700" : ""}`}
                style={activePanel === "split" ? { flex: editorFlex } : { flex: 1 }}
              >
                <EditorPanel onCtrlClick={(word, x, y) => setDefPopup({ word, x, y })} />
              </div>
            )}
            {activePanel === "split" && (
              <div
                className="flex-shrink-0 w-[3px] cursor-col-resize hover:bg-[#007acc] bg-[#333] z-10 transition-colors"
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
                  const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              />
            )}

            {(activePanel === "graph" || activePanel === "split") && (
              <div className="flex-1 overflow-hidden">
                <GraphPanel />
              </div>
            )}
          </div>
        </div>
      </div>

      <QuickOpenModal />
      {settingsOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSettingsOpen(false)}>
          <div
            className="w-96 max-h-[80vh] overflow-hidden rounded shadow-2xl border border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </div>
        </div>
      )}
      {lspManagerOpen && (
        <LspManagerPanel onClose={() => setLspManagerOpen(false)} />
      )}
      <DebugBar
        onOpenInject={() => setInjectOpen(true)}
        onSnapshot={async () => {
          try {
            const snap = await invoke<unknown>("debug_dump_backend_state");
            console.info("latte:debug-snapshot", JSON.stringify(snap, null, 2));
          } catch (e) {
            console.error("latte:debug-snapshot-error", String(e));
          }
        }}
      />
      {injectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setInjectOpen(false)}
        >
          <div
            className="bg-white text-black rounded p-4 w-[520px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-bold mb-2">Inject (stub — wired in Phase 4)</h3>
            <p className="text-sm">Event-inject modal will land in Phase 4.</p>
            <button
              onClick={() => setInjectOpen(false)}
              className="mt-2 px-3 py-1 bg-gray-200 rounded"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
