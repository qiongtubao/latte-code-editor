import { useState, useCallback } from "react";
import { openFile } from "../api/commands";
import { useEditorStore } from "../hooks/useEditorStore";
import type { SearchMatch } from "../api/commands";

interface Props {
  onSearch: (query: string, includeGlob?: string, excludeGlob?: string) => Promise<SearchMatch[]>;
  onReplace?: (query: string, replacement: string, includeGlob?: string, excludeGlob?: string) => Promise<{ file_path: string; count: number }[]>;
}

export function WorkspaceSearch({ onSearch, onReplace }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const i = includeGlob.trim() || undefined;
      const e = excludeGlob.trim() || undefined;
      const matches = await onSearch(query, i, e);
      setResults(matches);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, includeGlob, excludeGlob, onSearch]);

  const handleResultClick = useCallback(async (m: SearchMatch) => {
    try {
      const result = await openFile(m.file_path);
      useEditorStore.getState().openFileOrSwitch(result, m.line_number);
    } catch { /* ignore */ }
  }, []);
  const handleReplaceAll = useCallback(async () => {
    if (!onReplace || !query.trim()) return;
    setLoading(true);
    try {
      const i = includeGlob.trim() || undefined;
      const e = excludeGlob.trim() || undefined;
      await onReplace(query, replacement, i, e);
      const matches = await onSearch(query, i, e);
      setResults(matches);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [query, replacement, includeGlob, excludeGlob, onReplace]);

  // Group results by file
  const grouped = new Map<string, SearchMatch[]>();
  for (const m of results) {
    if (!grouped.has(m.file_path)) grouped.set(m.file_path, []);
    grouped.get(m.file_path)!.push(m);
  }

  return (
    <div className="flex flex-col h-full text-xs" style={{ background: "var(--surface-2)" }}>
      {/* Search input */}
      <div className="px-2 pt-2 pb-1 space-y-1">
        <div className="relative">
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder="Search"
            className="w-full px-2 py-1 pr-14 bg-control text-fg border border-edge rounded text-xs outline-none focus:border-accent placeholder-fg-3" />
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
            <button onClick={() => setShowFilters(!showFilters)}
              className="px-1 py-0.5 text-fg-2 hover:text-fg cursor-pointer text-[11px]" title="Toggle filters">∗</button>
            <button onClick={() => setShowReplace(!showReplace)}
              className="px-1 py-0.5 text-fg-2 hover:text-fg cursor-pointer" title="Toggle replace">{showReplace ? "▾" : "▸"}</button>
          </div>
        </div>

        {/* Replace row */}
        {showReplace && (
          <div className="flex gap-1">
            <input type="text" value={replacement} onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace"
              className="flex-1 px-2 py-1 bg-control text-fg border border-edge rounded text-xs outline-none focus:border-accent placeholder-fg-3" />
            <button onClick={handleReplaceAll} disabled={!query.trim() || loading}
              className="px-2 py-1 bg-accent hover:bg-accent text-white rounded text-xs cursor-pointer disabled:opacity-50">Replace All</button>
          </div>
        )}

        {/* Filters row (collapsible, like VS Code) */}
        {showFilters && (
          <div className="space-y-1 pt-1">
            <div className="flex items-center gap-1">
              <span className="text-fg-3 w-12 shrink-0 text-[10px]">files to</span>
              <input type="text" value={includeGlob} onChange={(e) => setIncludeGlob(e.target.value)}
                placeholder="include (e.g. *.ts, src/**)"
                className="flex-1 px-2 py-0.5 bg-control text-fg border border-edge rounded text-[10px] outline-none focus:border-accent placeholder-fg-3" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-fg-3 w-12 shrink-0 text-[10px]">files to</span>
              <input type="text" value={excludeGlob} onChange={(e) => setExcludeGlob(e.target.value)}
                placeholder="exclude (e.g. *.test.ts, vendor/**)"
                className="flex-1 px-2 py-0.5 bg-control text-fg border border-edge rounded text-[10px] outline-none focus:border-accent placeholder-fg-3" />
            </div>
          </div>
        )}
      </div>

      {/* Results count */}
      <div className="px-2 py-1 text-fg-3 text-[10px] border-b border-edge">
        {loading
          ? "Searching..."
          : results.length > 0
            ? results.length >= 500
              ? `${results.length}+ results in ${grouped.size} files — narrowed or use a glob to see all`
              : `${results.length} results in ${grouped.size} files`
            : ""}
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto">
        {Array.from(grouped.entries()).map(([filePath, matches]) => (
          <div key={filePath}>
            <div className="flex items-center px-2 py-1 text-fg-2 hover:bg-surface-3 cursor-pointer" onClick={() => handleResultClick(matches[0])}>
              <span className="mr-1 text-fg-3 shrink-0">📄</span>
              <span className="truncate">{filePath}</span>
              <span className="ml-auto text-fg-3 shrink-0">{matches.length}</span>
            </div>
            {matches.map((m, i) => (
              <div key={i} className="flex items-start px-2 py-0.5 pl-7 hover:bg-surface-3 cursor-pointer" onClick={() => handleResultClick(m)}>
                <span className="text-fg-3 mr-2 shrink-0 w-8 text-right tabular-nums">{m.line_number}</span>
                <span className="text-fg truncate">{m.line_content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
