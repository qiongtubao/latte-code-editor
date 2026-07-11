import { useEffect, useState } from "react";
import type { ModelInfo } from "../api/chat";
import { useChatStore } from "../hooks/useChatStore";

interface Props {
  roleId: string;
  icon: string;
  name: string;
  /** Server-side chain (source of truth). When this changes, local
   *  edits are discarded so the UI reflects the persisted state. */
  serverChain: string[];
  availableModels: ModelInfo[];
  /** Persist the new chain. Returns the canonical (deduplicated)
   *  chain from the backend, or `[]` if the save failed. */
  onSave: (chain: string[]) => Promise<string[]>;
}

/**
 * Editor for a single role's priority-ordered model chain.
 *
 * The first row is the primary model; subsequent rows are fallbacks
 * tried in order when earlier models fail (rate-limit, 5xx, network).
 * Saving is triggered explicitly from each handler — the chain is
 * persisted on every reorder / add / remove so users don't need to
 * remember to hit a "Save" button.
 */
export function RoleChainEditor({
  roleId,
  icon,
  name,
  serverChain,
  availableModels,
  onSave,
}: Props) {
  const [chain, setChain] = useState<string[]>(serverChain);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  const openRoleConfig = async () => {
    try {
      const path = await openConfig(`role:${roleId}`);
      const file = await openFile(path);
      useEditorStore.getState().openFileOrSwitch(file);
    } catch (e) {
      console.error(`[chain] open role config failed for '${roleId}':`, e);
    }
  };

  // If the server-side chain changes (e.g. after a save returns a
  // deduped form, or another panel updated it), drop local edits and
  // resync. This keeps the editor honest about persisted state.
  useEffect(() => {
    setChain(serverChain);
  }, [serverChain]);

  const persist = async (next: string[]) => {
    if (next.length === 0) return; // backend rejects empty chains
    setStatus("saving");
    try {
      const persisted = await onSave(next);
      // The backend is the source of truth for the canonical form
      // (e.g. it may dedupe). Reflect it back into local state so
      // the rendered rows match what the next reload will see.
      setChain(persisted);
      setStatus("idle");
    } catch (e) {
      console.error(`[chain] save failed for role '${roleId}':`, e);
      setStatus("error");
    }
  };

  const move = (idx: number, delta: number) => {
    if (idx + delta < 0 || idx + delta >= chain.length) return;
    const next = [...chain];
    [next[idx], next[idx + delta]] = [next[idx + delta], next[idx]];
    setChain(next);
    void persist(next);
  };

  const remove = (idx: number) => {
    if (chain.length <= 1) return; // keep at least one — backend rejects empty
    const next = chain.filter((_, i) => i !== idx);
    setChain(next);
    void persist(next);
  };

  const changeAt = (idx: number, newId: string) => {
    if (!newId || newId === chain[idx]) return;
    const next = [...chain];
    next[idx] = newId;
    setChain(next);
    void persist(next);
  };

  const add = (modelId: string) => {
    if (!modelId || chain.includes(modelId)) return;
    const next = [...chain, modelId];
    setChain(next);
    void persist(next);
  };

  // Only offer models not already in the chain.
  const remaining = availableModels.filter((m) => !chain.includes(m.id));

  return (
    <div className="border border-gray-700 rounded p-1.5 bg-[#1e1e1e]">
      <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-1">
        <span className="font-semibold text-gray-300">
          {icon} {name}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => useChatStore.getState().openConfigFile("roles")}
            className="px-1 text-gray-400 hover:text-white"
            title={`打开 roles/${roleId}.yaml`}
            type="button"
          >
            📄
          </button>
          {status === "saving" ? "💾 …" : status === "error" ? "⚠️" : null}
        </span>
      </div>
      <div className="space-y-1">
        {chain.map((modelId, idx) => (
          <div key={`${idx}-${modelId}`} className="flex items-center gap-1">
            <span className="w-4 text-right text-gray-500 text-[10px]">
              {idx + 1}
            </span>
            <select
              value={modelId}
              onChange={(e) => changeAt(idx, e.target.value)}
              className="flex-1 min-w-0 px-1 py-0.5 bg-[#3a3a3a] text-gray-200 text-[10px] rounded border border-gray-600"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
            <button
              onClick={() => move(idx, -1)}
              disabled={idx === 0}
              title="Move up (higher priority)"
              className="px-1 text-gray-400 hover:text-gray-200 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              onClick={() => move(idx, 1)}
              disabled={idx === chain.length - 1}
              title="Move down (lower priority)"
              className="px-1 text-gray-400 hover:text-gray-200 disabled:opacity-30"
            >
              ↓
            </button>
            <button
              onClick={() => remove(idx)}
              disabled={chain.length <= 1}
              title="Remove from chain"
              className="px-1 text-gray-400 hover:text-red-400 disabled:opacity-30"
            >
              ×
            </button>
          </div>
        ))}
        {remaining.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            <span className="text-[10px] text-gray-500">+</span>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) add(e.target.value);
              }}
              className="flex-1 min-w-0 px-1 py-0.5 bg-[#3a3a3a] text-gray-200 text-[10px] rounded border border-gray-600"
            >
              <option value="">Add fallback…</option>
              {remaining.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
  );
}
