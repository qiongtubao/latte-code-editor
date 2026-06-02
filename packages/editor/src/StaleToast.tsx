import { useEffect, useState } from "react";

export function StaleToast({ dirtyCount, onRebuild }: { dirtyCount: number; onRebuild: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(dirtyCount > 0); }, [dirtyCount]);
  if (!shown) return null;
  return (
    <div data-testid="stale-toast"
         className="fixed bottom-8 right-4 bg-amber-500 text-zinc-900 px-3 py-2 rounded shadow-lg text-sm flex items-center gap-3">
      <span>{dirtyCount} files changed · graph out of date</span>
      <button onClick={onRebuild} className="underline font-semibold">Rebuild</button>
      <button onClick={() => setShown(false)} aria-label="dismiss">✕</button>
    </div>
  );
}
