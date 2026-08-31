/**
 * LSP 管理面板
 * 列出所有 LSP 状态，提供详细控制
 */

import { useEffect } from "react";
import { useLspStore } from "../hooks/useLspStore";

export function LspManagerPanel({ onClose }: { onClose: () => void }) {
  const {
    status,
    refreshStatus,
    startLsp,
    stopLsp,
    hibernateLsp,
    wakeLsp,
    stopAll,
    getTotalMemory,
  } = useLspStore();


  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const getStateColor = (state: string) => {
    switch (state) {
      case "running": return "var(--ok)";
      case "hibernated": return "var(--warn)";
      case "error": return "var(--err)";
      default: return "var(--fg-2)";
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface-2 text-fg rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">LSP Manager</h2>
          <button onClick={onClose} className="text-fg-2 hover:text-fg">
            ✕
          </button>
        </div>

        <div className="text-xs text-fg-2 mb-4">
          Manual trigger mode - LSP starts only when you explicitly request it
        </div>

        {/* 列表 */}
        <div className="space-y-2 mb-4">
          {status.length === 0 ? (
            <div className="text-fg-3 text-center py-8">
              No LSP running. All resources are free.
            </div>
          ) : (
            status.map((lsp) => (
              <div
                key={lsp.language}
                className="flex items-center justify-between bg-surface-3 rounded p-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: getStateColor(lsp.state) }}
                  />
                  <div>
                    <div className="font-medium">{lsp.language}</div>
                    <div className="text-xs text-fg-2">
                      {lsp.state}
                      {lsp.memory_mb ? ` • ${lsp.memory_mb} MB` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {lsp.state === "stopped" && (
                    <button
                      onClick={() => startLsp(lsp.language)}
                      className="px-3 py-1 bg-accent hover:bg-accent rounded text-sm"
                    >
                      Start
                    </button>
                  )}
                  {lsp.state === "running" && (
                    <>
                      <button
                        onClick={() => hibernateLsp(lsp.language)}
                        className="px-3 py-1 bg-warn hover:bg-warn rounded text-sm"
                      >
                        Hibernate
                      </button>
                      <button
                        onClick={() => stopLsp(lsp.language)}
                        className="px-3 py-1 bg-err hover:bg-err rounded text-sm"
                      >
                        Stop
                      </button>
                    </>
                  )}
                  {lsp.state === "hibernated" && (
                    <button
                      onClick={() => wakeLsp(lsp.language)}
                      className="px-3 py-1 bg-ok hover:bg-ok rounded text-sm"
                    >
                      Wake
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 统计信息 */}
        <div className="border-t border-edge pt-4">
          <div className="flex justify-between items-center text-sm">
            <div>
              <span className="text-fg-2">Total Memory: </span>
              <span className="font-bold">{getTotalMemory()} MB</span>
            </div>
            {status.length > 0 && (
              <button
                onClick={stopAll}
                className="px-4 py-1 bg-err hover:bg-err rounded text-sm"
              >
                Stop All
              </button>
            )}
          </div>
        </div>

        {/* 使用说明 */}
        <div className="mt-4 text-xs text-fg-3 border-t border-edge pt-3">
          <div className="font-semibold mb-1">Keyboard Shortcuts:</div>
          <ul className="space-y-0.5">
            <li>• Ctrl+L / Cmd+L: Start LSP for current file</li>
            <li>• Ctrl+Shift+M: Open this panel</li>
            <li>• Ctrl+Alt+H: Hibernate current LSP</li>
            <li>• Ctrl+Alt+S: Stop current LSP</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
