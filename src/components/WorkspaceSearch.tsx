import { useState, useCallback, useEffect } from "react";
import { openFile } from "../api/commands";
import { useEditorStore } from "../hooks/useEditorStore";
import type { SearchMatch, ReplaceOutcome } from "../api/commands";

interface Props {
  onSearch: (query: string, includeGlob?: string, excludeGlob?: string) => Promise<SearchMatch[]>;
  onReplace?: (query: string, replacement: string, includeGlob?: string, excludeGlob?: string) => Promise<ReplaceOutcome>;
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
  /** 批量替换的待确认范围；null 表示当前没有待确认的替换。 */
  const [pendingReplace, setPendingReplace] = useState<{
    files: number;
    matches: number;
  } | null>(null);
  /** 替换执行后的结果回报（成功 / 部分失败 / 整体失败）。 */
  const [replaceReport, setReplaceReport] = useState<{
    kind: "ok" | "partial" | "error";
    text: string;
  } | null>(null);

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
  /**
   * 请求批量替换：先按当前条件跑一次搜索，拿到权威影响范围后交给用户确认。
   *
   * 刻意不复用 `results`——用户可能改了 query 却没重新搜索，那份范围已过期，
   * 拿它去展示「将替换 N 处」会误导。批量替换写盘且无法撤销，范围必须准确。
   */
  const requestReplaceAll = useCallback(async () => {
    if (!onReplace || !query.trim()) return;
    setLoading(true);
    try {
      const i = includeGlob.trim() || undefined;
      const e = excludeGlob.trim() || undefined;
      const matches = await onSearch(query, i, e);
      setResults(matches);
      if (matches.length === 0) {
        setPendingReplace(null);
        return;
      }
      setPendingReplace({
        files: new Set(matches.map((m) => m.file_path)).size,
        matches: matches.length,
      });
    } catch {
      setPendingReplace(null);
    } finally {
      setLoading(false);
    }
  }, [query, includeGlob, excludeGlob, onReplace, onSearch]);

  const confirmReplaceAll = useCallback(async () => {
    if (!onReplace || !query.trim()) return;
    setPendingReplace(null);
    setReplaceReport(null);
    setLoading(true);
    try {
      const i = includeGlob.trim() || undefined;
      const e = excludeGlob.trim() || undefined;
      const outcome = await onReplace(query, replacement, i, e);
      const files = outcome.replaced.length;
      const count = outcome.replaced.reduce((n, r) => n + r.count, 0);
      setReplaceReport({
        kind: outcome.failed.length > 0 ? "partial" : "ok",
        text:
          outcome.failed.length > 0
            ? `已替换 ${files} 个文件共 ${count} 处；${outcome.failed.length} 个文件写入失败：` +
              outcome.failed.map((f) => `${f.file_path}（${f.error}）`).join("；")
            : `已替换 ${files} 个文件共 ${count} 处`,
      });
      const matches = await onSearch(query, i, e);
      setResults(matches);
    } catch (err) {
      // 不能静默吞掉：替换整体失败时若无反馈，面板一关、loading 一停，
      // 用户会以为替换成功了。
      setReplaceReport({ kind: "error", text: `替换失败：${String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [query, replacement, includeGlob, excludeGlob, onReplace, onSearch]);

  // 任何检索条件或替换内容变动都会让已确认的范围失效，撤回待确认状态，
  // 避免用户看着旧数字点下「确认替换」。
  useEffect(() => {
    setPendingReplace(null);
    setReplaceReport(null);
  }, [query, replacement, includeGlob, excludeGlob]);

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
            onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
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
            <button onClick={requestReplaceAll} disabled={!query.trim() || loading}
              data-testid="replace-all"
              className="px-2 py-1 bg-accent hover:bg-accent text-white rounded text-xs cursor-pointer disabled:opacity-50">Replace All</button>
          </div>
        )}

        {/* 批量替换确认：写盘且不可撤销，必须先让用户看清影响范围 */}
        {showReplace && pendingReplace && (
          <div
            data-testid="replace-confirm"
            className="p-2 space-y-1.5 rounded border"
            style={{ background: "var(--warn-bg)", borderColor: "var(--warn)" }}
          >
            <div className="text-fg text-[11px] leading-snug">
              将在 <span className="font-semibold">{pendingReplace.files}</span> 个文件中替换{" "}
              <span className="font-semibold">{pendingReplace.matches}</span> 处匹配
            </div>
            <div className="text-fg-2 text-[10px] font-mono break-all">
              「{query}」→{" "}
              {replacement ? `「${replacement}」` : "空字符串（将删除匹配内容）"}
            </div>
            <div className="text-[10px]" style={{ color: "var(--warn)" }}>
              直接写入磁盘，无法撤销。
            </div>
            <div className="flex gap-1 pt-0.5">
              <button onClick={confirmReplaceAll} disabled={loading}
                data-testid="replace-confirm-ok"
                className="px-2 py-1 bg-accent hover:bg-accent text-white rounded text-xs cursor-pointer disabled:opacity-50">确认替换</button>
              <button onClick={() => setPendingReplace(null)}
                data-testid="replace-confirm-cancel"
                className="px-2 py-1 bg-control hover:bg-control-hover text-fg border border-edge rounded text-xs cursor-pointer">取消</button>
            </div>
          </div>
        )}

        {/* 替换结果回报：成功计数、部分失败的文件与原因、或整体失败 */}
        {showReplace && replaceReport && (
          <div
            data-testid="replace-report"
            data-kind={replaceReport.kind}
            className="p-2 rounded border text-[10px] leading-snug break-words"
            style={
              replaceReport.kind === "ok"
                ? { background: "var(--surface-3)", borderColor: "var(--edge)", color: "var(--fg-2)" }
                : { background: "var(--warn-bg)", borderColor: "var(--warn)", color: "var(--fg)" }
            }
          >
            {replaceReport.text}
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
