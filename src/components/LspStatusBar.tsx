/**
 * LSP 状态栏组件（手动触发模式）
 * 
 * 功能：
 * - 实时显示 LSP 状态和内存占用
 * - 点击触发启动/休眠/停止
 * - 右键打开管理菜单
 */

import { useEffect, useState } from "react";
import { useLspStore, detectFileLanguage } from "../hooks/useLspStore";
import { useEditorStore } from "../hooks/useEditorStore";

export function LspStatusBar() {
  const { status, refreshStatus, isRunning, startLsp, stopLsp, hibernateLsp, getTotalMemory } = useLspStore();
  const { filePath } = useEditorStore();
  const [showMenu, setShowMenu] = useState(false);

  // 当前文件语言
  const currentLang = filePath ? detectFileLanguage(filePath) : null;
  const currentLsp = currentLang 
    ? status.find((s) => s.language.toLowerCase() === currentLang)
    : null;

  // 启动时刷新一次状态
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // 计算总内存
  const totalMemory = getTotalMemory();

  // 渲染状态图标
  const getStatusIcon = (state: string) => {
    switch (state) {
      case "running": return "⚡";
      case "hibernated": return "💤";
      case "starting": return "🔄";
      case "error": return "❌";
      default: return "🔌";
    }
  };

  // 点击 LSP 状态
  const handleClick = () => {
    if (!currentLang) return;

    if (!currentLsp || currentLsp.state === "stopped") {
      // 启动 LSP
      void startLsp(currentLang);
    } else if (currentLsp.state === "running") {
      // 打开菜单
      setShowMenu(!showMenu);
    } else if (currentLsp.state === "hibernated") {
      // 唤醒
      void hibernateLsp(currentLang).then(() => wake(currentLang));
    }
  };

  const wake = async (lang: string) => {
    const { wakeLsp } = useLspStore.getState();
    await wakeLsp(lang);
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowMenu(!showMenu);
        }}
        title={
          currentLsp
            ? `LSP ${currentLsp.state}${currentLsp.memory_mb ? ` (${currentLsp.memory_mb} MB)` : ''}`
            : "LSP not started - Click to start"
        }
        className="flex items-center gap-1 px-2 py-0.5 hover:bg-white/10 rounded cursor-pointer"
        style={{ fontSize: '11px' }}
      >
        <span>{currentLsp ? getStatusIcon(currentLsp.state) : "🔌"}</span>
        {currentLsp ? (
          <span>
            {currentLsp.language}
            {currentLsp.memory_mb ? ` ${currentLsp.memory_mb}MB` : ''}
          </span>
        ) : (
          <span className="opacity-70">LSP off</span>
        )}
        {status.length > 0 && (
          <span className="opacity-70 ml-1">| Total: {totalMemory}MB</span>
        )}
      </button>

      {/* 下拉菜单 */}
      {showMenu && currentLsp && (
        <div
          className="absolute right-0 top-full mt-1 bg-surface-3 text-fg rounded shadow-lg z-50 min-w-[200px]"
          onClick={(e) => e.stopPropagation()}
        >
          {currentLsp.state === "running" && (
            <>
              <button
                onClick={() => {
                  void hibernateLsp(currentLang!);
                  setShowMenu(false);
                }}
                className="block w-full text-left px-3 py-1.5 hover:bg-control"
              >
                💤 Hibernate (save memory)
              </button>
              <button
                onClick={() => {
                  void stopLsp(currentLang!);
                  setShowMenu(false);
                }}
                className="block w-full text-left px-3 py-1.5 hover:bg-control"
              >
                ⏹ Stop (free memory)
              </button>
            </>
          )}
          {currentLsp.state === "hibernated" && (
            <button
              onClick={() => {
                void wake(currentLang!);
                setShowMenu(false);
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-control"
            >
              ⚡ Wake
            </button>
          )}
          {currentLsp.state === "stopped" && (
            <button
              onClick={() => {
                void startLsp(currentLang!);
                setShowMenu(false);
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-control"
            >
              ⚡ Start LSP
            </button>
          )}
        </div>
      )}
    </div>
  );
}
