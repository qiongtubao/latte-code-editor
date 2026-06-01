import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PaletteHit { kind: "file" | "symbol" | "semantic"; label: string; detail?: string; path?: string; line?: number }

export function CommandPalette({ onPick }: { onPick: (h: PaletteHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!q) { setHits([]); return; }
    const mode = q.startsWith(">") ? "cmd" : q.startsWith("@") ? "symbol" : "file";
    const term = q.replace(/^[>@]/, "");
    invoke<PaletteHit[]>("palette_search", { mode, term, limit: 20 })
      .then(r => { setHits(r); setActive(0); })
      .catch(() => setHits([]));
  }, [q]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-24" role="dialog" aria-label="command palette">
      <div className="w-[480px] bg-zinc-800 border border-zinc-700 rounded shadow-xl">
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") setActive(a => Math.min(hits.length-1, a+1));
            if (e.key === "ArrowUp") setActive(a => Math.max(0, a-1));
            if (e.key === "Enter" && hits[active]) onPick(hits[active]);
            if (e.key === "Escape") onPick({ kind: "file", label: "__close__" });
          }}
          className="w-full bg-transparent px-3 py-2 text-sm outline-none border-b border-zinc-700"
          placeholder="🔍 type to search (>, @ for modes)"
        />
        <ul className="max-h-80 overflow-auto text-sm">
          {hits.map((h, i) => (
            <li key={i}
                className={`px-3 py-1.5 cursor-pointer ${i===active ? "bg-blue-700" : "hover:bg-zinc-700"}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(h)}>
              {h.label} {h.detail && <span className="text-zinc-400 text-xs ml-2">{h.detail}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
