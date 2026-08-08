import { useEffect, useState } from "react";
import { listDebugEvents, debugEmit } from "../utils/debug/inject";
import { DebugDangerConfirmModal } from "./DebugDangerConfirmModal";
import { useDebugStore } from "../utils/debug/store";

interface Props {
  onClose: () => void;
}

const DANGEROUS = new Set<string>([
  "lsp.stop",
  "lsp.stop_all",
  "lsp.hibernate_all",
  "workspace.delete",
  "workspace.delete_all",
  "graph.rebuild",
  "graph.clear",
  "file.save",
  "file.delete",
  "settings.reset_all",
]);

export function DebugEventInjectModal({ onClose }: Props) {
  const events = listDebugEvents();
  const [event, setEvent] = useState<string>(events[0]?.event ?? "");
  const [ctxText, setCtxText] = useState("{}");
  const [pending, setPending] = useState<{
    event: string;
    ctx: Record<string, unknown>;
  } | null>(null);
  const skipConfirm = useDebugStore((s) => s.skipDangerousConfirm);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    let ctx: Record<string, unknown> = {};
    try {
      ctx = JSON.parse(ctxText);
    } catch {
      return;
    }
    if (DANGEROUS.has(event) && !skipConfirm) {
      setPending({ event, ctx });
      return;
    }
    await debugEmit(event, ctx);
    onClose();
  };

  if (pending) {
    return (
      <DebugDangerConfirmModal
        event={pending.event}
        ctx={pending.ctx}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          await debugEmit(pending.event, pending.ctx);
          setPending(null);
          onClose();
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-surface-2 text-fg rounded-lg p-5 w-[520px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold mb-3">📨 事件注入</h3>
        {events.length === 0 ? (
          <p className="text-sm text-fg-3">
            No debug events have been registered yet.
          </p>
        ) : (
          <>
            <label className="block text-sm mb-1">事件</label>
            <select
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              className="w-full border rounded px-2 py-1 mb-3 text-sm"
            >
              {events.map((e) => (
                <option key={e.event} value={e.event}>
                  {e.event}
                  {DANGEROUS.has(e.event) ? " ⚠" : ""}
                  {e.dangerous ? " (dangerous)" : ""}
                </option>
              ))}
            </select>
            <label className="block text-sm mb-1">ctx (JSON)</label>
            <textarea
              value={ctxText}
              onChange={(e) => setCtxText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="w-full h-32 border rounded p-2 font-mono text-xs"
            />
            <p className="text-xs text-fg-3 mt-1">
              Cmd/Ctrl+Enter 触发。⚠ 事件会弹二次确认。
            </p>
          </>
        )}
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1 bg-control rounded hover:bg-control"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!event}
            className="px-3 py-1 bg-accent text-white rounded hover:bg-accent disabled:opacity-50"
          >
            触发
          </button>
        </div>
      </div>
    </div>
  );
}
