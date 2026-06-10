/**
 * LSP 管理面板
 * 列出所有 LSP 状态，提供详细控制
 */

import { useEffect, useState } from "react";
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

  const [autoStart, setAutoStart] = useState(false);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const getStateColor = (state: string) => {
    switch (state) {
      case "running": return "#4ade80";
      case "hibernated": return "#facc15";
      case "error": return "#f87171";
      default: return "#9ca3af";
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 text-white rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">LSP Manager</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        </div>

        <div className="text-xs text-gray-400 mb-4">
          Manual trigger mode - LSP starts only when you explicitly request it
        </div>

        {/* 列表 */}
        <div className="space-y-2 mb-4">
          {status.length === 0 ? (
            <div className="text-gray-500 text-center py-8">
              No LSP running. All resources are free.
            </div>
          ) : (
            status.map((lsp) => (
              <div
                key={lsp.language}
                className="flex items-center justify-between bg-gray-800 rounded p-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: getStateColor(lsp.state) }}
                  />
                  <div>
                    <div className="font-medium">{lsp.language}</div>
                    <div className="text-xs text-gray-400">
                      {lsp.state}
                      {lsp.memory_mb ? ` • ${lsp.memory_mb} MB` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {lsp.state === "stopped" && (
                    <button
                      onClick={() => startLsp(lsp.language)}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm"
                    >
                      Start
                    </button>
                  )}
                  {lsp.state === "running" && (
                    <>
                      <button
                        onClick={() => hibernateLsp(lsp.language)}
                        className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 rounded text-sm"
                      >
                        Hibernate
                      </button>
                      <button
                        onClick={() => stopLsp(lsp.language)}
                        className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm"
                      >
                        Stop
                      </button>
                    </>
                  )}
                  {lsp.state === "hibernated" && (
                    <button
                      onClick={() => wakeLsp(lsp.language)}
                      className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-sm"
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
        <div className="border-t border-gray-700 pt-4">
          <div className="flex justify-between items-center text-sm">
            <div>
              <span className="text-gray-400">Total Memory: </span>
              <span className="font-bold">{getTotalMemory()} MB</span>
            </div>
            {status.length > 0 && (
              <button
                onClick={stopAll}
                className="px-4 py-1 bg-red-700 hover:bg-red-800 rounded text-sm"
              >
                Stop All
              </button>
            )}
          </div>
        </div>

        {/* 使用说明 */}
        <div className="mt-4 text-xs text-gray-500 border-t border-gray-700 pt-3">
          <div className="font-semibold mb-1">Keyboard Shortcuts:</div>
          <ul className="space-y-0.5">
            <li>• Ctrl+L / Cmd+L: Start LSP for current file</li>
            <li>• Ctrl+Shift+L: Open this panel</li>
            <li>• Ctrl+Alt+H: Hibernate current LSP</li>
            <li>• Ctrl+Alt+S: Stop current LSP</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
