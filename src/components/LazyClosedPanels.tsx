import {
  createElement,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
} from "react";
import { useQuickOpenStore } from "../hooks/useQuickOpenStore";

type CloseProps = { onClose: () => void };
type ChatProps = CloseProps & { onShowGraph: (nodeId: string) => void };

export type ComponentLoader<Props extends object> = () => Promise<ComponentType<Props>>;

type LoadState<Props extends object> =
  | { status: "loading" }
  | { status: "ready"; Component: ComponentType<Props> }
  | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cache successful/in-flight imports, but clear failures so Retry can recover. */
function retryable<Props extends object>(
  importer: ComponentLoader<Props>,
): ComponentLoader<Props> {
  let promise: Promise<ComponentType<Props>> | null = null;
  return () => {
    if (!promise) {
      promise = importer().catch((error: unknown) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}

interface LazyFeatureBoundaryProps<Props extends object> {
  loader: ComponentLoader<Props>;
  componentProps: Props;
  label: string;
  fallbackClassName?: string;
  onClose?: () => void;
}

/**
 * Shared runtime boundary for features that are absent on the first screen.
 * It intentionally does not use React.lazy: recreating a rejected lazy type is
 * awkward, while an explicit loader gives the user a reliable retry path.
 */
export function LazyFeatureBoundary<Props extends object>({
  loader,
  componentProps,
  label,
  fallbackClassName = "h-full",
  onClose,
}: LazyFeatureBoundaryProps<Props>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState<Props>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void loader()
      .then((Component) => {
        if (!cancelled) setState({ status: "ready", Component });
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
        aria-label={`Loading ${label}`}
        className={`${fallbackClassName} grid place-items-center bg-surface text-xs text-fg-3`}
      >
        Loading {label}…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className={`${fallbackClassName} grid place-items-center bg-surface px-6 text-xs`}
      >
        <div className="max-w-md text-center">
          <div className="text-warn font-medium">{label} failed to load</div>
          <div className="mt-1 text-fg-3 break-words">{state.message}</div>
          <div className="mt-3 flex justify-center gap-2">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-control px-3 py-1.5 text-fg hover:bg-control-hover cursor-pointer"
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={retry}
              className="rounded bg-accent px-3 py-1.5 text-white hover:opacity-90 cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return createElement(state.Component, componentProps);
}

const loadChat = retryable<ChatProps>(async () =>
  import("./ChatAgentPanel").then((module) => module.ChatAgentPanel),
);
const loadSettings = retryable<CloseProps>(async () =>
  import("./SettingsPanel").then((module) => module.SettingsPanel),
);
const loadDebugInject = retryable<CloseProps>(async () =>
  import("./DebugEventInjectModal").then((module) => module.DebugEventInjectModal),
);
const loadQuickOpen = retryable<Record<string, never>>(async () =>
  import("./QuickOpenModal").then((module) => module.QuickOpenModal),
);

export const preloadChatPanel = () => loadChat();
export const preloadQuickOpen = () => loadQuickOpen();

export function LazyChatPanel(props: ChatProps) {
  return (
    <LazyFeatureBoundary
      loader={loadChat}
      componentProps={props}
      label="chat"
      onClose={props.onClose}
    />
  );
}

export function LazySettingsPanel(props: CloseProps) {
  return (
    <LazyFeatureBoundary
      loader={loadSettings}
      componentProps={props}
      label="Settings"
      onClose={props.onClose}
    />
  );
}

export function LazyDebugInjectModal(props: CloseProps) {
  return (
    <LazyFeatureBoundary
      loader={loadDebugInject}
      componentProps={props}
      label="Debug tools"
      fallbackClassName="fixed inset-0 z-50"
      onClose={props.onClose}
    />
  );
}

export function LazyQuickOpenModal() {
  const closeModal = useQuickOpenStore((state) => state.closeModal);
  return (
    <LazyFeatureBoundary
      loader={loadQuickOpen}
      componentProps={{}}
      label="Quick Open"
      fallbackClassName="fixed inset-0 z-50"
      onClose={closeModal}
    />
  );
}
