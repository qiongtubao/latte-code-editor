import { useEffect, useState } from "react";
import { useDebugStore } from "../utils/debug/store";
import { DebugModuleActions } from "./DebugModuleActions";

interface Props {
  onOpenInject: () => void;
  onSnapshot: () => void;
}

export function DebugBar({ onOpenInject, onSnapshot }: Props) {
  const { isOn, verbose, sid, replayLocks, setOn, setVerbose } = useDebugStore();

  const [locksText, setLocksText] = useState("");

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      const parts: string[] = [];
      replayLocks.forEach((t, k) => {
        const held = ((now - t) / 1000).toFixed(1);
        parts.push(`${k} (${held}s)`);
      });
      setLocksText(parts.join(", "));
    }, 250);
    return () => window.clearInterval(id);
  }, [replayLocks]);

  if (!isOn) return null;

  return (
    <div data-testid="debug-bar" className="fixed bottom-2 right-2 z-50">
      <div className="bg-surface-2/90 text-fg text-xs rounded shadow-lg p-2 w-[420px] font-mono">
        <div className="flex justify-between items-center mb-1">
          <span>
            🛠 DEBUG | sid: {sid} | locks: {replayLocks.size}
            {locksText ? ` (${locksText})` : ""}
          </span>
          <button
            onClick={() => setOn(false)}
            aria-label="close debug"
            className="text-err hover:text-err"
          >
            ✕
          </button>
        </div>
        <div className="flex gap-1 flex-wrap items-center">
          <button
            onClick={onSnapshot}
            className="px-2 py-0.5 bg-accent rounded hover:bg-accent"
          >
            📸 Snapshot
          </button>
          <button
            onClick={onOpenInject}
            className="px-2 py-0.5 bg-accent rounded hover:bg-accent"
          >
            📨 Inject
          </button>
          <label
            className="flex items-center gap-1 text-[10px] text-fg select-none"
            title="When on, also emit level=debug events (file.content, ipc.invoke) — high volume."
          >
            <input
              type="checkbox"
              checked={verbose}
              onChange={(e) => setVerbose(e.target.checked)}
            />
            verbose
          </label>
        </div>
        <DebugModuleActions />
      </div>
    </div>
  );
}
