import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CallNode { name: string; file: string; line: number; role: "caller" | "callee" }

export function Drawer({ symbol, onClose, onJump }: { symbol: string | null; onClose: () => void; onJump: (n: CallNode) => void }) {
  const [nodes, setNodes] = useState<CallNode[]>([]);
  useEffect(() => {
    if (!symbol) { setNodes([]); return; }
    // Clear stale entries from a previous symbol so the user doesn't
    // briefly see "foo"'s callers while "bar"'s are still in flight.
    setNodes([]);
    invoke<CallNode[]>("cmd_call_hierarchy", { symbol })
      .then(setNodes)
      .catch((err) => console.error("drawer failed:", err));
  }, [symbol]);
  if (!symbol) return null;
  return (
    <section data-testid="drawer" className="border-t border-zinc-700 bg-zinc-900 h-48 overflow-auto p-2 text-xs font-mono">
      <header className="flex justify-between items-center mb-1">
        <span className="text-zinc-400">▼ Call Hierarchy · {symbol}</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">✕</button>
      </header>
      {nodes.map((n, i) => (
        <div key={i} className="px-2 py-0.5 hover:bg-zinc-800 cursor-pointer"
             onClick={() => onJump(n)}>
          {n.role === "caller" ? "↑" : "↓"} <span className="text-amber-300">{n.role}</span> {n.name} ({n.file}:{n.line})
        </div>
      ))}
    </section>
  );
}
