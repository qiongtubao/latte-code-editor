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
import { openWithLineCol } from "../utils/quickOpen";

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
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setFetchError(null);
      return;
    }
    setLoading(true);
    setFetchError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await findFiles(query.trim(), 50);
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
        if (results.length > 0) {
          handleSelect(results[selectedIndex].path);
        } else if (query.trim()) {
          // 无结果时也可以直接回车用 query 作为路径尝试打开
          handleSelect(query.trim());
        }
      }
    },
    [closeModal, selectNext, selectPrev, results, selectedIndex, query, handleSelect],
  );

  if (!open) return null;

  // 取 basename 加路径尾缀的显示（缩短长路径）
  const displayPath = (fullPath: string) => {
    const parts = fullPath.split("/");
    if (parts.length <= 3) return fullPath;
    return parts.slice(0, 2).join("/") + "/…/" + parts.slice(-1);
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
        className="relative z-10 w-[600px] max-w-[90vw] bg-[#1e1e1e] border border-gray-600 rounded-lg shadow-2xl overflow-hidden"
        style={{ maxHeight: "60vh" }}
      >
        {/* 输入框 */}
        <div className="flex items-center border-b border-gray-600">
          <span className="px-3 text-gray-500 select-none">⌕</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a file name + optional :line:col (e.g. main.rs:42)"
            className="flex-1 px-1 py-3 bg-transparent text-gray-200 text-sm outline-none placeholder-gray-600"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* 结果列表 */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(60vh - 56px)" }}>
          {loading && (
            <div className="px-4 py-3 text-gray-500 text-xs">Searching…</div>
          )}
          {fetchError && (
            <div className="px-4 py-3 text-yellow-400 text-xs">{fetchError}</div>
          )}
          {!loading && !fetchError && query.trim() && results.length === 0 && (
            <div className="px-4 py-3 text-gray-500 text-xs">
              No files match "{query.trim()}"
            </div>
          )}
          {results.map((r, i) => {
            const isSelected = i === selectedIndex;
            const { cleanPath, line, col } = parseInline(r.path);
            return (
              <div
                key={r.path + i}
                onClick={() => handleSelect(r.path)}
                className={`flex items-center gap-2 px-4 py-2 text-xs cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-[#094771] text-white"
                    : "text-gray-300 hover:bg-[#2a2d2e]"
                }`}
              >
                <span className="w-4 text-center text-gray-500">📄</span>
                <span className="truncate flex-1">{displayPath(cleanPath)}</span>
                {line != null && (
                  <span className="text-gray-400 shrink-0">{line}</span>
                )}
                <span className="text-gray-500 shrink-0 text-2xs">{r.score}</span>
              </div>
            );
          })}
          <div className="px-4 py-2 text-2xs text-gray-600 border-t border-gray-700 flex items-center gap-3">
            <span>↑↓ navigate</span>
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
