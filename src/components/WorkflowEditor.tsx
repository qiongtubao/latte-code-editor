/**
 * 工作流编辑器（中文 UI）
 *
 * 一个模态对话框，用来：
 * - 编辑现有工作流（基础信息 + 每步角色）
 * - 新建工作流（带默认两步）
 * - 删除工作流（内置预设不可删）
 *
 * 编辑过程中所有改动只保存在内存里（store 的 `editingWorkflow`）。
 * 点 💾 保存 才写回 roles.yaml；按 Esc / 取消 则丢弃。
 *
 * 步骤编辑模式：每个步骤支持多角色（v1 顺序发言）。
 * 角色下拉展示 `availableRoles`（来自 chat_get_role_config），
 * 中文名 + 图标。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../hooks/useChatStore";
import type { RoleInfo, WorkflowPayload, WorkflowStep } from "../api/chat";

interface Props {
  /** Optional role list. When omitted the editor reads from `useChatStore`. */
  availableRoles?: RoleInfo[];
  /** Override close handler (used by tests). */
  onClose?: () => void;
}

/**
 * Editor modal for one workflow.
 *
 * `useChatStore` is the source of truth for the editing workflow —
 * the editor reads + dispatches patches through `patchEditingWorkflow`,
 * `patchEditingStep`, `addEditingStep`, `removeEditingStep`,
 * `moveEditingStep`, `saveEditingWorkflow`, `deleteEditingWorkflow`,
 * `closeWorkflowEditor`.
 */
