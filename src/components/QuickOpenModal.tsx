// Quick Open 全局模态（Ctrl+P）
//
// 设计行为类似 VSCode Ctrl+P：
// 1. Ctrl+P 弹出模态浮层，聚焦到 input
// 2. 输入字符调用后端 find_files 模糊搜索文件名
// 3. 键盘上下箭头选中，Enter 打开文件
// 4. path:line:col 语法支持（如 "main.rs:42" 跳 42 行）
// 5. Escape 关闭
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuickOpenStore } from "../hooks/useQuickOpenStore";
import { findFiles } from "../api/workspace";
import { openWithLineCol, parseLineCol } from "../utils/quickOpen";

export function QuickOpenModal() {
  const {
    open, query, results, loading, selectedIndex,
    closeModal, setQuery, setResults, setLoading,
    selectNext, selectPrev,
  } = useQuickOpenStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // 打开时聚焦 input
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      // 先清掉上一次的结果
      setResults([]);
    }
  }, [open, setResults]);

  // query 变化 → debounce invoke findFiles
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const raw = query.trim();
    if (!raw) {
      setResults([]);
      setLoading(false);
      setFetchError(null);
      return;
    }
    // 路径:行号:列号 语法：先剥掉 :line:col 再搜文件名
    const { cleanPath } = parseLineCol(raw);
    if (!cleanPath) {
      setResults([]);
      setLoading(false);
      setFetchError(null);
      return;
    }
    setLoading(true);
    setFetchError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await findFiles(cleanPath, 50);
        setResults(results);
      } catch (e) {
        setFetchError(String(e));
        setResults([]);
      }
    }, 80);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, setResults, setLoading]);

  const handleSelect = useCallback(
    async (path: string) => {
      closeModal();
      try {
        await openWithLineCol(path);
      } catch (e) {
        console.error("QuickOpen open failed:", e);
      }
    },
    [closeModal],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selectNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectPrev();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const parsed = parseLineCol(query.trim());
        const suffix =
          parsed.line != null
            ? parsed.col != null
              ? `:${parsed.line}:${parsed.col}`
              : `:${parsed.line}`
            : "";
        if (results.length > 0) {
          handleSelect(results[selectedIndex].path + suffix);
        } else if (query.trim()) {
          handleSelect(query.trim());
        }
      }
    },
    [closeModal, selectNext, selectPrev, results, selectedIndex, query, handleSelect],
  );

  if (!open) return null;


  // 取 basename + 路径尾缀的显示（缩短长路径，保留尾段）
  const displayPath = (fullPath: string) => {
    const parts = fullPath.split("/").filter((p) => p.length > 0);
    const base = parts.pop() ?? "";
    if (parts.length === 0) return base;
    if (parts.length <= 2) return parts.join("/") + "/" + base;
    return parts[0] + "/…/" + parts.slice(-2).join("/") + "/" + base;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      {/* 半透明遮罩 */}
      <div className="fixed inset-0 bg-black/30" />

      {/* 模态面板 */}
      <div
        className="relative z-10 w-[600px] max-w-[90vw] bg-surface border border-edge rounded-lg shadow-2xl overflow-hidden"
        style={{ maxHeight: "60vh" }}
      >
        {/* 输入框 */}
        <div className="flex items-center border-b border-edge">
          <span className="px-3 text-fg-3 select-none">⌕</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a file name + optional :line:col (e.g. main.rs:42)"
            className="flex-1 px-1 py-3 bg-transparent text-fg text-sm outline-none placeholder-fg-3"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* 结果列表 */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(60vh - 56px)" }}>
          {loading && (
            <div className="px-4 py-3 text-fg-3 text-xs">Searching…</div>
          )}
          {fetchError && (
            <div className="px-4 py-3 text-warn text-xs">{fetchError}</div>
          )}
          {!loading && !fetchError && query.trim() && results.length === 0 && (
            <div className="px-4 py-3 text-fg text-xs">
              No files match "{query.trim()}"
            </div>
          )}
          {(() => {
            const parsed = parseLineCol(query.trim());
            const suffix =
              parsed.line != null
                ? parsed.col != null
                  ? `:${parsed.line}:${parsed.col}`
                  : `:${parsed.line}`
                : "";
            return results.map((r, i) => {
              const isSelected = i === selectedIndex;
              return (
                <div
                  key={r.path + i}
                  onClick={() => handleSelect(r.path + suffix)}
                  className={`flex items-center gap-2 px-4 py-2 text-xs cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-info text-white"
                      : "text-fg hover:bg-surface-3"
                  }`}
                >
                  <span className="w-4 text-center text-fg-3">📄</span>
                  <span className="truncate flex-1">{displayPath(r.path)}</span>
                  {parsed.line != null && (
                    <span className="text-accent-2 shrink-0 font-medium">{parsed.line}</span>
                  )}
                  <span className="text-fg-2 shrink-0 text-2xs">{r.score}</span>
                </div>
              );
            });
          })()}
          <div className="px-4 py-2 text-2xs text-fg-2 border-t border-edge flex items-center gap-3">
            <span>↵ open</span>
            <span>Esc close</span>
            <span className="ml-auto">path:line:col supported</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 轻量 inline 解析（避免 import 循环） */
function parseInline(path: string): { cleanPath: string; line: number | null; col: number | null } {
  if (!path.includes(":")) return { cleanPath: path, line: null, col: null };
  // 移除尾部的 :line 或 :line:col
  const m = path.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (m) {
    return {
      cleanPath: m[1],
      line: parseInt(m[2], 10),
      col: m[3] ? parseInt(m[3], 10) : null,
    };
  }
  return { cleanPath: path, line: null, col: null };
}
