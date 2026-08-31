import { useCallback, useEffect, useState, type ComponentType } from "react";
import type { GraphRevealRequest } from "../hooks/graphTypes";

export interface GraphPanelProps {
  folderRoot?: string | null;
  revealRequest?: GraphRevealRequest | null;
  onRevealHandled?: (requestId: number) => void;
}

interface GraphPanelModule {
  GraphPanel: ComponentType<GraphPanelProps>;
}

export type GraphPanelLoader = () => Promise<GraphPanelModule>;

let modulePromise: Promise<GraphPanelModule> | null = null;

/**
 * Start loading the graph subsystem once. A rejected chunk must not remain
 * cached forever: clearing the promise lets the error fallback retry after a
 * transient offline/deployment failure.
 */
export function preloadGraphPanel(): Promise<GraphPanelModule> {
  if (!modulePromise) {
    modulePromise = import("./GraphPanel").catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; Panel: ComponentType<GraphPanelProps> }
  | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runtime boundary for the complete graph UI. App only mounts this component
 * for Graph/Split mode, so D3, graph layout, Canvas renderers, DocGraph and the
 * worker stay out of the editor-first startup path.
 */
export function LazyGraphPanel({
  folderRoot = null,
  revealRequest = null,
  onRevealHandled,
  loader = preloadGraphPanel,
}: GraphPanelProps & { loader?: GraphPanelLoader }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void loader()
      .then(({ GraphPanel }) => {
        if (!cancelled) setState({ status: "ready", Panel: GraphPanel });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, loader]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-label="Loading graph"
        className="h-full grid place-items-center bg-surface text-xs text-fg-3"
      >
        Loading graph…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="h-full grid place-items-center bg-surface px-6 text-xs">
        <div className="max-w-md text-center">
          <div className="text-warn font-medium">Graph failed to load</div>
          <div className="mt-1 text-fg-3 break-words">{state.message}</div>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded bg-control px-3 py-1.5 text-fg hover:bg-control-hover cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <state.Panel
      folderRoot={folderRoot}
      revealRequest={revealRequest}
      onRevealHandled={onRevealHandled}
    />
  );
}
