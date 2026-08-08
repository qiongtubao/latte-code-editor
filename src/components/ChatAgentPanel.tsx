// ChatAgentPanel — 嵌入式 agent chat UI 的 iframe 宿主（阶段 2：同源 + IPC）。
//
// 设计：latte-rs-agents/docs/ui-embedding-design.md §1/§3/§5。
// - iframe 指同源 `/chat-ui/index.html`（dev：vite public/chat-ui；
//   prod：tauri 协议 dist/chat-ui；UI dist 用相对 base "./" 构建），
//   不再走内嵌 HTTP server；
// - 传输层（契约 C1）：同源直注入 `contentWindow.__LATTE_HOST__ =
//   { platform, transport, sessionKey, workspaceRoot, openLocation,
//   revealInGraph }` + "latte-host-ready" 事件（host.ts 通道 1/2），
//   UI 的 waitForHost 拾取后 initTransport(transport)，api.ts 全部
//   调用落进 src-tauri `ui_*` 命令 + `ui:chat_event` 事件；
//   函数引用无法过 postMessage，直注入是 transport 的唯一通道；
// - 宿主能力（openLocation/revealInGraph）也随 host 直传（C3），
//   不再走 postMessage "latte:init"/"latte:call"（那是跨源时代的通道）；
// - 反向调用（editor → chat，阶段 3b）维持 chatBridge postMessage
//   （"latte:ui-call"，同源可用）；
// - 工作区切换：root 变化 → iframe key 变化 → React 重挂 iframe →
//   onLoad 重新注入（sessionKey/workspaceRoot 按当前工作区取值）；
//   后端按 workspaceRoot 各自 get-or-spawn UiBackend，chat 状态隔离。
import { useCallback, useEffect, useRef } from "react";
import { openFile } from "../api/commands";
import { graphGetData } from "../api/graphCommands";
import { createUiTransport } from "../api/uiTransport";
import type { GraphData, GraphNode } from "../hooks/graphTypes";
import { useEditorStore } from "../hooks/useEditorStore";
import { useGraphStore } from "../hooks/useGraphStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import * as chatBridge from "../chatBridge";

/** 契约 C3（host.ts CodeRef）：UI → 宿主的代码引用。path 相对工作区根。 */
interface CodeRef {
  path: string;
  startLine?: number;
  endLine?: number;
  column?: number;
  symbol?: string;
}

/** transport 无内部状态（workspaceRoot 每次调用现取），进程级单例即可。 */
const transport = createUiTransport();

function currentWorkspaceRoot(): string | null {
  const ws = useWorkspaceStore.getState();
  const id = ws.activeWorkspaceId;
  return (id && ws.workspaces[id]?.project_root) || null;
}

