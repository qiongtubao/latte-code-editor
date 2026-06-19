import { useMemo } from "react";
import { markdownToHtml } from "../utils/markdown";
import { useChatStore } from "../hooks/useChatStore";
import type { ChatMessage } from "../hooks/useChatStore";

interface Props {
  messages: ChatMessage[];
  status: "idle" | "running" | "completed" | "error";
  onFileClick: (path: string) => void;
}

const FILE_EDIT_RE = /<file_edit\s+path="([^"]+)">([^<]*)<\/file_edit>/g;

function renderContentWithFileLinks(
  text: string,
  onFileClick: (p: string) => void,
): React.ReactNode {
  const html = markdownToHtml(text);
  const files: { path: string; desc: string }[] = [];
  let m: RegExpExecArray | null;
  FILE_EDIT_RE.lastIndex = 0;
  while ((m = FILE_EDIT_RE.exec(text)) !== null) {
    files.push({ path: m[1], desc: m[2] });
  }
  return (
    <>
      <div
        className="chat-markdown text-sm"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {files.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {files.map((f, i) => (
            <button
              key={i}
              onClick={() => onFileClick(f.path)}
              className="flex items-center gap-2 text-xs px-2 py-1 bg-[#094771] hover:bg-[#0d5a8a] text-blue-100 rounded text-left"
            >
              <span>📝</span>
              <span className="font-mono">{f.path}</span>
              {f.desc && <span className="text-blue-200 opacity-80 truncate">— {f.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * A small round avatar showing the role's emoji. Wrapped so the bubble
 * is centered vertically against multi-line content.
 */
function Avatar({ emoji, tone }: { emoji: string; tone: "user" | "agent" | "error" }) {
  const toneClass =
    tone === "user"
      ? "bg-[#094771] text-blue-100"
      : tone === "error"
        ? "bg-red-900/60 text-red-100"
        : "bg-[#2a2a2a] text-gray-200";
  return (
    <div
      className={
        "shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-base " +
        toneClass
      }
    >
      {emoji || "💬"}
    </div>
  );
}

/**
 * Detect preflight / orchestrator error turns. The backend uses a
 * `__preflight_error__` step id prefix for per-role API-key failures,
 * and the response text starts with `⚠️`. Either signal is enough.
 */
function isErrorMessage(m: ChatMessage): boolean {
  const idTag = (m as unknown as { stepId?: string }).stepId ?? "";
  return (
    idTag.startsWith("__preflight_error__") || m.content.startsWith("⚠️")
  );
}

export function MessageList({ messages, status, onFileClick }: Props) {
  const errorMessage = useChatStore((s) => s.errorMessage);
  const lastUserTopic = useChatStore((s) => s.lastUserTopic);
  const retryLastDiscussion = useChatStore((s) => s.retryLastDiscussion);
  const list = useMemo(() => messages, [messages]);

  // When the most recent message is an error turn, expose a single
  // retry CTA at the bottom of the list. The error bubbles themselves
  // stay inline so the user can read which role failed.
  const lastIsError =
    list.length > 0 && isErrorMessage(list[list.length - 1]) && !!lastUserTopic;

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
      {list.length === 0 && (
        <div className="text-gray-500 text-sm italic mt-8 text-center">
          Start a discussion by typing a topic below.
        </div>
      )}
      {list.map((m) => {
        if (m.role === "user") {
          return (
            <div key={m.id} className="flex justify-end gap-2 items-start">
              <div className="max-w-[85%] px-3 py-2 bg-[#094771] text-blue-100 rounded text-sm whitespace-pre-wrap">
                {m.content}
              </div>
              <Avatar emoji="👤" tone="user" />
            </div>
          );
        }
        const error = isErrorMessage(m);
        const tone = error ? "error" : "agent";
        return (
          <div key={m.id} className="flex gap-2 items-start">
            <Avatar emoji={m.agentIcon ?? "💬"} tone={tone} />
            <div className="flex-1 min-w-0 space-y-1">
              <div
                className={
                  "flex items-center gap-2 text-xs " +
                  (error ? "text-red-300" : "text-gray-400")
                }
              >
                <span className="font-semibold">
                  {m.agentName ?? "agent"}
                </span>
                {error && (
                  <span className="px-1.5 py-0.5 rounded bg-red-900/50 text-[10px] uppercase tracking-wide">
                    错误
                  </span>
                )}
              </div>
              <div
                className={
                  "rounded p-3 text-sm whitespace-pre-wrap " +
                  (error
                    ? "bg-red-950/40 border border-red-800/60 text-red-100"
                    : "bg-[#2a2a2a] text-gray-200")
                }
              >
                {error ? (
                  <pre className="font-sans whitespace-pre-wrap m-0">
                    {m.content}
                  </pre>
                ) : (
                  renderContentWithFileLinks(m.content, onFileClick)
                )}
              </div>
            </div>
          </div>
        );
      })}
      {status === "running" && (
        <div className="flex items-center gap-2 text-xs text-gray-400 italic pl-10">
          <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
          Agents are responding...
        </div>
      )}
      {status === "error" && errorMessage && (
        <div className="mx-10 px-3 py-2 bg-red-900/40 text-red-200 text-xs rounded">
          Error: {errorMessage}
        </div>
      )}
      {lastIsError && (
        <div className="pl-10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void retryLastDiscussion()}
            className="px-3 py-1 bg-[#007acc] hover:bg-[#1f8ad2] text-white text-xs rounded"
          >
            🔁 重试上一个话题
          </button>
          <span className="text-[10px] text-gray-500">
            设置好 ~/.latte/models.yaml 后再试
          </span>
        </div>
      )}
    </div>
  );
}
