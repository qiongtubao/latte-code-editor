import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PaletteHit { kind: "file" | "symbol" | "semantic"; label: string; detail?: string; path?: string; line?: number }

// Sentinel hit that downstream consumers recognise as a request to close
// the palette rather than to open a file. The label is namespaced to avoid
// collision with any real `label` value the Rust side might emit.
export const CLOSE_HIT: PaletteHit = { kind: "file", label: "__close__" };

const SEARCH_DEBOUNCE_MS = 120;

export function CommandPalette({ onPick, semantic = false }: { onPick: (h: PaletteHit) => void; semantic?: boolean }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounce the IPC call so each keystroke doesn't fire a workspace walk.
  // Cleanup cancels the in-flight timer, so a fast typist only ever sees
  // the final term dispatched.
  useEffect(() => {
    if (!q) { setHits([]); return; }
    const t = setTimeout(() => {
      const mode = q.startsWith(">") ? "cmd" : q.startsWith("@") ? "symbol" : "file";
      const term = q.replace(/^[>@]/, "");
      const promise = semantic && mode === "symbol"
        ? invoke<Array<{ name: string; file: string; line: number; score: number }>>("cmd_semantic_search", { query: term, k: 20 })
            .then((arr): PaletteHit[] => arr.map(h => ({ kind: "semantic", label: h.name, detail: `${h.file}:${h.line}`, path: h.file, line: h.line })))
        : invoke<PaletteHit[]>("palette_search", { mode, term, limit: 20 });
      promise.then(r => { setHits(r); setActive(0); })
        .catch(() => setHits([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, semantic]);

  // Clamp `active` if `hits` shrinks below the current selection.
  const safeActive = Math.min(active, Math.max(0, hits.length - 1));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-24" role="dialog" aria-label="command palette">
      <div className="w-[480px] bg-zinc-800 border border-zinc-700 rounded shadow-xl">
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") setActive(a => Math.min(hits.length - 1, a + 1));
            if (e.key === "ArrowUp") setActive(a => Math.max(0, a - 1));
            if (e.key === "Enter" && hits[safeActive]) onPick(hits[safeActive]);
            if (e.key === "Escape") onPick(CLOSE_HIT);
          }}
          className="w-full bg-transparent px-3 py-2 text-sm outline-none border-b border-zinc-700"
          placeholder="🔍 type to search (>, @ for modes)"
        />
        <ul className="max-h-80 overflow-auto text-sm">
          {hits.map((h, i) => (
            <li key={i}
                data-testid="palette-hit"
                aria-selected={i === safeActive}
                className={`px-3 py-1.5 cursor-pointer ${i === safeActive ? "bg-blue-700" : "hover:bg-zinc-700"}`}
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
