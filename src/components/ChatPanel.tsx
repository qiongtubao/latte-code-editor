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
    availableModels,
    defaultModel,
    roleModels,
    modelsPath,
    rolesPath,
    configPanelOpen,
    setWorkflow,
    loadWorkflows,
    loadModels,
    loadRoleConfig,
    sendMessage,
    cancelDiscussion,
    clearChat,
    setRoleModel,
    setDefaultModel,
    openConfigFile,
    toggleConfigPanel,
  } = useChatStore();
  const [input, setInput] = useState("");

  useEffect(() => {
    loadWorkflows();
    loadModels();
    loadRoleConfig();
  }, [loadWorkflows, loadModels, loadRoleConfig]);

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
            onClick={toggleConfigPanel}
            title="Configuration"
            className="text-gray-400 hover:text-gray-200 text-xs px-1"
          >
            ⚙️
          </button>
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

      {/* Config Panel */}
      {configPanelOpen && (
        <div className="px-3 py-2 bg-[#252526] border-b border-gray-700 text-xs">
          <div className="font-semibold text-gray-200 mb-2">⚙️ 模型配置</div>
          
          <div className="mb-2">
            <label className="text-gray-400 block mb-1">默认模型:</label>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="w-full px-2 py-1 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>
          
          <div className="mb-2">
            <div className="text-gray-400 mb-1">角色模型:</div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {availableRoles.map((role) => (
                <div key={role.id} className="flex items-center gap-2">
                  <span className="w-20 text-gray-300 truncate">
                    {role.icon} {role.id}
                  </span>
                  <select
                    value={roleModels[role.id] || defaultModel}
                    onChange={(e) => setRoleModel(role.id, e.target.value)}
                    className="flex-1 px-1 py-0.5 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600"
                  >
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex gap-2 text-[10px]">
            <button
              onClick={() => openConfigFile("models")}
              className="px-2 py-1 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded"
            >
              📄 models.yaml
            </button>
            <button
              onClick={() => openConfigFile("roles")}
              className="px-2 py-1 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded"
            >
              📄 roles.yaml
            </button>
          </div>
          
          <div className="mt-2 text-[10px] text-gray-500">
            配置文件:<br/>
            {modelsPath}<br/>
            {rolesPath}
          </div>
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
