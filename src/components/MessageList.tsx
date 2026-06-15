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
  // First, render markdown
  const html = markdownToHtml(text);
  // Then, find <file_edit> tags in the original text and convert them to
  // a clickable bar at the end of the message.
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

export function MessageList({ messages, status, onFileClick }: Props) {
  const errorMessage = useChatStore((s) => s.errorMessage);
  const list = useMemo(() => messages, [messages]);
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
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] px-3 py-2 bg-[#094771] text-blue-100 rounded text-sm">
                {m.content}
              </div>
            </div>
          );
        }
        return (
          <div key={m.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="text-base">{m.agentIcon ?? "💬"}</span>
              <span className="font-semibold text-gray-300">{m.agentName ?? "agent"}</span>
            </div>
            <div className="bg-[#2a2a2a] text-gray-200 rounded p-3 max-w-[95%]">
              {renderContentWithFileLinks(m.content, onFileClick)}
            </div>
          </div>
        );
      })}
      {status === "running" && (
        <div className="flex items-center gap-2 text-xs text-gray-400 italic">
          <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
          Agents are responding...
        </div>
      )}
      {status === "error" && errorMessage && (
        <div className="px-3 py-2 bg-red-900/40 text-red-200 text-xs rounded">
          Error: {errorMessage}
        </div>
      )}
    </div>
  );
}
