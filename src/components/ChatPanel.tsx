import { useEffect, useState, useRef, useCallback } from "react";
import { MessageList } from "./MessageList";
import { useChatStore } from "../hooks/useChatStore";
import { openFile } from "../api/commands";
import { useEditorStore } from "../hooks/useEditorStore";

interface Props {
  onClose: () => void;
}

export function ChatPanel({ onClose }: Props) {
  const {
    messages,
    status,
    availableWorkflows,
    selectedWorkflow,
    availableRoles,
    singleRoleId,
    singleSessionId,
    singleTier,
    lastResolvedModel,
    errorMessage,
    pendingDecision,
    controllerSessionId,
    sessionList,
    sessionListLoading,
    loadRoleConfig,
    loadWorkflows,
    loadSessionList,
    deleteSession,
    loadStoredSession,
    setWorkflow,
    setSingleRoleId,
    sendMessage,
    cancelDiscussion,
    createNewTopic,
    selectTopic,
    setRoleModelChain,
    setDefaultModel,
    openConfigFile,
    toggleConfigPanel,
    openWorkflowEditor,
    openNewWorkflowEditor,
    closeWorkflowEditor,
    editingWorkflow,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [showSessions, setShowSessions] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadRoleConfig();
    loadWorkflows();
    loadSessionList();
  }, [loadRoleConfig, loadWorkflows, loadSessionList]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleFileClick = useCallback(async (path: string) => {
    try {
      const file = await openFile(path);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      console.error("openFile failed:", e);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    await sendMessage(trimmed);
  }, [input, sendMessage]);

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);
  const managerWorkflows = availableWorkflows.filter(
    (w) => w.id.startsWith("manager_") || w.mode === "manager_led",
  );
  const workflowsForDropdown =
    managerWorkflows.length > 0 ? managerWorkflows : availableWorkflows;

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] border-l border-gray-700">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#252526] border-b border-gray-700">
        <span className="text-base">💬</span>
        <span className="font-semibold text-sm text-gray-200">Chat</span>
        <select
          value={selectedWorkflow}
          onChange={(e) => setWorkflow(e.target.value)}
          className="ml-1 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600"
        >
          {workflowsForDropdown.map((w) => (
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
            onClick={onClose}
            title="Close chat"
            className="text-gray-400 hover:text-gray-200 text-xs px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Topic controls */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#252526] border-b border-gray-700">
        <button
          onClick={createNewTopic}
          disabled={status === "running"}
          className="text-gray-400 hover:text-white text-xs px-2 py-1 disabled:opacity-50 border border-gray-700 rounded"
          title="Create a new topic"
        >
          + 新建话题
        </button>
        <select
          value={activeTopicId}
          onChange={(e) => selectTopic(e.target.value)}
          disabled={visibleTopics.length === 0 || status === "running"}
          className="flex-1 px-2 py-1 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600 disabled:opacity-50"
          title="History (filtered by current workflow)"
        >
          {visibleTopics.length === 0 ? (
            <option value={activeTopicId}>无历史话题</option>
          ) : (
            visibleTopics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))
          )}
        </select>
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
      <div className="flex flex-col flex-1 min-w-0">
          <span className="text-base">{wfIcon}</span>
          <span className="font-semibold text-sm text-gray-200">
            {wfLabel}
            {mode === "single" && lastResolvedModel && (
              <span className="font-normal text-[10px] text-gray-400 ml-1.5">
                · {lastResolvedModel}
                {singleTier ? ` · ${singleTier}` : ""}
              </span>
            )}
          </span>

          {availableWorkflows.length > 0 && (
            <select
              value={selectedWorkflow}
              onChange={(e) => setWorkflow(e.target.value)}
              className="ml-1 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600 max-w-[140px]"
              disabled={canStop}
            >
              <option value="discuss">💬 discuss (default)</option>
              {availableWorkflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.mode === "manager" ? "🧠" : w.mode === "swarm" ? "🐝" : "💬"} {w.name}
                </option>
              ))}
            </select>
          )}

          <span className="text-[10px] text-gray-500 ml-1">
            {mode === "manager" ? "交互式" : mode === "swarm" ? "蜂群" : mode === "controller" ? "Controller" : mode === "single" ? "直聊" : "讨论"}
          </span>

          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={() => useChatStore.getState().setMode("single")}
              className={`px-1.5 py-0.5 text-[10px] rounded ${mode === "single" ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-400 hover:text-gray-200"}`}
              title="单角色直聊"
            >直聊</button>
            <button
              onClick={() => useChatStore.getState().setMode("controller")}
              className={`px-1.5 py-0.5 text-[10px] rounded ${mode === "controller" ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-400 hover:text-gray-200"}`}
              title="Controller 事件驱动"
            >Ctrl</button>
            {mode === "single" && (
              <select
                value={singleRoleId}
                onChange={(e) => setSingleRoleId(e.target.value)}
                className="px-1.5 py-0.5 text-[10px] rounded bg-[#3a3a3a] text-gray-200 border border-gray-600"
                title="选择角色"
              >
                {availableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.icon} {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {mode === "single" && (
            <select
              value={singleSessionId ?? ""}
              onChange={(e) => {
                if (e.target.value) {
                  loadStoredSession(e.target.value);
                } else {
                  clearChat();
                }
              }}
              className="px-1.5 py-0.5 text-[10px] rounded bg-[#3a3a3a] text-gray-200 border border-gray-600 ml-1"
              title="加载/切换历史 session"
            >
              <option value="">+ 新话题</option>
              {sessionList
                .filter((s) => s.chatType === "single")
                .map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.sessionId.slice(0, 16)}… ({s.messageCount})
                  </option>
                ))}
            </select>
          )}

          <div className="ml-auto flex items-center gap-1">
            {mode === "controller" && status === "running" && controllerSessionId && (
              <button onClick={handlePause} title="暂停" className="text-yellow-400 hover:text-yellow-300 text-xs px-1">⏸</button>
            )}
            {mode === "controller" && status !== "running" && controllerSessionId && (
              <button onClick={handleResume} title="继续" className="text-green-400 hover:text-green-300 text-xs px-1">▶</button>
            )}
            {((mode === "controller" && controllerSessionId) || canStop) && (
              <button onClick={handleAbort} title="终止" className="text-red-400 hover:text-red-300 text-xs px-1">⏹</button>
            )}
            {messages.length > 0 && !canStop && (
              <button onClick={clearChat} title="清空" className="text-gray-400 hover:text-gray-200 text-xs px-1">🗑</button>
            )}
            {mode === "single" && messages.length > 0 && (
              <button onClick={clearChat} title="新话题" className="text-green-400 hover:text-green-300 text-xs px-1">📄</button>
            )}
            <button
              onClick={() => setShowSessions(!showSessions)}
              className={`text-xs px-1 ${showSessions ? "text-[#007acc]" : "text-gray-400 hover:text-gray-200"}`}
              title="会话历史"
            >📋</button>
            <button onClick={() => openConfigFile("roles")} title="配置" className="text-gray-400 hover:text-gray-200 text-xs px-1">⚙</button>
            <button onClick={onClose} title="关闭" className="text-gray-400 hover:text-gray-200 text-xs px-1">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <MessageList messages={messages} status={status} onFileClick={handleFileClick} />

          {pendingDecision && pendingDecision.options.length > 0 && (
            <div className="mx-3 my-2 space-y-1">
              {pendingDecision.options.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => useChatStore.getState().submitManagerDecision(opt.id)}
                  className="block w-full text-left px-3 py-2 bg-[#2d2d2d] hover:bg-[#3a3a3a] border border-gray-600 rounded text-sm text-gray-200 transition-colors"
                >
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && <span className="block text-[11px] text-gray-400 mt-0.5">{opt.description}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── Workflow settings ───────────────────────────── */}
          <div className="mt-3 pt-3 border-t border-gray-700">
            <div className="flex items-center mb-2">
              <div className="font-semibold text-gray-200 flex-1">
                🪄 工作流流程
              </div>
              <button
                onClick={() => openNewWorkflowEditor()}
                className="px-2 py-0.5 bg-[#007acc] hover:bg-[#1f8ad2] text-white text-[10px] rounded"
                type="button"
              >
                ＋ 新建
              </button>
            </div>
            <div className="text-[10px] text-gray-500 mb-1">
              选定一个流程，点 ✏️ 编辑 ——
              <span className="text-gray-400">
                改名称、步骤顺序、每步角色后点保存。
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {availableWorkflows.map((w) => (
                <div
                  key={w.id}
                  className="flex items-center gap-1 px-2 py-1 bg-[#2a2a2a] rounded"
                >
                  <button
                    onClick={() => handleEditExistingWorkflow(w.id)}
                    className="flex-1 text-left text-[11px] text-gray-200 hover:text-white truncate"
                    title={`点击编辑 ${w.name}`}
                    type="button"
                  >
                    <span className="mr-1">
                      {w.kind === "swarm" ? "🪄" : "💬"}
                    </span>
                    {w.name}{" "}
                    <span className="text-gray-500 text-[10px]">({w.id})</span>
                  </button>
                  <button
                    onClick={() => openConfigFile(`workflow:${w.id}`)}
                    className="px-1 text-gray-400 hover:text-white text-[11px]"
                    title={`打开 workflows/${w.id}.yaml`}
                    type="button"
                  >
                    📄
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 text-[10px] mt-3">
            <button
              onClick={() => openConfigFile("models")}
              className="px-2 py-1 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded"
              type="button"
            >
              📄 models.yaml
            </button>
            <button
              onClick={() => openConfigFile("roles")}
              className="px-2 py-1 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded"
              type="button"
            >
              📄 roles.yaml
            </button>
          </div>

          <div className="mt-2 text-[10px] text-gray-500">
            配置文件:
            <br />
            {modelsPath}
            <br />
            {rolesPath}
          </div>
        </div>

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

      <div className="px-3 py-2 bg-[#252526] border-t border-gray-700">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={
              status === "running"
                ? "Manager 正在处理..."
                : "输入新话题或继续当前话题..."
            }
            disabled={status === "running"}
            rows={2}
            className="w-full px-2 py-1.5 bg-[#3a3a3a] text-gray-200 text-sm rounded border border-gray-600 outline-none focus:border-[#007acc] resize-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleSend}
              disabled={!input.trim() || canStop}
              className="px-3 py-1 bg-[#007acc] hover:bg-[#1f8ad2] text-white text-xs rounded disabled:opacity-50"
            >Send</button>
            <span className="text-[10px] text-gray-500 ml-auto">Enter 发送 · Shift+Enter 换行</span>
          </div>
      </div>

      {/* Workflow editor modal — only mounted when an editing session is open. */}
      {editingWorkflow && <WorkflowEditor />}
    </div>
  );
}
