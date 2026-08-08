import { useState } from "react";

interface Props {
  event: string;
  ctx: Record<string, unknown>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DebugDangerConfirmModal({
  event,
  ctx,
  onConfirm,
  onCancel,
}: Props) {
  const [ack, setAck] = useState(false);
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-surface-2 text-fg rounded-lg p-5 w-[440px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold mb-2 text-err">⚠ 危险操作确认</h3>
        <p className="text-sm mb-1">
          <b>事件:</b> <code>{event}</code>
        </p>
        <p className="text-sm mb-2">
          <b>参数:</b>{" "}
          <code className="text-xs break-all">
            {JSON.stringify(ctx, null, 2)}
          </code>
        </p>
        <p className="text-sm text-err mb-3">此操作不可逆。</p>
        <label className="flex items-center gap-2 text-sm mb-3 select-none">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          我了解此操作的后果
        </label>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 bg-control rounded hover:bg-control"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={!ack}
            className="px-3 py-1 bg-err text-white rounded hover:bg-err disabled:opacity-50"
          >
            确认触发
          </button>
        </div>
      </div>
    </div>
  );
}
