// Settings panel — graph auto-update controls.
import { useGraphSettings } from "../hooks/useGraphSettings";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    auto_update_enabled,
    debounce_ms,
    max_files_per_batch,
    low_memory_skip_mb,
    loading,
    setAutoUpdateEnabled,
    setDebounceMs,
    setMaxFilesPerBatch,
    setLowMemorySkipMb,
  } = useGraphSettings();

  return (
    <div className="flex flex-col h-full text-xs" style={{ background: "#252526" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span className="font-medium text-gray-300">Graph Settings</span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-sm leading-none px-1"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {/* Master switch */}
        <label className="flex items-center justify-between gap-2 text-gray-300 cursor-pointer">
          <span>Auto-update on file change</span>
          <input
            type="checkbox"
            checked={auto_update_enabled}
            disabled={loading}
            onChange={(e) => setAutoUpdateEnabled(e.target.checked)}
            className="cursor-pointer"
          />
        </label>

        <p className="text-gray-500 -mt-1">
          When enabled, the graph re-indexes changed files as you type.
          When disabled, the file watcher still runs but changes are
          discarded.
        </p>

        <hr className="border-gray-700" />

        {/* Debounce */}
        <label className="flex items-center justify-between gap-2 text-gray-300">
          <span>Debounce (ms)</span>
          <input
            type="number"
            min={100}
            max={10000}
            step={100}
            value={debounce_ms}
            disabled={loading || !auto_update_enabled}
            onChange={(e) => setDebounceMs(Number(e.target.value))}
            className="w-24 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc] disabled:opacity-50"
          />
        </label>
        <p className="text-gray-500 -mt-2">
          Time to wait after the last file change before starting a
          batch update. Higher values reduce CPU churn when many files
          change at once.
        </p>

        <hr className="border-gray-700" />

        {/* Max files per batch */}
        <label className="flex items-center justify-between gap-2 text-gray-300">
          <span>Max files per batch</span>
          <input
            type="number"
            min={1}
            max={1000}
            step={10}
            value={max_files_per_batch}
            disabled={loading || !auto_update_enabled}
            onChange={(e) => setMaxFilesPerBatch(Number(e.target.value))}
            className="w-24 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc] disabled:opacity-50"
          />
        </label>
        <p className="text-gray-500 -mt-2">
          Batches larger than this are dropped; the user should run a
          manual rebuild. Keeps background work bounded when e.g. a
          branch switch touches thousands of files.
        </p>

        <hr className="border-gray-700" />

        {/* Low memory threshold */}
        <label className="flex items-center justify-between gap-2 text-gray-300">
          <span>Low-memory skip (MB)</span>
          <input
            type="number"
            min={64}
            max={32768}
            step={64}
            value={low_memory_skip_mb}
            disabled={loading || !auto_update_enabled}
            onChange={(e) => setLowMemorySkipMb(Number(e.target.value))}
            className="w-24 px-2 py-0.5 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc] disabled:opacity-50"
          />
        </label>
        <p className="text-gray-500 -mt-2">
          Skip auto-updates when system free memory drops below this
          floor. Only effective on Linux/macOS; unsupported platforms
          are treated as "no opinion" and updates proceed.
        </p>
      </div>
    </div>
  );
}
