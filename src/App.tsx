import { useCallback, useEffect, useRef, useState } from "react";
import { EditorPanel } from "./components/EditorPanel";
import { LazyGraphPanel, preloadGraphPanel } from "./components/LazyGraphPanel";
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
import type { GraphRevealRequest } from "./hooks/graphTypes";
import { useWorkspaceStore } from "./hooks/useWorkspaceStore";
import { useQuickOpenStore } from "./hooks/useQuickOpenStore";
import { useGraphEvents } from "./hooks/useGraphEvents";
import { useLspStore } from "./hooks/useLspStore";
// 有意未接入口：LSP 后端目前是占位实现（命令未注册、client 全空转），
// 把管理面板暴露出去只会让用户看到一个持续报错的面板。待 LSP 打通后
// 与 StatusBar / SettingsPanel 同样方式挂上。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { LspManagerPanel } from "./components/LspManagerPanel";
import { DebugBar } from "./components/DebugBar";
import { DebugEventInjectModal } from "./components/DebugEventInjectModal";
import { useDebugStore } from "./utils/debug/store";
import { replayLastAction } from "./utils/debug/inject";
import { invoke } from "./api/ipcDebug";
import { isChord } from "./utils/keyboard";
import * as chatBridge from "./chatBridge";
import { applySkin, SKINS } from "./skins";
import { useSettingsStore } from "./hooks/useSettingsStore";
type ActivePanel = "editor" | "graph" | "split";
function App() {
  // Editor-first is required for a true runtime lazy boundary. Starting in
  // split mode would request the graph chunk during the first render anyway.
  const [activePanel, setActivePanel] = useState<ActivePanel>("editor");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [outlineWidth, setOutlineWidth] = useState(180);
  const [editorFlex, setEditorFlex] = useState(0.5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 与上方 LspManagerPanel 配对，同样待 LSP 打通后启用
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [lspManagerOpen, setLspManagerOpen] = useState(false);
  const [injectOpen, setInjectOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const hydrateDebug = useDebugStore((s) => s.hydrate);
  const setDebugOn = useDebugStore((s) => s.setOn);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRRef = useRef(0);
  const lastSRef = useRef(0);
  const graphRevealSeqRef = useRef(0);
  const [graphRevealRequest, setGraphRevealRequest] = useState<GraphRevealRequest | null>(null);
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

  // 订阅后端 IncrementalHub 发出的 graph-updated:<ws_id> 事件。
  // 此前这个 hook 被 import 了却从未调用，于是 Rust 侧的增量更新事件前端
  // 根本没在听 —— 改文件后图谱不会自动刷新。
  useGraphEvents();

  useEffect(() => {
    hydrateDebug();
  }, [hydrateDebug]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 皮肤应用：挂载时按 persist 恢复的皮肤执行一次，之后跟随设置变化。
  // chrome 变量写到 documentElement（@theme inline 工具类即时跟随），
  // chatVars 经 chatBridge 同源写进 chat iframe（未打开则缓存，register 时补）。
  const skin = useSettingsStore((s) => s.skin);
  useEffect(() => {
    applySkin(skin);
    chatBridge.setSkin(SKINS[skin].chatVars);
  }, [skin]);

  useEffect(() => {
    if (activeId) useGraphStore.getState().requestReload();
  }, [activeId]);
  const revealGraphNode = useCallback((nodeId: string) => {
    graphRevealSeqRef.current += 1;
    setGraphRevealRequest({ nodeId, requestId: graphRevealSeqRef.current });
    setChatOpen(false);
    setActivePanel("split");
  }, []);
  const handleGraphRevealHandled = useCallback((requestId: number) => {
    setGraphRevealRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);

  const handleShowInGraph = useCallback(async (word: string) => {
    try {
      const resp = await graphSearch(word);
      const node = resp.nodes.find((n) => n.kind !== "file" && n.kind !== "import");
      if (node) revealGraphNode(node.id);
    } catch (e) {
      console.error("Show in graph failed:", e);
    }
  }, [revealGraphNode]);
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
      // 所有分支用 isChord 精确匹配修饰键，因此顺序无关、互不抢占。
      if (isChord(e, "b")) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (isChord(e, "p")) {
        e.preventDefault();
        openQuickOpen();
      } else if (isChord(e, "f", { shift: true })) {
        e.preventDefault();
        setSidebarOpen(true);
        window.dispatchEvent(new CustomEvent("focus-search"));
      } else if (isChord(e, "e", { shift: true })) {
        e.preventDefault();
        setSidebarOpen(true);
        window.dispatchEvent(new CustomEvent("focus-explorer"));
      } else if (isChord(e, "d", { shift: true })) {
        e.preventDefault();
        const next = !useDebugStore.getState().isOn;
        setDebugOn(next);
        const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
        if (next && env?.DEV === true) {
          // Dev convenience: expose the store on window so F12 console can
          // call __latteDebug.getState().xxx without ESM scoping.
          (window as unknown as { __latteDebug?: unknown }).__latteDebug = useDebugStore;
        }
      } else if (isChord(e, "r", { shift: true })) {
        if (!useDebugStore.getState().isOn) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastRRef.current < 250) return;
        lastRRef.current = now;
        replayLastAction();
      } else if (isChord(e, "s", { shift: true, alt: true })) {
        // Debug snapshot (dumps store state to console) — Ctrl+Alt+Shift+S.
        // 此前该分支排在 Ctrl+Shift+S 之后且没排除 Alt，被截图分支抢先
        // 匹配，永远进不来。
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
      } else if (isChord(e, "s", { shift: true })) {
        // Screenshot the main window to ~/Pictures/latte-screenshots/ + clipboard
        e.preventDefault();
        screenshotWindow()
          .then(async (r) => {
            const copied = await copyScreenshotToClipboard(r);
            setToast(copied ? `Screenshot copied to clipboard! (${r.path})` : `Screenshot saved: ${r.path}`);
          })
          .catch((err) => setToast(`Screenshot failed: ${String(err)}`));
      } else if (isChord(e, "l", { shift: true })) {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openQuickOpen, setDebugOn]);
  return (
    <div className="flex flex-col h-screen">
      <WorkspaceTabs />

      <div className="flex items-center gap-0 text-xs bg-surface-3 border-b border-edge select-none">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="px-2 py-1.5 border-r border-edge cursor-pointer transition-colors hover:text-fg text-fg-2"
          title="Toggle Sidebar (Ctrl+B)"
        >
          {sidebarOpen ? "◀" : "▶"}
        </button>
        <button
          onClick={() => setActivePanel("editor")}
          className={`px-3 py-1.5 border-r border-edge cursor-pointer transition-colors ${activePanel === "editor" ? "bg-surface text-fg" : "text-fg-2 hover:text-fg"}`}
        >
          Editor
        </button>
        <button
          onMouseEnter={() => void preloadGraphPanel().catch(() => undefined)}
          onFocus={() => void preloadGraphPanel().catch(() => undefined)}
          onClick={() => setActivePanel("graph")}
          className={`px-3 py-1.5 border-r border-edge cursor-pointer transition-colors ${activePanel === "graph" ? "bg-surface text-fg" : "text-fg-2 hover:text-fg"}`}
        >
          Graph
        </button>
        <button
          onMouseEnter={() => void preloadGraphPanel().catch(() => undefined)}
          onFocus={() => void preloadGraphPanel().catch(() => undefined)}
          onClick={() => setActivePanel("split")}
          className={`px-3 py-1.5 cursor-pointer transition-colors ${activePanel === "split" ? "bg-surface text-fg" : "text-fg-2 hover:text-fg"}`}
        >
          Split
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          className={`px-3 py-1.5 border-l border-edge cursor-pointer transition-colors ${chatOpen ? "bg-surface text-fg" : "text-fg-2 hover:text-fg"}`}
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
              className="flex-shrink-0 border-r border-edge overflow-hidden flex flex-col"
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
                  className="flex-shrink-0 border-r border-edge overflow-hidden flex flex-col"
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
                className={`overflow-hidden ${activePanel === "split" ? "border-r border-edge" : ""}`}
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
                className="flex-shrink-0 w-[3px] cursor-col-resize hover:bg-accent bg-edge z-10 transition-colors"
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
                <LazyGraphPanel
                  folderRoot={folderRoot}
                  revealRequest={graphRevealRequest}
                  onRevealHandled={handleGraphRevealHandled}
                />
              </div>
            )}
            {chatOpen && (
              /* chat 占满中间行剩余宽度（整行 − 左侧 − 编辑器），
                 边界由上方 editorFlex 分隔条控制，与 GraphPanel 同机制 */
              <div className="flex-1 overflow-hidden border-l border-edge">
                <ChatAgentPanel
                  onClose={() => setChatOpen(false)}
                  onShowGraph={revealGraphNode}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 状态栏：此前 import 了却从未渲染，导致它自带的设置入口
          （onToggleSettings）连同 settingsOpen state 一起成了死代码，
          设置界面因此完全无法打开。 */}
      <StatusBar onToggleSettings={() => setSettingsOpen((v) => !v)} />
      {settingsOpen && (
        <div className="fixed inset-y-0 right-0 z-40 w-[360px] border-l border-edge shadow-lg">
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        </div>
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
        <DebugEventInjectModal onClose={() => setInjectOpen(false)} />
      )}
      <QuickOpenModal />
      {toast && (
        <div
          onClick={() => setToast(null)}
          className="fixed bottom-12 right-4 z-50 max-w-md px-4 py-2 bg-info text-accent-2 rounded shadow-lg cursor-pointer text-xs"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
