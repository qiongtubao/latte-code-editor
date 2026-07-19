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
import { ChatAgentPanel } from "./components/ChatAgentPanel";
import { openFile } from "./api/commands";
import { graphSearch, graphResolveCall } from "./api/graphCommands";
import { screenshotWindow, copyScreenshotToClipboard } from "./api/screenshot";
import { useEditorStore } from "./hooks/useEditorStore";
import { useGraphStore } from "./hooks/useGraphStore";
import { useWorkspaceStore } from "./hooks/useWorkspaceStore";
import { useQuickOpenStore } from "./hooks/useQuickOpenStore";
import { useGraphEvents } from "./hooks/useGraphEvents";
import { useLspStore } from "./hooks/useLspStore";
import { LspManagerPanel } from "./components/LspManagerPanel";
import { DebugBar } from "./components/DebugBar";
import { DebugEventInjectModal } from "./components/DebugEventInjectModal";
import { useDebugStore } from "./utils/debug/store";
import { replayLastAction } from "./utils/debug/inject";
import { invoke } from "./api/ipcDebug";
import * as chatBridge from "./chatBridge";
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
  const [chatOpen, setChatOpen] = useState(false);
  const hydrateDebug = useDebugStore((s) => s.hydrate);
  const setDebugOn = useDebugStore((s) => s.setOn);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRRef = useRef(0);
  const lastSRef = useRef(0);
  const { openFileOrSwitch, filePath } = useEditorStore();
  const { graphData } = useGraphStore();
  const activeMeta = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? s.workspaces[s.activeWorkspaceId] : null,
  );
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openQuickOpen = useQuickOpenStore((s) => s.openModal);
  const [defPopup, setDefPopup] = useState<{ word: string; x: number; y: number; filePath?: string } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  // Auto-dismiss toast after 4s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    hydrateDebug();
  }, [hydrateDebug]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (activeId) useGraphStore.getState().requestReload();
  }, [activeId]);
  const handleShowInGraph = useCallback(async (word: string) => {
    try {
      const resp = await graphSearch(word);
      const node = resp.nodes.find((n) => n.kind !== "file" && n.kind !== "import");
      if (node) {
        window.dispatchEvent(new CustomEvent("graph-show-node", { detail: { nodeId: node.id } }));
        setActivePanel("split");
      }
    } catch (e) {
      console.error("Show in graph failed:", e);
    }
  }, []);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") setToast(detail);
    };
    window.addEventListener("latte-toast", handler);
    return () => window.removeEventListener("latte-toast", handler);
  }, []);

  // editor → chat 反向注入（阶段 3b，design §5.4）：选区/图谱节点/文件树
  // dispatch "ask-agent" → 引用打进 chat 输入框（面板未就绪则由
  // chatBridge 缓冲，register 时 flush）并展开面板。只插入不发送。
  useEffect(() => {
    const handler = (e: Event) => {
      const ref = (e as CustomEvent<chatBridge.ContextRef>).detail;
      if (!ref || typeof ref.path !== "string") return;
      chatBridge.insertContext(ref);
      setChatOpen(true);
      chatBridge.focus();
    };
    window.addEventListener("ask-agent", handler);
    return () => window.removeEventListener("ask-agent", handler);
  }, []);

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

  // Listen for doc-navigate events (DocViewer flow diagram → code jump)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { file: string; line: number } | undefined;
      if (!detail?.file) return;
      const absPath = folderRoot ? `${folderRoot}/${detail.file}` : detail.file;
      handleFileOpen(absPath).catch(console.error);
    };
    window.addEventListener("doc-navigate", handler);
    return () => window.removeEventListener("doc-navigate", handler);
  }, [folderRoot, handleFileOpen]);

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
        window.dispatchEvent(new CustomEvent("focus-search"));
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        const next = !useDebugStore.getState().isOn;
        setDebugOn(next);
        const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
        if (next && env?.DEV === true) {
          // Dev convenience: expose the store on window so F12 console can
          // call __latteDebug.getState().xxx without ESM scoping.
          (window as unknown as { __latteDebug?: unknown }).__latteDebug = useDebugStore;
        }
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "R" || e.key === "r")) {
        if (!useDebugStore.getState().isOn) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastRRef.current < 250) return;
        lastRRef.current = now;
        replayLastAction();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "S" || e.key === "s")) {
        // Screenshot the main window to ~/Pictures/latte-screenshots/ + clipboard
        e.preventDefault();
        screenshotWindow()
          .then(async (r) => {
            const copied = await copyScreenshotToClipboard(r);
            setToast(copied ? `Screenshot copied to clipboard! (${r.path})` : `Screenshot saved: ${r.path}`);
          })
          .catch((err) => setToast(`Screenshot failed: ${String(err)}`));
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.shiftKey && (e.key === "S" || e.key === "s")) {
        // Debug snapshot (dumps store state to console) — moved to Ctrl+Alt+Shift+S
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
        const s = useLspStore.getState();
        console.info(
          "latte:debug-snapshot-lsp",
          JSON.stringify(
            { status: s.status, settings: s.settings, error: s.error },
            null,
            2,
          ),
        );
        invoke<unknown>("debug_dump_backend_state")
          .then((b) =>
            console.info("latte:debug-snapshot-backend", JSON.stringify(b, null, 2)),
          )
          .catch((e) => console.error("latte:debug-snapshot-backend-error", String(e)));
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "M" || e.key === "m")) {
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "P" || e.key === "p")) {
        // Reserved for future
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        setChatOpen((v) => !v);
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
        <button
          onClick={() => setChatOpen((v) => !v)}
          className={`px-3 py-1.5 border-l border-gray-700 cursor-pointer transition-colors ${chatOpen ? "bg-[#1e1e1e] text-white" : "text-gray-400 hover:text-gray-200"}`}
          title="Toggle Chat Panel (Ctrl+Shift+L)"
        >
          💬 Chat
        </button>
      </div>
      {defPopup && (
        <DefinitionPopup
          word={defPopup.word}
          callerFile={defPopup.filePath}
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
                style={(activePanel === "split" || chatOpen) ? { flex: editorFlex } : { flex: 1 }}
              >
                <EditorPanel onCtrlClick={async (word, x, y, fp, line) => {
                  // Try direct call resolution via graph edges first
                  if (fp && line != null) {
                    try {
                      const resolved = await graphResolveCall(fp, line);
                      if (resolved) {
                        const file = await openFile(resolved.file_path);
                        useEditorStore.getState().openFileOrSwitch(file, resolved.start_line);
                        return;
                      }
                    } catch { /* fall through to popup */ }
                  }
                  setDefPopup({ word, x, y, filePath: fp ?? undefined });
                }} onShowInGraph={handleShowInGraph} />
              </div>
            )}
            {(activePanel === "split" || (chatOpen && activePanel === "editor")) && (
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
            {(activePanel === "graph" || activePanel === "split") && !chatOpen && (
              <div className="flex-1 overflow-hidden">
                <GraphPanel folderRoot={folderRoot} />
              </div>
            )}
            {chatOpen && (
              /* chat 占满中间行剩余宽度（整行 − 左侧 − 编辑器），
                 边界由上方 editorFlex 分隔条控制，与 GraphPanel 同机制 */
              <div className="flex-1 overflow-hidden border-l border-gray-700">
                <ChatAgentPanel
                  onClose={() => setChatOpen(false)}
                  onShowGraph={() => {
                    // GraphPanel 只在 !chatOpen 时渲染（见上方条件），
                    // 所以"在图谱中显示"需要让出侧栏并切到 split。
                    setChatOpen(false);
                    setActivePanel("split");
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
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
        <DebugEventInjectModal onClose={() => setInjectOpen(false)} />
      )}
      <QuickOpenModal />
      {toast && (
        <div
          onClick={() => setToast(null)}
          className="fixed bottom-12 right-4 z-50 max-w-md px-4 py-2 bg-[#094771] text-blue-100 rounded shadow-lg cursor-pointer text-xs"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
