import { useState } from "react";
import { GraphView } from "./GraphView.js";

export interface OutlineNode { name: string; kind: string; line: number }

export function RightPanel({ outline, onSelect }: { outline: OutlineNode[]; onSelect: (n: OutlineNode) => void }) {
  const [tab, setTab] = useState<"outline" | "graph">("outline");
  return (
    <aside className="h-full w-72 border-l border-zinc-700 flex flex-col text-sm">
      <div className="flex gap-1 p-1 border-b border-zinc-700 text-xs">
        {(["outline","graph"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
                  aria-current={tab === t ? "page" : undefined}
                  className={`px-2 py-1 rounded ${tab===t ? "bg-zinc-700" : "hover:bg-zinc-800"}`}>
            {t === "outline" ? "Outline" : "Graph ●"}
          </button>
        ))}
      </div>
      {tab === "outline" ? (
        <ul className="overflow-auto p-1 font-mono text-xs">
          {outline.map((n) => (
            <li key={`${n.name}-${n.line}`} className="px-2 py-0.5 hover:bg-zinc-800 cursor-pointer"
                onClick={() => onSelect(n)}>
              {n.kind === "function" ? "ƒ" : n.kind === "class" ? "◇" : "·"} {n.name}
              <span className="text-zinc-500 ml-2">:{n.line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex-1"><GraphView center={outline[0]?.name ?? ""} /></div>
      )}
    </aside>
  );
}