export function WorkflowEditor({ availableRoles, onClose }: Props) {
  const editing = useChatStore((s) => s.editingWorkflow);
  const dirty = useChatStore((s) => s.editingDirty);
  const saving = useChatStore((s) => s.editingSaving);
  const error = useChatStore((s) => s.editingError);
  const roles = useChatStore((s) => s.availableRoles);
  const workflowList = useChatStore((s) => s.availableWorkflows);

  const patch = useChatStore((s) => s.patchEditingWorkflow);
  const patchStep = useChatStore((s) => s.patchEditingStep);
  const addStep = useChatStore((s) => s.addEditingStep);
  const removeStep = useChatStore((s) => s.removeEditingStep);
  const moveStep = useChatStore((s) => s.moveEditingStep);
  const save = useChatStore((s) => s.saveEditingWorkflow);
  const del = useChatStore((s) => s.deleteEditingWorkflow);
  const reset = useChatStore((s) => s.resetRolesToDefaults);
  const close = useChatStore((s) => s.closeWorkflowEditor);

  const source = availableRoles ?? roles;

  const isProtected = useMemo(() => {
    if (!editing) return false;
    return ["default", "plan", "code_review", "debug"].includes(editing.id);
  }, [editing]);

  const isDuplicateId = useMemo(() => {
    if (!editing) return false;
    // When editing an existing workflow, the id matches itself; only
    // flag a true duplicate (different workflow with the same id).
    return workflowList.some(
      (w) => w.id === editing.id && editingOriginalIdRef.current !== editing.id,
    );
  }, [editing, workflowList]);

  // Track the id of the workflow we opened the editor for, so the
  // duplicate-id check above doesn't flag the currently-open workflow
  // as "duplicate of itself" right after a save.
  const editingOriginalIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingOriginalIdRef.current = editing?.id ?? null;
  }, [editing?.id]);

  if (!editing) return null;

  const closeEditor = () => {
    if (dirty && !confirm("有未保存的改动，确定关闭吗？")) return;
    close();
    onClose?.();
  };

  const handleSave = async () => {
    await save();
    // Save does NOT close the editor — the user might want to verify
    // the result. Explicit ✕ closes.
  };
  const handleDelete = async () => {
    if (isProtected) return;
    if (!confirm(`确定删除工作流「${editing.name}」吗？此操作不可撤销。`)) {
      return;
    }
    await del();
    onClose?.();
  };

  const handleReset = async () => {
    if (
      !confirm(
        "将覆盖 roles.yaml，重置为中文默认（10 个角色 + 5 个工作流）。\n" +
          "继续？",
      )
    ) {
      return;
    }
    await reset();
    onClose?.();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="工作流编辑器"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onKeyDown={(e) => {
        if (e.key === "Escape") closeEditor();
      }}
    >
      <div
        className="w-[640px] max-h-[85vh] flex flex-col bg-[#1e1e1e] border border-gray-700 rounded-lg shadow-2xl text-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-3 bg-[#252526] border-b border-gray-700">
          <span className="text-base mr-2">⚙️</span>
          <span className="font-semibold text-sm flex-1">
            {isDuplicateId
              ? "工作流编辑器 — ⚠️ id 与已有工作流冲突"
              : "工作流编辑器"}
          </span>
          <button
            onClick={handleReset}
            className="text-yellow-300 hover:text-yellow-200 text-[11px] px-2 py-0.5 mr-2 rounded hover:bg-yellow-900/30"
            title="覆盖 roles.yaml，重置为中文默认"
            type="button"
          >
            🔄 重置为中文默认
          </button>
          <button
            onClick={closeEditor}
            className="text-gray-400 hover:text-gray-200 text-sm px-2"
            title="关闭 (Esc)"
            type="button"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
          <BasicFields
            editing={editing}
            patch={patch}
            isDuplicateId={isDuplicateId}
          />

          <StepsSection
            editing={editing}
            patchStep={patchStep}
            addStep={addStep}
            removeStep={removeStep}
            moveStep={moveStep}
            source={source}
          />

          {editing.kind === "swarm" && (
            <SwarmFields editing={editing} patch={patch} source={source} />
          )}
          {editing.kind === "manager_led" && (
            <ManagerFields editing={editing} patch={patch} source={source} />
          )}
        </div>
        {error && (
          <div className="mx-4 mb-2 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-200">
            <div className="font-semibold mb-1">⚠️ {error}</div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 bg-[#252526] border-t border-gray-700">
          <button
            onClick={handleSave}
            disabled={saving || isDuplicateId}
            className="px-3 py-1 bg-[#007acc] hover:bg-[#1f8ad2] text-white text-xs rounded disabled:opacity-50"
            type="button"
          >
            {saving ? "保存中…" : dirty ? "💾 保存 *" : "💾 保存"}
          </button>
          <button
            onClick={closeEditor}
            className="px-3 py-1 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-200 text-xs rounded"
            type="button"
          >
            取消
          </button>
          <span className="text-[10px] text-gray-500">
            {dirty ? "有未保存的改动" : "已保存"}
          </span>
          <div className="ml-auto">
            <button
              onClick={handleDelete}
              disabled={isProtected || saving}
              className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded disabled:opacity-30"
              title={
                isProtected
                  ? "内置工作流不可删除"
                  : "删除此工作流（不可撤销）"
              }
              type="button"
            >
              🗑 删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function BasicFields({
  editing,
  patch,
  isDuplicateId,
}: {
  editing: WorkflowPayload;
  patch: (p: Partial<WorkflowPayload>) => void;
  isDuplicateId: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <div className="text-gray-400">工作流 id（英文，用于 YAML）</div>
          <input
            value={editing.id}
            onChange={(e) => patch({ id: e.target.value.trim() })}
            disabled={["default", "plan", "code_review", "debug"].includes(editing.id)}
            className={
              "w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border outline-none focus:border-[#007acc] " +
              (isDuplicateId ? "border-red-500" : "border-gray-600")
            }
            placeholder="例如：code_review_v2"
          />
          {isDuplicateId && (
            <div className="text-[10px] text-red-400">
              ⚠️ id 与已有工作流冲突，请换一个
            </div>
          )}
        </label>
        <label className="space-y-1">
          <div className="text-gray-400">显示名称（中文）</div>
          <input
            value={editing.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
            placeholder="例如：🔍 代码审查 v2"
          />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1">
          <div className="text-gray-400">工作流类型</div>
          <select
            value={editing.kind}
            onChange={(e) =>
              patch({ kind: e.target.value as "planned" | "swarm" })
            }
            className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
          >
            <option value="planned">💬 计划型 — 固定步骤</option>
            <option value="swarm">🪄 智能型 — 计划者编排</option>
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-gray-400">
            {editing.kind === "swarm"
              ? "每轮轮数（保留位）"
              : "每步重复轮数"}
          </div>
          <input
            type="number"
            min={1}
            max={10}
            value={editing.maxRounds}
            onChange={(e) =>
              patch({ maxRounds: Math.max(1, Number(e.target.value) || 1) })
            }
            className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
          />
        </label>
        <label className="space-y-1">
          <div className="text-gray-400">
            {editing.kind === "swarm" ? "最多生成多少步" : "备用：每步发言角色"}
          </div>
          <input
            type="number"
            min={1}
            max={20}
            value={editing.kind === "swarm" ? editing.maxSteps : 0}
            onChange={(e) => {
              const v = Math.max(1, Number(e.target.value) || 1);
              if (editing.kind === "swarm") patch({ maxSteps: v });
            }}
            disabled={editing.kind !== "swarm"}
            className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc] disabled:opacity-50"
          />
        </label>
      </div>
    </div>
  );
}

function StepsSection({
  editing,
  patchStep,
  addStep,
  removeStep,
  moveStep,
  source,
}: {
  editing: WorkflowPayload;
  patchStep: (
    index: number,
    patch: Partial<{ name: string; roles: string[] }>,
  ) => void;
  addStep: () => void;
  removeStep: (index: number) => void;
  moveStep: (index: number, direction: -1 | 1) => void;
  source: RoleInfo[];
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center">
        <div className="font-semibold text-gray-300 flex-1">
          流程步骤（按顺序）
        </div>
        <button
          onClick={addStep}
          className="px-2 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-200 text-[11px] rounded"
          type="button"
        >
          ＋ 添加步骤
        </button>
      </div>
      {editing.steps.length === 0 ? (
        <div className="text-gray-500 italic p-2 bg-[#252526] rounded">
          暂无步骤 —— 保存后将按顺序执行下方默认角色列表。
        </div>
      ) : (
        <ol className="space-y-2 list-none pl-0">
          {editing.steps.map((step, idx) => (
            <StepEditor
              key={idx}
              step={step}
              index={idx}
              total={editing.steps.length}
              roles={source}
              patchStep={patchStep}
              removeStep={removeStep}
              moveStep={moveStep}
            />
          ))}
        </ol>
      )}
      {editing.steps.length > 0 && editing.steps.length > 0 && (
        <details className="text-[10px] text-gray-500">
          <summary className="cursor-pointer hover:text-gray-400">
            默认角色列表（步骤为空时使用）
          </summary>
          <div className="mt-1 pl-2">
            {editing.roles.length === 0
              ? "（无）"
              : editing.roles.map((r) => r).join("、")}
          </div>
        </details>
      )}
    </div>
  );
}

function StepEditor({
  step,
  index,
  total,
  roles,
  patchStep,
  removeStep,
  moveStep,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  roles: RoleInfo[];
  patchStep: (
    i: number,
    p: Partial<{ name: string; roles: string[] }>,
  ) => void;
  removeStep: (i: number) => void;
  moveStep: (i: number, d: -1 | 1) => void;
}) {
  return (
    <li className="bg-[#252526] border border-gray-700 rounded p-2 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-gray-500 text-[10px] w-6">
          {index + 1}.
        </span>
        <input
          value={step.name}
          onChange={(e) => patchStep(index, { name: e.target.value })}
          placeholder="步骤名称（中文，如：需求澄清）"
          className="flex-1 px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => moveStep(index, -1)}
            disabled={index === 0}
            className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-200 text-[10px] rounded disabled:opacity-30"
            title="上移"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => moveStep(index, 1)}
            disabled={index === total - 1}
            className="px-1.5 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-200 text-[10px] rounded disabled:opacity-30"
            title="下移"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => removeStep(index)}
            className="px-1.5 py-0.5 bg-red-900 hover:bg-red-700 text-white text-[10px] rounded"
            title="删除步骤"
          >
            ✕
          </button>
        </div>
      </div>

      <RolePicker
        selected={step.roles}
        roles={roles}
        onChange={(next) => patchStep(index, { roles: next })}
      />
    </li>
  );
}

function RolePicker({
  selected,
  roles,
  onChange,
}: {
  selected: string[];
  roles: RoleInfo[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) => {
    onChange(
      selected.includes(id)
        ? selected.filter((r) => r !== id)
        : [...selected, id],
    );
  };
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => {
        const on = selected.includes(r.id);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => toggle(r.id)}
            className={
              "px-2 py-0.5 text-[11px] rounded border " +
              (on
                ? "bg-[#007acc] border-[#007acc] text-white"
                : "bg-[#2a2a2a] border-gray-600 text-gray-300 hover:border-gray-400")
            }
            title={r.id}
          >
            {r.icon} {r.name}
          </button>
        );
      })}
    </div>
  );
}

