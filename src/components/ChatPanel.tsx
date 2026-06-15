import { useEffect, useState } from "react";
import { useChatStore } from "../hooks/useChatStore";
import { MessageList } from "./MessageList";
import { openFile } from "../api/commands";
import { useEditorStore } from "../hooks/useEditorStore";

interface Props {
  onClose: () => void;
}

export function ChatPanel({ onClose }: Props) {
  const {
    messages,
    status,
    errorMessage,
    selectedWorkflow,
    availableWorkflows,
    availableRoles,
    setWorkflow,
    loadWorkflows,
    sendMessage,
    cancelDiscussion,
    clearChat,
  } = useChatStore();
  const [input, setInput] = useState("");

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  const handleFileClick = async (path: string) => {
    try {
      const file = await openFile(path);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      console.error("openFile failed:", e);
    }
  };

  const handleSend = () => {
    if (!input.trim() || status === "running") return;
    const msg = input;
    setInput("");
    void sendMessage(msg);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] border-l border-gray-700">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#252526] border-b border-gray-700">
        <span className="text-base">💬</span>
        <span className="font-semibold text-sm text-gray-200">Chat</span>
        <select
          value={selectedWorkflow}
          onChange={(e) => setWorkflow(e.target.value)}
          className="ml-2 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600"
        >
          {availableWorkflows.length === 0 && (
            <option value="default_workflow">default_workflow</option>
          )}
          {availableWorkflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={clearChat}
            title="Clear chat"
            className="text-gray-400 hover:text-gray-200 text-xs px-1"
          >
            🗑
          </button>
          <button
            onClick={onClose}
            title="Close chat"
            className="text-gray-400 hover:text-gray-200 text-xs px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Role strip */}
      {availableRoles.length > 0 && (
        <div className="px-3 py-1.5 bg-[#252526] border-b border-gray-800 text-[10px] text-gray-400 flex flex-wrap gap-1">
          {availableRoles.map((r) => (
            <span
              key={r.id}
              title={r.name}
              className="px-1.5 py-0.5 bg-[#2a2a2a] rounded cursor-default"
            >
              {r.icon} {r.id}
            </span>
          ))}
        </div>
      )}

      {/* Messages */}
      <MessageList messages={messages} status={status} onFileClick={handleFileClick} />

      {/* Error display */}
      {errorMessage && (
        <div className="mx-3 mb-2 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">
          <div className="font-semibold mb-1">⚠️ 错误</div>
          <div className="whitespace-pre-wrap text-xs mb-2">{errorMessage}</div>
          {errorMessage.includes("配置文件") && (
            <button
              onClick={async () => {
                // Extract path from error message
                const pathMatch = errorMessage.match(/路径:\s*([^\s\n]+)/);
                if (pathMatch && pathMatch[1]) {
                  try {
                    const file = await openFile(pathMatch[1]);
                    useEditorStore.getState().openFileOrSwitch(file);
                  } catch (e) {
                    console.error("打开配置文件失败:", e);
                  }
                }
              }}
              className="px-2 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded"
            >
              📄 打开配置文件
            </button>
          )}
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-2 bg-[#252526] border-t border-gray-700">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            status === "running"
              ? "Waiting for agents..."
              : "Type a topic or follow-up..."
          }
          disabled={status === "running"}
          rows={2}
          className="w-full px-2 py-1.5 bg-[#3a3a3a] text-gray-200 text-sm rounded border border-gray-600 outline-none focus:border-[#007acc] resize-none disabled:opacity-50"
        />
        <div className="flex items-center gap-2 mt-2">
          {status === "running" ? (
            <button
              onClick={cancelDiscussion}
              className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-3 py-1 bg-[#007acc] hover:bg-[#1f8ad2] text-white text-xs rounded disabled:opacity-50"
            >
              Send
            </button>
          )}
          <span className="text-[10px] text-gray-500 ml-auto">
            Enter to send · Shift+Enter newline
          </span>
        </div>
      </div>
    </div>
  );
}
