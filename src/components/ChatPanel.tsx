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
    mode,
    messages,
    status,
    availableWorkflows,
    selectedWorkflow,
    errorMessage,
    pendingDecision,
    controllerSessionId,
    sessionList,
    sessionListLoading,
    loadRoleConfig,
    loadWorkflows,
    loadSessionList,
    deleteSession,
    setWorkflow,
    sendMessage,
    clearChat,
    cancelDiscussion,
    openConfigFile,
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

  const wf = availableWorkflows.find((w) => w.id === selectedWorkflow);
  const wfIcon = wf?.mode === "manager" ? "🧠"
    : wf?.mode === "swarm" ? "🐝"
    : mode === "controller" ? "🎮"
    : mode === "single" ? "💬"
    : "💬";
  const wfLabel = wf?.name ?? (
    mode === "controller" ? "Controller"
    : mode === "single" ? "单角色直聊"
    : selectedWorkflow ?? "讨论"
  );

  const canStop = status === "running";

  const handlePause = useCallback(async () => {
    const store = useChatStore.getState();
    if (store.controllerSessionId) {
      try { await store.pauseController(); } catch (e) { console.error("pause failed:", e); }
    }
  }, []);

  const handleResume = useCallback(async () => {
    const store = useChatStore.getState();
    if (store.controllerSessionId) {
      try { await store.resumeController(); } catch (e) { console.error("resume failed:", e); }
    }
  }, []);

  const handleAbort = useCallback(async () => {
    await cancelDiscussion();
  }, [cancelDiscussion]);

  const handleContinueSession = useCallback(async (sessionId: string) => {
    const store = useChatStore.getState();
    store.setMode("controller");
    store.controllerSessionId = sessionId;
    const { spawnController } = await import("../api/chat");
    await spawnController({
      sessionId,
      taskId: null,
      roles: ["manager"],
      initialPrompt: null,
      maxRounds: 10,
      sessionTokenBudget: 0,
      primaryModelId: null,
      initialTier: null,
      cwd: null,
    });
  }, []);

  const filteredSessions = sessionList.filter(s =>
    !sessionSearch || s.sessionId.toLowerCase().includes(sessionSearch.toLowerCase())
  );

  const handleRetry = useCallback(() => {
    useChatStore.getState().retryLastDiscussion();
  }, []);

  return (
    <div className="flex h-full bg-[#1e1e1e] border-l border-gray-700">
      {showSessions && (
        <div className="w-56 flex-shrink-0 bg-[#252526] border-r border-gray-700 flex flex-col overflow-hidden">
          <div className="px-2 py-1.5 text-[11px] text-gray-400 font-semibold border-b border-gray-700 flex items-center gap-1">
            <span>会话历史</span>
            <span className="text-[10px] text-gray-600 ml-auto">({sessionList.length})</span>
          </div>
          <div className="px-2 py-1">
            <input
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
              placeholder="搜索会话..."
              className="w-full px-1.5 py-1 bg-[#3a3a3a] text-gray-300 text-[11px] rounded border border-gray-600 outline-none focus:border-[#007acc]"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {sessionListLoading ? (
              <div className="px-2 py-3 text-[11px] text-gray-500 text-center">加载中...</div>
            ) : filteredSessions.length === 0 ? (
              <div className="px-2 py-3 text-[11px] text-gray-500 text-center">暂无会话</div>
            ) : (
              filteredSessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="px-2 py-1.5 hover:bg-[#3a3a3a] cursor-pointer border-b border-gray-700/50 group"
                  onClick={() => handleContinueSession(s.sessionId)}
                >
                  <div className="flex items-center gap-1">
                    <span className="text-[10px]">
                      {s.state === "done" ? "✅" : s.state === "paused" ? "⏸" : "💬"}
                    </span>
                    <span className="text-[11px] text-gray-300 truncate flex-1">
                      {s.sessionId.length > 42 ? `${s.sessionId.slice(0, 40)}…` : s.sessionId}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteSession(s.sessionId); }}
                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-[10px]"
                      title="删除"
                    >✕</button>
                  </div>
                  <div className="flex gap-2 text-[9px] text-gray-600 ml-3.5">
                    <span>{s.chatType}</span>
                    <span>{s.messageCount} 条</span>
                    <span className="truncate">{s.updatedAt.slice(0, 10)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-2 px-3 py-2 bg-[#252526] border-b border-gray-700">
          <span className="text-base">{wfIcon}</span>
          <span className="font-semibold text-sm text-gray-200">{wfLabel}</span>

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
          </div>

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

          {status === "idle" && errorMessage && messages.length > 0 && (
            <div className="mx-3 my-2">
              <button onClick={handleRetry} className="px-3 py-1 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 text-xs rounded border border-gray-600">重试</button>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {errorMessage && (
          <div className="mx-3 mb-2 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">
            <div className="font-semibold mb-1">Error</div>
            <div className="whitespace-pre-wrap text-xs">{errorMessage}</div>
          </div>
        )}

        <div className="px-3 py-2 bg-[#252526] border-t border-gray-700">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={canStop ? "等待响应中..." : `向 ${wfLabel} 发送任务...`}
            disabled={canStop}
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
      </div>
    </div>
  );
}