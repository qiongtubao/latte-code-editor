import { SAMPLES, type Sample } from "../samples.js";

export function EmptyState({ onOpen }: { onOpen: (sample: Sample) => void }) {
  return (
    <div
      data-testid="empty-state"
      className="h-full flex flex-col items-center justify-center gap-6 bg-zinc-900 text-zinc-200"
    >
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Welcome to Latte</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Open a folder to start, or try a sample:
        </p>
      </div>
      <div className="flex gap-3">
        {SAMPLES.map((s) => (
          <button
            key={s.path}
            data-testid={`sample-chip-${s.name}`}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm font-mono"
            onClick={() => onOpen(s)}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}
