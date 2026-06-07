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
      useEditorStore.getState().setTargetLine(m.line_number);
      useEditorStore.getState().openFileOrSwitch(result);
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
    <div className="flex flex-col h-full text-xs" style={{ background: "#252526" }}>
      {/* Search input */}
      <div className="px-2 pt-2 pb-1 space-y-1">
        <div className="relative">
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder="Search"
            className="w-full px-2 py-1 pr-14 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded text-xs outline-none focus:border-[#007acc] placeholder-gray-500" />
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
            <button onClick={() => setShowFilters(!showFilters)}
              className="px-1 py-0.5 text-gray-400 hover:text-gray-200 cursor-pointer text-[11px]" title="Toggle filters">∗</button>
            <button onClick={() => setShowReplace(!showReplace)}
              className="px-1 py-0.5 text-gray-400 hover:text-gray-200 cursor-pointer" title="Toggle replace">{showReplace ? "▾" : "▸"}</button>
          </div>
        </div>

        {/* Replace row */}
        {showReplace && (
          <div className="flex gap-1">
            <input type="text" value={replacement} onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace"
              className="flex-1 px-2 py-1 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded text-xs outline-none focus:border-[#007acc] placeholder-gray-500" />
            <button onClick={handleReplaceAll} disabled={!query.trim() || loading}
              className="px-2 py-1 bg-[#0d7acc] hover:bg-[#0b6bb3] text-white rounded text-xs cursor-pointer disabled:opacity-50">Replace All</button>
          </div>
        )}

        {/* Filters row (collapsible, like VS Code) */}
        {showFilters && (
          <div className="space-y-1 pt-1">
            <div className="flex items-center gap-1">
              <span className="text-gray-500 w-12 shrink-0 text-[10px]">files to</span>
              <input type="text" value={includeGlob} onChange={(e) => setIncludeGlob(e.target.value)}
                placeholder="include (e.g. *.ts, src/**)"
                className="flex-1 px-2 py-0.5 bg-[#333] text-gray-200 border border-gray-700 rounded text-[10px] outline-none focus:border-[#007acc] placeholder-gray-600" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-gray-500 w-12 shrink-0 text-[10px]">files to</span>
              <input type="text" value={excludeGlob} onChange={(e) => setExcludeGlob(e.target.value)}
                placeholder="exclude (e.g. *.test.ts, vendor/**)"
                className="flex-1 px-2 py-0.5 bg-[#333] text-gray-200 border border-gray-700 rounded text-[10px] outline-none focus:border-[#007acc] placeholder-gray-600" />
            </div>
          </div>
        )}
      </div>

      {/* Results count */}
      <div className="px-2 py-1 text-gray-500 text-[10px] border-b border-gray-700">
        {loading ? "Searching..." : results.length > 0 ? `${results.length} results in ${grouped.size} files` : ""}
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto">
        {Array.from(grouped.entries()).map(([filePath, matches]) => (
          <div key={filePath}>
            <div className="flex items-center px-2 py-1 text-gray-400 hover:bg-[#2a2d2e] cursor-pointer" onClick={() => handleResultClick(matches[0])}>
              <span className="mr-1 text-gray-600 shrink-0">📄</span>
              <span className="truncate">{filePath}</span>
              <span className="ml-auto text-gray-600 shrink-0">{matches.length}</span>
            </div>
            {matches.map((m, i) => (
              <div key={i} className="flex items-start px-2 py-0.5 pl-7 hover:bg-[#2a2d2e] cursor-pointer" onClick={() => handleResultClick(m)}>
                <span className="text-gray-500 mr-2 shrink-0 w-8 text-right tabular-nums">{m.line_number}</span>
                <span className="text-gray-300 truncate">{m.line_content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
