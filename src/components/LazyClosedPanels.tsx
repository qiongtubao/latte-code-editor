import { useQuickOpenStore } from "../hooks/useQuickOpenStore";
import {
  createRetryableLoader,
  LazyFeatureBoundary,
} from "./LazyFeatureBoundary";

type CloseProps = { onClose: () => void };
type ChatProps = CloseProps & { onShowGraph: (nodeId: string) => void };

const loadChat = createRetryableLoader<ChatProps>(async () =>
  import("./ChatAgentPanel").then((module) => module.ChatAgentPanel),
);
const loadSettings = createRetryableLoader<CloseProps>(async () =>
  import("./SettingsPanel").then((module) => module.SettingsPanel),
);
const loadDebugInject = createRetryableLoader<CloseProps>(async () =>
  import("./DebugEventInjectModal").then((module) => module.DebugEventInjectModal),
);
const loadQuickOpen = createRetryableLoader<Record<string, never>>(async () =>
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
