import { useMemo } from "react";
import { markdownToHtml } from "../utils/markdown";
import { useChatStore } from "../hooks/useChatStore";
import type { ChatActivityEvent, ChatMessage } from "../hooks/useChatStore";

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
              className="flex items-center gap-2 text-xs px-2 py-1 bg-info hover:bg-accent text-accent-2 rounded text-left"
            >
              <span>📝</span>
              <span className="font-mono">{f.path}</span>
              {f.desc && <span className="text-accent-2 opacity-80 truncate">— {f.desc}</span>}
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
      ? "bg-info text-accent-2"
      : tone === "error"
        ? "bg-err/60 text-err"
        : "bg-surface-3 text-fg";
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

function activityTone(kind: ChatActivityEvent["kind"]): string {
  if (kind === "tool_error" || kind === "error") {
    return "border-err/70 bg-err/20 text-err";
  }
  if (kind.startsWith("tool")) {
    return "border-warn/60 bg-warn/10 text-warn";
  }
  if (kind.startsWith("delegate")) {
    return "border-accent-2/60 bg-accent-2/10 text-accent-2";
  }
  return "border-edge bg-surface text-fg";
}

function ActivityItem({ event }: { event: ChatActivityEvent }) {
  const isExpandable = Boolean(event.detail);
  const isTool = event.kind.startsWith("tool");
  const summary = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="font-semibold truncate">{event.title}</span>
      {event.roleId && (
        <span className="shrink-0 rounded bg-black/20 px-1.5 py-0.5 font-mono text-[10px] opacity-80">
          {event.roleId}
        </span>
      )}
      {isTool && (
        <span className="shrink-0 rounded bg-warn/30 px-1.5 py-0.5 text-[10px] text-warn">
          tool
        </span>
      )}
    </span>
  );

  if (!isExpandable) {
    return (
      <div className={"rounded border px-2 py-1 text-[11px] " + activityTone(event.kind)}>
        {summary}
      </div>
    );
  }

  return (
    <details className={"group rounded border px-2 py-1 text-[11px] " + activityTone(event.kind)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        {summary}
        <span className="shrink-0 text-[10px] opacity-60 group-open:hidden">展开</span>
        <span className="hidden shrink-0 text-[10px] opacity-60 group-open:inline">收起</span>
      </summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 font-mono text-[10px] leading-4 text-fg">
        {event.detail}
      </pre>
    </details>
  );
}

export function MessageList({ messages, status, onFileClick }: Props) {
  const errorMessage = useChatStore((s) => s.errorMessage);
  const activityEvents = useChatStore((s) => s.activityEvents);
  const activeRoles = useChatStore((s) => s.activeRoles);
  const lastUserTopic = useChatStore((s) => s.lastUserTopic);
  const retryLastDiscussion = useChatStore((s) => s.retryLastDiscussion);
  const list = useMemo(() => messages, [messages]);
  const visibleActivity = useMemo(() => activityEvents.slice(-20), [activityEvents]);
  const activeRoleList = Object.values(activeRoles);

  // When the most recent message is an error turn, expose a single
  // retry CTA at the bottom of the list. The error bubbles themselves
  // stay inline so the user can read which role failed.
  const lastIsError =
    list.length > 0 && isErrorMessage(list[list.length - 1]) && !!lastUserTopic;

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
      {list.length === 0 && (
        <div className="text-fg-3 text-sm italic mt-8 text-center">
          Start a discussion by typing a topic below.
        </div>
      )}
      {list.map((m) => {
        if (m.role === "user") {
          return (
            <div key={m.id} className="flex justify-start gap-2 items-start">
              <Avatar emoji="👤" tone="user" />
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-info px-3 py-2 text-sm text-accent-2 shadow-sm whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          );
        }
        const error = isErrorMessage(m);
        const tone = error ? "error" : "agent";
        return (
          <div key={m.id} className="flex justify-end gap-3 items-start">
            <div className="flex max-w-[88%] min-w-0 flex-col items-end">
              <div
                className={
                  "mb-1 flex items-center justify-end gap-2 text-xs " +
                  (error ? "text-err" : "text-fg-2")
                }
              >
                <span className="font-semibold">
                  {m.agentName ?? "agent"}
                </span>
                {error && (
                  <span className="px-1.5 py-0.5 rounded bg-err/50 text-[10px] uppercase tracking-wide">
                    错误
                  </span>
                )}
              </div>
              <div
                className={
                  "rounded-2xl rounded-tr-sm border p-3 text-left text-sm leading-6 shadow-sm whitespace-pre-wrap " +
                  (error
                    ? "bg-err/40 border border-err/60 text-err"
                    : "border-control bg-surface text-fg")
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
            <Avatar emoji={m.agentIcon ?? "💬"} tone={tone} />
          </div>
        );
      })}
      {(activeRoleList.length > 0 || visibleActivity.length > 0) && (
        <div className="ml-11 mr-2 rounded-xl border border-edge bg-surface px-3 py-2 space-y-2">
          {activeRoleList.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {activeRoleList.map((role) => (
                <span
                  key={role.roleId}
                  className="inline-flex items-center gap-1 rounded bg-info px-2 py-0.5 text-[11px] text-accent-2"
                >
                  <span className="inline-block w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
                  {role.roleId}
                  <span className="text-accent-2/80">{role.detail}</span>
                </span>
              ))}
            </div>
          )}
          {visibleActivity.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-fg-3">
                activity
              </div>
              {visibleActivity.map((event) => (
                <ActivityItem key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
      {status === "running" && activeRoleList.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-fg-2 italic pl-10">
          <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
          Agents are responding...
        </div>
      )}
      {status === "error" && errorMessage && (
        <div className="mx-10 px-3 py-2 bg-err/40 text-err text-xs rounded">
          Error: {errorMessage}
        </div>
      )}
      {lastIsError && (
        <div className="pl-10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void retryLastDiscussion()}
            className="px-3 py-1 bg-accent hover:bg-accent-2 text-white text-xs rounded"
          >
            🔁 重试上一个话题
          </button>
          <span className="text-[10px] text-fg-3">
            设置好 ~/.latte/models.yaml 后再试
          </span>
        </div>
      )}
    </div>
  );
}
