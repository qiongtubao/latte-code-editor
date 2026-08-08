import { useEffect, useState } from "react";
import { useChatStore } from "../hooks/useChatStore";
import type {
  HilMessage,
  HilRoleHistory,
  HilSessionState,
} from "../api/chat";

/**
 * HIL (Human-In-Loop) Blackboard chat view.
 *
 * Renders the editable per-role transcript of a single HIL session,
 * with controls for:
 * - creating / loading a session (task_id + initial prompt form)
 * - sending a new user message to a role
 * - pausing / resuming / aborting the session
 * - editing or deleting any message in any role's history (the
 *   "可修改聊天内容继续" affordance)
 * - opening `plan.md` or the raw session JSON in the editor
 *
 * State is sourced from `useChatStore` (`hilSession`, `hilBusy`,
 * `hilError`, etc.) and the actions on the same store. Events from
 * the backend (`chat:hil_state`) are merged in via
 * `applyHilState` in App.tsx.
 */
export function HilPanel() {
  const {
    hilTaskId,
    hilSession,
    hilSessionList,
    hilBusy,
    hilError,
    hilCwd,
    hilEditingMessage,
    startOrLoadHilSession,
    loadHilSessions,
    refreshHilSession,
    pauseHilSession,
    resumeHilSession,
    abortHilSession,
    sendHilUserMessage,
    injectToHilRole,
    editHilMessageAction,
    beginHilEditMessage,
    updateHilEditDraft,
    commitHilEditMessage,
    cancelHilEditMessage,
    openHilSessionJson,
    openHilPlanMd,
  } = useChatStore();

  const [taskId, setTaskId] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [sendRole, setSendRole] = useState("manager");
  const [sendContent, setSendContent] = useState("");
  const [injectRole, setInjectRole] = useState("");
  const [injectMessage, setInjectMessage] = useState("");

  useEffect(() => {
    if (hilSession) {
      setSendRole((r) =>
        hilSession.roles.some((x) => x.roleId === r)
          ? r
          : (hilSession.roles[0]?.roleId ?? "manager"),
      );
    }
  }, [hilSession?.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadHilSessions();
  }, [loadHilSessions, hilCwd]);

  // ─── No active session: render the create / load form ────────
  if (!hilSession) {
    return (
      <div className="flex flex-col h-full p-3 gap-2 overflow-y-auto">
        <div className="text-sm font-semibold text-fg">
          📌 HIL Blackboard 会话
        </div>
        <p className="text-xs text-fg-2">
          每个会话在 <code className="text-fg">.latte/worktrees/&lt;task-id&gt;</code> 里建一个 git
          worktree，会话历史写到
          <code className="text-fg">.latte/sessions/&lt;id&gt;.json</code>。
          暂停后可继续、可改消息内容。
        </p>
        {hilError && (
          <div className="p-2 bg-err/30 border border-err rounded text-xs text-err whitespace-pre-wrap">
            {hilError}
          </div>
        )}
        <div className="space-y-2 mt-2">
          <label className="block text-[10px] text-fg-3">
            task_id（同一仓库内唯一）
          </label>
          <input
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="fix-redis-bug"
            className="w-full px-2 py-1 bg-control text-fg text-sm rounded border border-edge outline-none focus:border-accent"
          />
          <label className="block text-[10px] text-fg-3">
            初始 prompt（新建会话时填写，已存在会话可忽略）
          </label>
          <textarea
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
            placeholder="Redis 池在 5xx 之后没有回收"
            rows={3}
            className="w-full px-2 py-1 bg-control text-fg text-sm rounded border border-edge outline-none focus:border-accent resize-none"
          />
          <button
            type="button"
            onClick={() =>
              void startOrLoadHilSession(taskId.trim(), initialPrompt.trim())
            }
            disabled={hilBusy || !taskId.trim()}
            className="px-3 py-1 bg-ok hover:bg-ok text-white text-xs rounded disabled:opacity-50"
          >
            {hilBusy ? "..." : "打开 / 新建"}
          </button>
        </div>

        {hilSessionList.length > 0 && (
          <div className="mt-4 border-t border-edge pt-2">
            <div className="text-[10px] text-fg-3 mb-1">
              已存在的会话（按更新时间排序）
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {hilSessionList.map((s) => (
                <button
                  key={s.taskId}
                  type="button"
                  onClick={() => {
                    setTaskId(s.taskId);
                    void startOrLoadHilSession(s.taskId, "");
                  }}
                  className="w-full text-left px-2 py-1 bg-surface-3 hover:bg-control rounded text-[11px]"
                >
                  <div className="text-fg">
                    📌 {s.taskId}{" "}
                    <span
                      className={
                        "ml-1 text-[9px] px-1 rounded " +
                        (s.state === "paused"
                          ? "bg-warn text-warn"
                          : s.state === "done"
                            ? "bg-control text-fg"
                            : "bg-surface text-fg-2")
                      }
                    >
                      {s.state}
                    </span>
                  </div>
                  <div className="text-[9px] text-fg-3">
                    {s.updatedAt} · {s.worktreeRoot}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Active session: render transcript + controls ───────────
  return (
    <div className="flex flex-col h-full">
      {/* Session header */}
      <div className="px-3 py-2 bg-surface-2 border-b border-edge flex flex-wrap items-center gap-2 text-xs">
        <span
          className={
            "px-1.5 py-0.5 rounded text-[10px] " +
            (hilSession.state === "paused"
              ? "bg-warn text-warn"
              : hilSession.state === "done" || hilSession.state === "failed"
                ? "bg-control text-fg"
                : "bg-surface text-fg-2")
          }
        >
          {hilSession.state}
        </span>
        <span className="text-fg font-semibold">
          📌 {hilSession.taskId}
        </span>
        <span className="text-[10px] text-fg-3">
          turn #{hilSession.currentTurn}
        </span>
        {hilSession.pausedAt && (
          <span className="text-[10px] text-warn">
            ⏸ since {hilSession.pausedAt} · {hilSession.pauseReason}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hilSession.state !== "paused" &&
            hilSession.state !== "done" &&
            hilSession.state !== "failed" && (
              <button
                type="button"
                onClick={() => void pauseHilSession("editor: 用户手动暂停")}
                disabled={hilBusy}
                className="px-2 py-0.5 bg-warn hover:bg-warn text-white text-[10px] rounded disabled:opacity-50"
              >
                ⏸ 暂停
              </button>
            )}
          {hilSession.state === "paused" && (
            <button
              type="button"
              onClick={() => void resumeHilSession(sendRole, "")}
              disabled={hilBusy}
              className="px-2 py-0.5 bg-ok hover:bg-ok text-white text-[10px] rounded disabled:opacity-50"
            >
              ▶ 继续
            </button>
          )}
          <button
            type="button"
            onClick={() => void abortHilSession()}
            disabled={
              hilBusy ||
              hilSession.state === "done" ||
              hilSession.state === "failed"
            }
            className="px-2 py-0.5 bg-err hover:bg-err text-white text-[10px] rounded disabled:opacity-50"
          >
            ⏹ 中止
          </button>
          <button
            type="button"
            onClick={() => void refreshHilSession()}
            disabled={hilBusy}
            className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg text-[10px] rounded disabled:opacity-50"
            title="从磁盘 JSON 重新读取（用于手动编辑 session JSON 后刷新）"
          >
            ↻ 刷新
          </button>
          <button
            type="button"
            onClick={() => void openHilPlanMd()}
            className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg text-[10px] rounded"
            title="打开 plan.md"
          >
            📄 plan.md
          </button>
          <button
            type="button"
            onClick={() => void openHilSessionJson()}
            className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg text-[10px] rounded"
            title="打开 session JSON（可手编辑）"
          >
            📄 session.json
          </button>
        </div>
      </div>

      {hilError && (
        <div className="mx-3 mt-2 p-2 bg-err/30 border border-err rounded text-xs text-err whitespace-pre-wrap">
          {hilError}
        </div>
      )}

      {/* Per-role transcripts */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {hilSession.roles.length === 0 && (
          <div className="text-xs text-fg-3">
            还没有 role。在下面输入框里给一个 role 发消息即可创建。
          </div>
        )}
        {hilSession.roles.map((role) => (
          <RoleTranscript
            key={role.roleId}
            role={role}
            editable={hilSession.state === "paused"}
            editing={hilEditingMessage}
            onBeginEdit={(idx, content) =>
              beginHilEditMessage(role.roleId, idx, content)
            }
            onUpdateDraft={updateHilEditDraft}
            onCommitEdit={() => void commitHilEditMessage()}
            onCancelEdit={cancelHilEditMessage}
            onDelete={(idx) =>
              void editHilMessageAction(role.roleId, idx, "delete")
            }
          />
        ))}
      </div>

      {/* Send + inject controls */}
      <div className="px-3 py-2 bg-surface-2 border-t border-edge space-y-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-fg-3">发给</span>
          <input
            value={sendRole}
            onChange={(e) => setSendRole(e.target.value)}
            placeholder="role_id (e.g. manager)"
            className="flex-1 min-w-0 px-2 py-0.5 bg-control text-fg text-[11px] rounded border border-edge outline-none focus:border-accent"
          />
        </div>
        <textarea
          value={sendContent}
          onChange={(e) => setSendContent(e.target.value)}
          placeholder={
            hilSession.state === "paused"
              ? "暂停中… 输入内容后点「继续」会把消息附加给上方 role 并 resume"
              : "输入内容点发送 → 追加到上方 role 的 history"
          }
          rows={2}
          className="w-full px-2 py-1 bg-control text-fg text-sm rounded border border-edge outline-none focus:border-accent resize-none"
        />
        <div className="flex items-center gap-2">
          {hilSession.state === "paused" ? (
            <button
              type="button"
              onClick={() => {
                void resumeHilSession(sendRole.trim(), sendContent);
                setSendContent("");
              }}
              disabled={hilBusy || !sendRole.trim()}
              className="px-3 py-1 bg-ok hover:bg-ok text-white text-xs rounded disabled:opacity-50"
            >
              ▶ 继续（可附带消息）
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                void sendHilUserMessage(sendRole.trim(), sendContent);
                setSendContent("");
              }}
              disabled={hilBusy || !sendContent.trim() || !sendRole.trim()}
              className="px-3 py-1 bg-accent hover:bg-accent-2 text-white text-xs rounded disabled:opacity-50"
            >
              发送
            </button>
          )}
          <span className="ml-auto text-[10px] text-fg-3">
            {hilSession.state === "paused"
              ? "暂停中 — 可编辑、可手改 JSON、点继续恢复"
              : "运行中 — 可随时暂停"}
          </span>
        </div>

        {/* @role injection (the CLI's `latte-agent inject` UI) */}
        <div className="border-t border-edge pt-2 space-y-1">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fg-3">注入到</span>
            <input
              value={injectRole}
              onChange={(e) => setInjectRole(e.target.value)}
              placeholder="@role_id"
              className="w-24 px-1 py-0.5 bg-control text-fg text-[10px] rounded border border-edge outline-none focus:border-accent"
            />
            <input
              value={injectMessage}
              onChange={(e) => setInjectMessage(e.target.value)}
              placeholder="注入消息（追加到该 role 的 history，带 [HUMAN @ <ts>] 前缀）"
              className="flex-1 min-w-0 px-2 py-0.5 bg-control text-fg text-[10px] rounded border border-edge outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => {
                void injectToHilRole(injectRole.trim(), injectMessage);
                setInjectMessage("");
              }}
              disabled={
                hilBusy || !injectRole.trim() || !injectMessage.trim()
              }
              className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg text-[10px] rounded disabled:opacity-50"
            >
              @
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoleTranscript({
  role,
  editable,
  editing,
  onBeginEdit,
  onUpdateDraft,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: {
  role: HilRoleHistory;
  editable: boolean;
  editing: { roleId: string; messageIndex: number; draft: string } | null;
  onBeginEdit: (idx: number, content: string) => void;
  onUpdateDraft: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (idx: number) => void;
}) {
  return (
    <div className="border border-edge rounded">
      <div className="px-2 py-1 bg-surface-3 text-[10px] text-fg-2 flex items-center gap-1">
        <span className="font-semibold text-fg">@{role.roleId}</span>
        <span className="text-fg-3">· {role.messages.length} 条</span>
      </div>
      <div className="px-2 py-1 space-y-1">
        {role.messages.length === 0 && (
          <div className="text-[10px] text-fg-3 italic">
            还没有消息
          </div>
        )}
        {role.messages.map((m) => (
          <MessageRow
            key={m.index}
            message={m}
            editable={editable}
            isEditing={
              editing?.roleId === role.roleId &&
              editing?.messageIndex === m.index
            }
            draft={editing?.draft ?? ""}
            onBeginEdit={() => onBeginEdit(m.index, m.content)}
            onUpdateDraft={onUpdateDraft}
            onCommitEdit={onCommitEdit}
            onCancelEdit={onCancelEdit}
            onDelete={() => onDelete(m.index)}
          />
        ))}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  editable,
  isEditing,
  draft,
  onBeginEdit,
  onUpdateDraft,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: {
  message: HilMessage;
  editable: boolean;
  isEditing: boolean;
  draft: string;
  onBeginEdit: () => void;
  onUpdateDraft: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const isUser = message.role === "user";
  return (
    <div
      className={
        "rounded px-2 py-1 text-xs " +
        (isUser
          ? "bg-info border border-edge"
          : "bg-surface-3 border border-edge")
      }
    >
      <div className="flex items-center gap-1 text-[9px] text-fg-3 mb-0.5">
        <span>{isUser ? "👤 user" : "💬 assistant"}</span>
        {message.timestamp && (
          <span className="text-fg-3">· {message.timestamp}</span>
        )}
        {editable && !isEditing && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={onBeginEdit}
              className="px-1 text-fg-2 hover:text-fg"
              title="编辑"
            >
              ✏️
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="px-1 text-fg-2 hover:text-err"
              title="删除"
            >
              🗑
            </button>
          </div>
        )}
      </div>
      {isEditing ? (
        <div className="space-y-1">
          <textarea
            value={draft}
            onChange={(e) => onUpdateDraft(e.target.value)}
            rows={Math.max(2, draft.split("\n").length)}
            className="w-full px-2 py-1 bg-surface text-fg text-xs rounded border border-accent outline-none resize-none"
            autoFocus
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onCommitEdit}
              className="px-2 py-0.5 bg-accent hover:bg-accent-2 text-white text-[10px] rounded"
            >
              保存
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg text-[10px] rounded"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-fg">
          {message.content}
        </pre>
      )}
    </div>
  );
}

// Re-export the state type so the chat panel can read it for
// switch-casing without re-importing from `api/chat`.
export type { HilSessionState };
