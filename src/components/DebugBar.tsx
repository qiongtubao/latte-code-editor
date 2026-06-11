import { useEffect, useState } from "react";
import { useDebugStore } from "../utils/debug/store";
import { DebugModuleActions } from "./DebugModuleActions";

interface Props {
  onOpenInject: () => void;
  onSnapshot: () => void;
}

export function DebugBar({ onOpenInject, onSnapshot }: Props) {
  const { isOn, sid, replayLocks, setOn } = useDebugStore();
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
      <div className="bg-gray-900/90 text-white text-xs rounded shadow-lg p-2 w-[420px] font-mono">
        <div className="flex justify-between items-center mb-1">
          <span>
            🛠 DEBUG | sid: {sid} | locks: {replayLocks.size}
            {locksText ? ` (${locksText})` : ""}
          </span>
          <button
            onClick={() => setOn(false)}
            aria-label="close debug"
            className="text-red-300 hover:text-red-100"
          >
            ✕
          </button>
        </div>
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={onSnapshot}
            className="px-2 py-0.5 bg-blue-700 rounded hover:bg-blue-600"
          >
            📸 Snapshot
          </button>
          <button
            onClick={onOpenInject}
            className="px-2 py-0.5 bg-blue-700 rounded hover:bg-blue-600"
          >
            📨 Inject
          </button>
        </div>
        <DebugModuleActions />
      </div>
    </div>
  );
}
