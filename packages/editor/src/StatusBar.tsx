export function StatusBar({
  language, dirty, indexing, indexed
}: { language: string; dirty: boolean; indexing: boolean; indexed: number }) {
  return (
    <div className="h-6 px-3 flex items-center justify-between text-[11px] bg-zinc-800 text-zinc-300 border-t border-zinc-700">
      <div className="flex items-center gap-3">
        <span>{language}</span>
        {dirty && <span title="uncommitted changes" className="text-amber-400">●</span>}
      </div>
      <div className="flex items-center gap-3">
        {indexing
          ? <span className="text-amber-300">indexing…</span>
          : <span>{indexed} files indexed</span>}
      </div>
    </div>
  );
}
