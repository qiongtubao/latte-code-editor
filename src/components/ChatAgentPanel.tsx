// ChatAgentPanel — 嵌入式 agent chat UI 的 iframe 宿主（按工作区多实例）。
//
// 设计：latte-rs-agents/docs/ui-embedding-design.md §1/§5。
// - src-tauri 按工作区内嵌 latte-agent-ui-server（127.0.0.1 随机端口，
//   cwd=工作区根；无工作区时走 default server，cwd=app_data_dir），
//   本组件按当前工作区 invoke `chat_ui_url` get-or-spawn 拿 base URL；
// - 切换工作区 → URL 变化 → iframe 因 key 重载 → handleLoad 重发
//   init（各工作区的 chat 状态在各自 server 上保留，可切回）；
// - iframe 内 UI 与 server 同源，REST/SSE 直连，前端零改动；
// - 宿主桥走 postMessage（契约 C3）：
//     父 → iframe: "latte:init"（iframe load 后注入 host 能力声明）
//     iframe → 父: "latte:call"（openLocation / revealInGraph / openDoc）
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openFile } from "../api/commands";
import { graphGetData } from "../api/graphCommands";
import type { GraphData, GraphNode } from "../hooks/graphTypes";
import { useEditorStore } from "../hooks/useEditorStore";
import { useGraphStore } from "../hooks/useGraphStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";

/** 契约 C3（design §5.1）：UI → 宿主的代码引用。path 相对工作区根。 */
interface CodeRef {
  path: string;
  startLine?: number;
  endLine?: number;
  column?: number;
  symbol?: string;
}

/** UI 侧发来的调用消息（design §5：window "message" 事件载荷）。 */
interface HostCallMessage {
  type: "latte:call";
  method: "openLocation" | "revealInGraph" | "openDoc";
  args: [CodeRef];
}

/** 本宿主声明支持的能力子集（openDoc 留给阶段 3c）。 */
const HOST_CAPABILITIES = ["openLocation", "revealInGraph"];

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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 跟随活动工作区（无工作区 → null → default server）。
  const workspaceRoot = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? (s.workspaces[s.activeWorkspaceId]?.project_root ?? null) : null,
  );

  // 按工作区 get-or-spawn 对应 server：root 变化 → 重新取 URL（变了
  // iframe 因 key 自动重载，handleLoad 重发 init；没变则不动，chat
  // 状态保留）。快速连切时 cleanup 丢弃过期结果。
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    invoke<string>("chat_ui_url", { workspaceRoot })
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  const origin = url ? new URL(url).origin : null;

  // iframe load 后注入 host（契约 C3 握手）。init 取"当前"工作区：
  // 切工作区后 URL 变化 → iframe 重载 → 这里随 load 重发最新值；
  // sessionKey/workspaceRoot 按当前工作区派生，无需额外跟随逻辑。
  const handleLoad = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !origin) return;
    const ws = useWorkspaceStore.getState();
    const wsId = ws.activeWorkspaceId;
    const root = (wsId && ws.workspaces[wsId]?.project_root) || undefined;
    win.postMessage(
      {
        type: "latte:init",
        host: {
          platform: "tauri",
          capabilities: HOST_CAPABILITIES,
          ...(wsId ? { sessionKey: `latte:session:${wsId}` } : {}),
          ...(root ? { workspaceRoot: root } : {}),
        },
      },
      origin,
    );
  }, [origin]);

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

  // UI → 宿主调用桥：校验 origin 后分派（契约 C3 的安全要求）。
  useEffect(() => {
    if (!origin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const data = e.data as Partial<HostCallMessage> | undefined;
      if (!data || data.type !== "latte:call") return;
      const ref = data.args?.[0];
      if (!ref || typeof ref.path !== "string") return;
      switch (data.method) {
        case "openLocation":
          void openLocation(ref);
          break;
        case "revealInGraph":
          void revealInGraph(ref);
          break;
        default:
          // openDoc 未在 capabilities 里声明，UI 不应发来；忽略。
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, openLocation, revealInGraph]);

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#252526] border-b border-gray-700 select-none">
        <span className="text-xs text-gray-300">Agent</span>
        <button
          onClick={onClose}
          className="px-1 text-xs text-gray-400 cursor-pointer transition-colors hover:text-gray-200"
          title="Close Chat (Ctrl+Shift+L)"
        >
          ✕
        </button>
      </div>
      {error ? (
        <div className="flex-1 flex items-center justify-center px-4 text-center text-xs text-red-400">
          {error}
        </div>
      ) : url ? (
        <iframe
          ref={iframeRef}
          key={url}
          src={url}
          onLoad={handleLoad}
          className="flex-1 w-full border-0"
          title="Latte Agent"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-xs text-gray-500">
          Starting agent UI…
        </div>
      )}
    </div>
  );
}
