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
    <div className="flex flex-col h-full bg-surface border-l border-edge">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 border-b border-edge">
        <span className="text-base">💬</span>
        <span className="font-semibold text-sm text-fg">Chat</span>
        <select
          value={selectedWorkflow}
          onChange={(e) => setWorkflow(e.target.value)}
          className="ml-1 px-2 py-0.5 bg-control text-fg text-xs rounded border border-edge"
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
            className="text-fg-2 hover:text-fg text-xs px-1"
          >
            ⚙️
          </button>
          <button
            onClick={onClose}
            title="Close chat"
            className="text-fg-2 hover:text-fg text-xs px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Topic controls */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 border-b border-edge">
        <button
          onClick={createNewTopic}
          disabled={status === "running"}
          className="text-fg-2 hover:text-fg text-xs px-2 py-1 disabled:opacity-50 border border-edge rounded"
          title="Create a new topic"
        >
          + 新建话题
        </button>
        <select
          value={activeTopicId}
          onChange={(e) => selectTopic(e.target.value)}
          disabled={visibleTopics.length === 0 || status === "running"}
          className="flex-1 px-2 py-1 bg-control text-fg text-xs rounded border border-edge disabled:opacity-50"
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
        <div className="px-3 py-1.5 bg-surface-2 border-b border-edge text-[10px] text-fg-2 flex flex-wrap gap-1">
          {availableRoles.map((r) => (
            <span
              key={r.id}
              title={r.name}
              className="px-1.5 py-0.5 bg-surface-3 rounded cursor-default"
            >
              {r.icon} {r.id}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col flex-1 min-w-0">
          <span className="text-base">{wfIcon}</span>
          <span className="font-semibold text-sm text-fg">
            {wfLabel}
            {mode === "single" && lastResolvedModel && (
              <span className="font-normal text-[10px] text-fg-2 ml-1.5">
                · {lastResolvedModel}
                {singleTier ? ` · ${singleTier}` : ""}
              </span>
            )}
          </span>

          {availableWorkflows.length > 0 && (
            <select
              value={selectedWorkflow}
              onChange={(e) => setWorkflow(e.target.value)}
              className="ml-1 px-2 py-0.5 bg-control text-fg text-xs rounded border border-edge max-w-[140px]"
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

          <span className="text-[10px] text-fg-3 ml-1">
            {mode === "manager" ? "交互式" : mode === "swarm" ? "蜂群" : mode === "controller" ? "Controller" : mode === "single" ? "直聊" : "讨论"}
          </span>

          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={() => useChatStore.getState().setMode("single")}
              className={`px-1.5 py-0.5 text-[10px] rounded ${mode === "single" ? "bg-accent text-white" : "bg-control text-fg-2 hover:text-fg"}`}
              title="单角色直聊"
            >直聊</button>
            <button
              onClick={() => useChatStore.getState().setMode("controller")}
              className={`px-1.5 py-0.5 text-[10px] rounded ${mode === "controller" ? "bg-accent text-white" : "bg-control text-fg-2 hover:text-fg"}`}
              title="Controller 事件驱动"
            >Ctrl</button>
            {mode === "single" && (
              <select
                value={singleRoleId}
                onChange={(e) => setSingleRoleId(e.target.value)}
                className="px-1.5 py-0.5 text-[10px] rounded bg-control text-fg border border-edge"
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
              className="px-1.5 py-0.5 text-[10px] rounded bg-control text-fg border border-edge ml-1"
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
              <button onClick={handlePause} title="暂停" className="text-warn hover:text-warn text-xs px-1">⏸</button>
            )}
            {mode === "controller" && status !== "running" && controllerSessionId && (
              <button onClick={handleResume} title="继续" className="text-ok hover:text-ok text-xs px-1">▶</button>
            )}
            {((mode === "controller" && controllerSessionId) || canStop) && (
              <button onClick={handleAbort} title="终止" className="text-err hover:text-err text-xs px-1">⏹</button>
            )}
            {messages.length > 0 && !canStop && (
              <button onClick={clearChat} title="清空" className="text-fg-2 hover:text-fg text-xs px-1">🗑</button>
            )}
            {mode === "single" && messages.length > 0 && (
              <button onClick={clearChat} title="新话题" className="text-ok hover:text-ok text-xs px-1">📄</button>
            )}
            <button
              onClick={() => setShowSessions(!showSessions)}
              className={`text-xs px-1 ${showSessions ? "text-accent" : "text-fg-2 hover:text-fg"}`}
              title="会话历史"
            >📋</button>
            <button onClick={() => openConfigFile("roles")} title="配置" className="text-fg-2 hover:text-fg text-xs px-1">⚙</button>
            <button onClick={onClose} title="关闭" className="text-fg-2 hover:text-fg text-xs px-1">✕</button>
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
                  className="block w-full text-left px-3 py-2 bg-surface-3 hover:bg-control border border-edge rounded text-sm text-fg transition-colors"
                >
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && <span className="block text-[11px] text-fg-2 mt-0.5">{opt.description}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── Workflow settings ───────────────────────────── */}
          <div className="mt-3 pt-3 border-t border-edge">
            <div className="flex items-center mb-2">
              <div className="font-semibold text-fg flex-1">
                🪄 工作流流程
              </div>
              <button
                onClick={() => openNewWorkflowEditor()}
                className="px-2 py-0.5 bg-accent hover:bg-accent-2 text-white text-[10px] rounded"
                type="button"
              >
                ＋ 新建
              </button>
            </div>
            <div className="text-[10px] text-fg-3 mb-1">
              选定一个流程，点 ✏️ 编辑 ——
              <span className="text-fg-2">
                改名称、步骤顺序、每步角色后点保存。
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {availableWorkflows.map((w) => (
                <div
                  key={w.id}
                  className="flex items-center gap-1 px-2 py-1 bg-surface-3 rounded"
                >
                  <button
                    onClick={() => handleEditExistingWorkflow(w.id)}
                    className="flex-1 text-left text-[11px] text-fg hover:text-fg-2 truncate"
                    title={`点击编辑 ${w.name}`}
                    type="button"
                  >
                    <span className="mr-1">
                      {w.kind === "swarm" ? "🪄" : "💬"}
                    </span>
                    {w.name}{" "}
                    <span className="text-fg-3 text-[10px]">({w.id})</span>
                  </button>
                  <button
                    onClick={() => openConfigFile(`workflow:${w.id}`)}
                    className="px-1 text-fg-2 hover:text-fg text-[11px]"
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
              className="px-2 py-1 bg-control hover:bg-control-hover text-fg rounded"
              type="button"
            >
              📄 models.yaml
            </button>
            <button
              onClick={() => openConfigFile("roles")}
              className="px-2 py-1 bg-control hover:bg-control-hover text-fg rounded"
              type="button"
            >
              📄 roles.yaml
            </button>
          </div>

          <div className="mt-2 text-[10px] text-fg-3">
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
        <div className="mx-3 mb-2 p-3 bg-err/30 border border-err rounded text-sm text-err">
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
              className="px-2 py-1 bg-err hover:bg-err text-white text-xs rounded"
            >
              📄 打开配置文件
            </button>
          )}
        </div>
        )}

      <div className="px-3 py-2 bg-surface-2 border-t border-edge">
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
            className="w-full px-2 py-1.5 bg-control text-fg text-sm rounded border border-edge outline-none focus:border-accent resize-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleSend}
              disabled={!input.trim() || canStop}
              className="px-3 py-1 bg-accent hover:bg-accent-2 text-white text-xs rounded disabled:opacity-50"
            >Send</button>
            <span className="text-[10px] text-fg-3 ml-auto">Enter 发送 · Shift+Enter 换行</span>
          </div>
      </div>

      {/* Workflow editor modal — only mounted when an editing session is open. */}
      {editingWorkflow && <WorkflowEditor />}
    </div>
  );
}