/** CodeRef.path（相对工作区根）→ 编辑器/图谱使用的绝对路径。 */
function resolveWorkspacePath(path: string, root: string | null): string {
  if (!root) return path;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/**
 * 在图谱节点中定位 CodeRef：symbol 精确/尾段匹配 → 行号区间最小包含 →
 * 文件节点兜底。图谱节点的 file_path 是绝对路径（同编辑器 openFile 结果）。
 */
function findGraphNode(data: GraphData, absPath: string, ref: CodeRef): GraphNode | null {
  const inFile = data.nodes.filter((n) => n.file_path === absPath);
  if (ref.symbol) {
    const sym = ref.symbol;
    const bySymbol =
      inFile.find((n) => n.qualified_name === sym || n.name === sym) ??
      data.nodes.find((n) => n.qualified_name === sym || n.name === sym) ??
      inFile.find((n) => n.qualified_name.endsWith(`::${sym}`)) ??
      data.nodes.find((n) => n.qualified_name.endsWith(`::${sym}`));
    if (bySymbol) return bySymbol;
  }
  if (ref.startLine != null) {
    const line = ref.startLine;
    const spanning = inFile
      .filter((n) => n.kind !== "file" && n.start_line <= line && line <= n.end_line)
      .sort(
        (a, b) => a.end_line - a.start_line - (b.end_line - b.start_line),
      );
    if (spanning[0]) return spanning[0];
  }
  return inFile.find((n) => n.kind === "file") ?? inFile[0] ?? null;
}

interface Props {
  onClose: () => void;
  /** 打开图谱面板（App 侧切 panel；GraphPanel 只在 chat 关闭时渲染）。 */
  onShowGraph: () => void;
}

export function ChatAgentPanel({ onClose, onShowGraph }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 跟随活动工作区（无工作区 → null → 后端 default 容器）。
  // root 是 iframe 的 key：变了 React 重挂 iframe → onLoad 重新注入。
  const workspaceRoot = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? (s.workspaces[s.activeWorkspaceId]?.project_root ?? null) : null,
  );

  const openLocation = useCallback(async (ref: CodeRef) => {
    try {
      const abs = resolveWorkspacePath(ref.path, currentWorkspaceRoot());
      const file = await openFile(abs);
      const editor = useEditorStore.getState();
      editor.openFileOrSwitch(file, ref.startLine ?? null);
      editor.setTargetLine(ref.startLine ?? null, ref.column ?? null);
    } catch (e) {
      console.warn("[ChatAgentPanel] openLocation failed:", e);
    }
  }, []);

  const revealInGraph = useCallback(
    async (ref: CodeRef) => {
      try {
        const abs = resolveWorkspacePath(ref.path, currentWorkspaceRoot());
        const graph = useGraphStore.getState();
        const data = graph.graphData ?? (await graphGetData()).data;
        if (!graph.graphData) graph.setGraphData(data);
        const node = findGraphNode(data, abs, ref);
        if (!node) {
          console.warn("[ChatAgentPanel] revealInGraph: no node for", ref);
          return;
        }
        graph.setSelectedNode(node.id);
        graph.setHighlightedNodes(new Set([node.id]));
        onShowGraph();
        // App.tsx "Show in Graph" 同款定位事件。GraphPanel 此刻才挂载，
        // 延后一个 macrotask 等它 commit 完再发，保证 listener 已装上。
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("graph-show-node", { detail: { nodeId: node.id } }),
          );
        }, 0);
      } catch (e) {
        console.warn("[ChatAgentPanel] revealInGraph failed:", e);
      }
    },
    [onShowGraph],
  );

  // iframe load 后同源直注入 host（C3 握手，host.ts 通道 1/2）：
  // 写 __LATTE_HOST__ → dispatch "latte-host-ready"。UI 的 waitForHost
  // （≤250ms 窗口）拾取；注入取"当前"工作区，重载后随 load 重发最新值。
  const handleLoad = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const ws = useWorkspaceStore.getState();
    const wsId = ws.activeWorkspaceId;
    const root = (wsId && ws.workspaces[wsId]?.project_root) || undefined;
    (win as unknown as { __LATTE_HOST__?: unknown }).__LATTE_HOST__ = {
      platform: "tauri",
      transport,
      ...(wsId ? { sessionKey: `latte:session:${wsId}` } : {}),
      ...(root ? { workspaceRoot: root } : {}),
      openLocation: (ref: CodeRef) => {
        void openLocation(ref);
      },
      revealInGraph: (ref: CodeRef) => {
        void revealInGraph(ref);
      },
    };
    win.dispatchEvent(new Event("latte-host-ready"));
    // 反向调用通道（editor → chat，阶段 3b）：同源 origin。
    chatBridge.register(win, window.location.origin);
  }, [openLocation, revealInGraph]);

  // iframe 重载（切工作区）/组件卸载时注销反向通道，回到缓冲态。
  useEffect(() => {
    return () => chatBridge.unregister(window.location.origin);
  }, [workspaceRoot]);

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-2 border-b border-edge select-none">
        <span className="text-xs text-fg">Agent</span>
        <button
          onClick={onClose}
          className="px-1 text-xs text-fg-2 cursor-pointer transition-colors hover:text-fg"
          title="Close Chat (Ctrl+Shift+L)"
        >
          ✕
        </button>
      </div>
      <iframe
        ref={iframeRef}
        key={workspaceRoot ?? "default"}
        src="/chat-ui/index.html"
        onLoad={handleLoad}
        className="flex-1 w-full border-0"
        title="Latte Agent"
      />
    </div>
  );
}