function SwarmFields({
  editing,
  patch,
  source,
}: {
  editing: WorkflowPayload;
  patch: (p: Partial<WorkflowPayload>) => void;
  source: RoleInfo[];
}) {
  return (
    <div className="space-y-2">
      <div className="font-semibold text-gray-300">智能型（Swarm）专属设置</div>
      <label className="space-y-1 block">
        <div className="text-gray-400">
          计划者角色（拆分任务、最后综合的角色）
        </div>
        <select
          value={editing.plannerRole}
          onChange={(e) => patch({ plannerRole: e.target.value })}
          className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
        >
          <option value="">— 默认：工程经理 —</option>
          {source.map((r) => (
            <option key={r.id} value={r.id}>
              {r.icon} {r.name}（{r.id}）
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1">
        <div className="text-gray-400">
          可被选为工作者的角色（不勾选则所有角色都可被选中）
        </div>
        <RolePicker
          selected={editing.workerRoles}
          roles={source}
          onChange={(next) => patch({ workerRoles: next })}
        />
      </div>
    </div>
  );
}

function ManagerFields({
  editing,
  patch,
  source,
}: {
  editing: WorkflowPayload;
  patch: (p: Partial<WorkflowPayload>) => void;
  source: RoleInfo[];
}) {
  return (
    <div className="space-y-2">
      <div className="font-semibold text-gray-300">管理者主导（Manager-led）专属设置</div>
      <label className="space-y-1 block">
        <div className="text-gray-400">
          负责人角色（让谁当 manager 来拆解任务）
        </div>
        <select
          value={editing.managerRole || ""}
          onChange={(e) => patch({ managerRole: e.target.value })}
          className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
        >
          <option value="">— 默认：工程经理 —</option>
          {source
            .filter((r) => r.id !== "manager")
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.icon} {r.name}（{r.id}）
              </option>
            ))}
          {/* Built-in manager role is always available */}
          <option value="manager">👔 工程经理（manager）</option>
        </select>
        <div className="text-[10px] text-gray-500 italic">
          推荐：manager / tech_director。负责人会用自己配置的模型链和提示词做实时决策。
        </div>
      </label>
      <div className="space-y-1">
        <div className="text-gray-400">
          初始可调度角色（负责人第一轮默认看到的候选名单；不勾选则全部可用）
        </div>
        <RolePicker
          selected={editing.initialWorkers}
          roles={source}
          onChange={(next) => patch({ initialWorkers: next })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 block">
          <div className="text-gray-400">总轮数上限</div>
          <input
            type="number"
            min={1}
            max={64}
            value={editing.maxTotalSteps}
            onChange={(e) =>
              patch({ maxTotalSteps: Math.max(1, Number(e.target.value) || 1) })
            }
            className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
          />
        </label>
        <label className="space-y-1 block">
          <div className="text-gray-400">用户决策轮数上限</div>
          <input
            type="number"
            min={0}
            max={32}
            value={editing.maxUserDecisions}
            onChange={(e) =>
              patch({ maxUserDecisions: Math.max(0, Number(e.target.value) || 0) })
            }
            className="w-full px-2 py-1 bg-[#2a2a2a] text-gray-200 text-xs rounded border border-gray-600 outline-none focus:border-[#007acc]"
          />
        </label>
      </div>
    </div>
  );
}
