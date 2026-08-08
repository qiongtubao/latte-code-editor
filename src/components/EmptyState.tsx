interface EmptyStateProps {
  onOpen: () => void;
}

export function EmptyState({ onOpen }: EmptyStateProps) {
  return (
    <div
      className="flex items-center justify-center h-full select-none"
      style={{ background: "var(--surface)" }}
    >
      <div className="text-center text-fg-3">
        <p className="text-lg mb-2">Latte Code Editor</p>
        <p className="text-sm mb-6">Open a file to start editing</p>
        <button
          onClick={onOpen}
          className="px-4 py-2 bg-accent hover:bg-accent text-white rounded text-sm transition-colors cursor-pointer"
        >
          Open File
        </button>
        <div className="mt-4 text-xs text-fg-3">
          <p>Ctrl+O: Open file</p>
          <p>Ctrl+S: Save</p>
        </div>
      </div>
    </div>
  );
}
