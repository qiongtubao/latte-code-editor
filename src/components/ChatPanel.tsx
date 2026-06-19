import { useEffect, useState } from "react";
import { useChatStore } from "../hooks/useChatStore";
import { MessageList } from "./MessageList";
import { RoleChainEditor } from "./RoleChainEditor";
import { WorkflowEditor } from "./WorkflowEditor";
import { openFile } from "../api/commands";
import { useEditorStore } from "../hooks/useEditorStore";
import type { WorkflowPayload } from "../api/chat";
import { getWorkflowFull } from "../api/chat";

interface Props {
  onClose: () => void;
}
export function ChatPanel({ onClose }: Props) {
  const {
    mode,
    messages,
    status,
    errorMessage,
    selectedWorkflow,
    availableWorkflows,
    availableRoles,
    availableModels,
    defaultModel,
    modelsPath,
    rolesPath,
    configPanelOpen,
    swarmPlan,
    swarmFiles,
    swarmSummary,
    setMode,
    setWorkflow,
    loadWorkflows,
    loadModels,
    loadRoleConfig,
    sendMessage,
    cancelDiscussion,
    clearChat,
    setRoleModelChain,
    setDefaultModel,
    openConfigFile,
    toggleConfigPanel,
    openWorkflowEditor,
    openNewWorkflowEditor,
    closeWorkflowEditor,
    editingWorkflow,
    pendingDecision,
    submitManagerDecision,
    managerContinue,
    managerStatus,
  } = useChatStore();
  const [input, setInput] = useState("");
  const [managerStatusCollapsed, setManagerStatusCollapsed] = useState(true);
   useEffect(() => {
    loadWorkflows();
    loadModels();
  }, [loadWorkflows, loadModels, loadRoleConfig]);

  const handleFileClick = async (path: string) => {
    try {
      const file = await openFile(path);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      console.error("openFile failed:", e);
    }
  };

  const handleEditExistingWorkflow = async (id: string) => {
    try {
      const full = await getWorkflowFull(id);
      openWorkflowEditor(full);
    } catch (e) {
      console.error("打开工作流编辑器失败：", e);
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
  // Show every workflow in the dropdown, regardless of the current
  // chat mode. Each entry carries a small mode tag (planned / swarm /
  // manager) so the user can see what mode picking it will activate.
  // Filtering workflows out by mode hid manager_led from users who
  // hadn't yet clicked the manager button — they had no way to
  // discover the 通用 workflow.
  const filteredWorkflows = availableWorkflows;
  const modeTagFor = (id: string, kind: string): string => {
    if (id.startsWith("manager_")) return "👔 manager";
    if (kind === "swarm") return "🪄 swarm";
    return "💬 planned";
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] border-l border-gray-700">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#252526] border-b border-gray-700">
        <span className="text-base">💬</span>
        <span className="font-semibold text-sm text-gray-200">Chat</span>
        {/* Mode toggle: discuss / swarm / manager. */}
        <div className="ml-2 flex items-center bg-[#1e1e1e] rounded border border-gray-700 text-[10px] overflow-hidden">
          <button
            onClick={() => setMode("discuss")}
            className={
              "px-2 py-0.5 " +
              (mode === "discuss"
                ? "bg-[#007acc] text-white"
                : "text-gray-400 hover:text-gray-200")
            }
            title="Planned discussion — fixed roles speak in order"
          >
            💬 Discuss
          </button>
          <button
            onClick={() => setMode("swarm")}
            className={
              "px-2 py-0.5 border-l border-gray-700 " +
              (mode === "swarm"
                ? "bg-[#007acc] text-white"
                : "text-gray-400 hover:text-gray-200")
            }
            title="Swarm — planner breaks the topic into ordered worker steps"
          >
            🪄 Swarm
          </button>
          <button
            onClick={() => setMode("manager")}
            className={
              "px-2 py-0.5 border-l border-gray-700 " +
              (mode === "manager"
                ? "bg-[#a06ec2] text-white"
                : "text-gray-400 hover:text-gray-200")
            }
            title="Manager-led — interactive flow with option-button pauses"
          >
            👔 Manager
          </button>
        </div>
        <select
          value={selectedWorkflow}
          onChange={(e) => setWorkflow(e.target.value)}
          className="ml-1 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 text-xs rounded border border-gray-600"
        >
          {filteredWorkflows.length === 0 && (
            <option value={mode === "swarm" ? "quick_task" : mode === "manager" ? "manager_default" : "default_workflow"}>
              {mode === "swarm"
                ? "quick_task"
                : mode === "manager"
                  ? "manager_default"
                  : "default_workflow"}
            </option>
          )}
          {filteredWorkflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}  [{modeTagFor(w.id, w.kind ?? "planned")}]
            </option>
          ))}
        </select>
        {mode === "manager" && managerStatus && (
          <ManagerStatusBar
            status={managerStatus}
            collapsed={managerStatusCollapsed}
            onToggleCollapse={() =>
              setManagerStatusCollapsed((c) => !c)
            }
          />
        )}
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
            <div className="flex items-center text-gray-400 mb-1">
              <span>角色模型优先级:</span>
              <span className="ml-auto text-[10px] text-gray-500">
                1=主, 2+=备选
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {availableRoles.map((role) => (
                <RoleChainEditor
                  key={role.id}
                  roleId={role.id}
                  icon={role.icon}
                  name={role.name}
                  // Prefer the explicit chain; fall back to a synthetic
                  // one-element chain built from the primary, so roles
                  // loaded from a pre-chain config still render a
                  // functional editor.
                  serverChain={
                    role.modelChain.length > 0 ? role.modelChain : []
                  }
                  availableModels={availableModels}
                  onSave={(chain) => setRoleModelChain(role.id, chain)}
                />
              ))}
            </div>
          </div>

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
      )}

      {/* Swarm status: visible only in swarm mode and only when the
          swarm produced structured output worth showing (plan, files,
          or summary). The conversation transcript is still in
          MessageList; this is a compact at-a-glance summary. */}
      {mode === "swarm" && (swarmPlan.length > 0 || swarmFiles.length > 0 || swarmSummary) && (
        <SwarmStatus
          plan={swarmPlan}
          files={swarmFiles}
          summary={swarmSummary}
          onFileClick={handleFileClick}
        />
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

      {/* Manager-led: when the backend emits chat:need_decision,
          the user must pick an option (or push forward without
          picking). We replace the regular input with an
          option-button panel until the user resolves the decision. */}
      {mode === "manager" && pendingDecision ? (
        <DecisionBubble
          decision={pendingDecision}
          onPick={submitManagerDecision}
          onSkip={managerContinue}
        />
      ) : (
        <div className="px-3 py-2 bg-[#252526] border-t border-gray-700">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={
              mode === "manager"
                ? "manager 主导 — 等 manager 问问题时再回"
                : status === "running"
                  ? "Waiting for agents..."
                  : mode === "swarm"
                    ? "Drop a small task — planner will pick the right roles…"
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
      )}

      {/* Workflow editor modal — only mounted when an editing session is open. */}
      {editingWorkflow && <WorkflowEditor />}
    </div>
  );
}

interface SwarmStatusProps {
  plan: { id: string; role: string; instruction: string }[];
  files: { path: string; kind: "plan" | "output" | "summary" }[];
  summary: string | null;
  onFileClick: (path: string) => void;
}

/**
 * Compact swarm summary shown above the message list when the user
 * is in swarm mode. Renders the planner's emitted steps and the
 * files the runner wrote. The full conversation stays in
 * MessageList — this is a structural overview.
 */
function SwarmStatus({ plan, files, summary, onFileClick }: SwarmStatusProps) {
  return (
    <div className="px-3 py-2 bg-[#252526] border-b border-gray-700 text-[11px] text-gray-300 space-y-2 max-h-48 overflow-y-auto">
      <div className="font-semibold text-gray-200 flex items-center gap-2">
        <span>🪄 Swarm plan</span>
        <span className="text-gray-500 font-normal">
          ({plan.length} step{plan.length === 1 ? "" : "s"})
        </span>
      </div>
      {plan.length === 0 ? (
        <div className="text-gray-500 italic">No plan yet.</div>
      ) : (
        <ol className="space-y-1 pl-4 list-decimal">
          {plan.map((s) => (
            <li key={s.id} className="leading-snug">
              <span className="font-mono text-[10px] text-gray-400 mr-1">{s.role}</span>
              <span>{s.instruction}</span>
            </li>
          ))}
        </ol>
      )}
      {files.length > 0 && (
        <div className="pt-1 border-t border-gray-700">
          <div className="text-gray-500 mb-1">Output files</div>
          <div className="flex flex-col gap-1">
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => onFileClick(f.path)}
                className="flex items-center gap-2 text-left text-[10px] px-2 py-1 bg-[#2a2a2a] hover:bg-[#333] rounded font-mono"
                title={`${f.kind} — click to open`}
              >
                <span className="text-gray-400">[{f.kind}]</span>
                <span className="truncate">{f.path}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {summary && (
        <div className="pt-1 border-t border-gray-700 text-[10px] text-gray-400">
          ✨ Synthesis ready (see message list).
        </div>
      )}
    </div>
  );
}

interface DecisionBubbleProps {
  decision: import("../api/chat").DecisionRequest;
  onPick: (optionId: string, freeText?: string) => Promise<void> | void;
  onSkip: (message?: string) => Promise<void> | void;
}

/**
 * Purple-bordered option panel rendered in place of the regular
 * text input when the manager pauses to ask the user.
 *
 * Each option shows label / description / estimated cost. Picking
 * one (or pressing the "我说了算" skip button at the bottom) calls
 * the corresponding store action which IPCs back to the backend.
 */
function DecisionBubble({ decision, onPick, onSkip }: DecisionBubbleProps) {
  const [freeText, setFreeText] = useState("");
  return (
    <div className="px-3 py-3 bg-purple-950/30 border-t-2 border-purple-700/60 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-purple-300 font-semibold">
          👔 manager 正在等你决定
        </div>
        {decision.branchLabel && (
          <div
            className="text-[10px] px-1.5 py-0.5 bg-purple-900/60 border border-purple-700/50 text-purple-200 rounded font-mono"
            title="manager 根据关键词判断的话题类型"
          >
            {decision.branchLabel}
          </div>
        )}
      </div>
      <div className="text-sm text-purple-100 font-medium leading-snug">
        {decision.question}
      </div>
      {decision.reason && (
        <div className="text-[11px] text-purple-200/70 italic leading-snug">
          _{decision.reason}_
        </div>
      )}
      {decision.contextSummary && (
        <details className="text-[10px] text-purple-200/60">
          <summary className="cursor-pointer hover:text-purple-200">
            当前上下文
          </summary>
          <pre className="mt-1 px-2 py-1 bg-purple-900/30 rounded whitespace-pre-wrap font-mono text-[10px]">
            {decision.contextSummary}
          </pre>
        </details>
      )}
      <div className="flex flex-col gap-1.5 pt-1">
        {decision.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onPick(opt.id, freeText.trim() || undefined)}
            className="text-left px-3 py-2 bg-purple-900/40 hover:bg-purple-800/60 border border-purple-700/50 rounded transition-colors group"
          >
            <div className="flex items-start gap-2">
              <span className="text-base shrink-0">
                {opt.workerRole === "conclude" || opt.workerRole === null
                  ? "✅"
                  : opt.workerRole
                    ? "▶️"
                    : "❓"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-purple-100 font-medium">
                    {opt.label}
                  </span>
                  {opt.estimatedCostUsd > 0 && (
                    <span className="text-[10px] text-orange-300 px-1.5 py-0.5 bg-orange-900/40 border border-orange-800/60 rounded shrink-0">
                      ≈ ${opt.estimatedCostUsd.toFixed(3)}
                    </span>
                  )}
                  {opt.workerRole && (
                    <span className="text-[10px] text-purple-300/70 font-mono shrink-0">
                      → {opt.workerRole}
                    </span>
                  )}
                </div>
 {opt.description && (
                  <div className="text-[11px] text-purple-200/70 mt-0.5 leading-snug">
                    {opt.description}
                  </div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
      <textarea
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        placeholder="（可选）补充说明，会跟选项一起发给 manager"
        rows={2}
        className="w-full px-2 py-1.5 bg-[#2a1f3a] text-purple-100 text-xs rounded border border-purple-800 outline-none focus:border-purple-500 resize-none"
      />
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onSkip(freeText.trim() || undefined)}
          className="px-2 py-1 text-[11px] text-purple-300 hover:text-purple-100 hover:bg-purple-900/40 rounded"
          title="不选选项，让 manager 继续"
        >
          我说了算（manager 自己定）→
        </button>
        <span className="text-[10px] text-purple-300/60 ml-auto">
          {decision.options.length} 个选项
        </span>
      </div>
    </div>
  );
}

interface ManagerStatusBarProps {
  status: import("../api/chat").ManagerStatus;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * Compact Chinese-labeled status panel for manager-led sessions.
 * Shows the role + model, phase, steps / decisions budget, transcript
 * size, and a stub-mode warning when the manager isn't actually
 * calling an LLM. Rendered in the chat panel header (manager mode
 * only); collapsible so it doesn't crowd the dropdown row.
 */
function ManagerStatusBar({
  status,
  collapsed,
  onToggleCollapse,
}: ManagerStatusBarProps) {
  const elapsedSec = Math.round(status.elapsedMs / 1000);
  const remainingSteps = status.maxTotalSteps - status.stepsTaken;
  const remainingDecisions = status.maxUserDecisions - status.decisionsTaken;
  const transcriptKB = (status.transcriptBytes / 1024).toFixed(1);

  return (
    <div className="ml-2 text-[10px]">
      <button
        type="button"
        onClick={onToggleCollapse}
        className="px-2 py-0.5 bg-purple-900/30 border border-purple-700/40 text-purple-200 rounded text-[10px] hover:bg-purple-900/50"
        title="点击展开 / 折叠 manager 会话状态"
      >
        📊 {status.phaseLabel} {collapsed ? "▸" : "▾"}
      </button>
      {!collapsed && (
        <div className="absolute z-10 mt-1 left-0 right-0 mx-2 p-3 bg-[#1e1e1e] border border-purple-700/40 rounded shadow-lg text-[11px] text-gray-200 space-y-1">
          <div className="flex items-center gap-2 font-semibold">
            <span>{status.managerIcon}</span>
            <span>{status.managerRoleName}</span>
            <span className="text-gray-500 font-normal">
              ({status.managerRoleId})
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <Field label="模型" value={
              status.currentModel
                ? `${status.currentModel} (chain: ${status.modelChain.length})`
                : "（无）"
            } />
            <Field
              label="Stub?"
              value={status.isStubMode ? "⚠️ 是（keyword 决策）" : "✅ 实时 LLM"}
              tone={status.isStubMode ? "warn" : "ok"}
            />
            <Field
              label="状态"
              value={`${status.phaseLabel}`}
            />
            <Field label="运行" value={`${elapsedSec} 秒`} />
            <Field
              label="步数"
              value={`${status.stepsTaken} / ${status.maxTotalSteps}（剩 ${remainingSteps}）`}
            />
            <Field
              label="决策"
              value={`${status.decisionsTaken} / ${status.maxUserDecisions}（剩 ${remainingDecisions}）`}
            />
            <Field
              label="Transcript"
              value={`${transcriptKB} KB · ~${status.tokensEstimated} tokens`}
            />
            <Field
              label="Workers"
              value={
                status.availableWorkers.length > 0
                  ? status.availableWorkers.join("、")
                  : "（所有角色）"
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const valueColor =
    tone === "warn"
      ? "text-orange-300"
      : tone === "ok"
        ? "text-green-300"
        : "text-gray-100";
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-gray-500 shrink-0">{label}:</span>
      <span className={"truncate " + valueColor}>{value}</span>
    </div>
  );
}
