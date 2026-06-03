import { useEffect, useRef, useState } from "react";

/**
 * Generic single-input modal. Used by `FileTree` for "New File" / "New
 * Folder" prompts because `@tauri-apps/plugin-dialog` 2.0.0 doesn't
 * expose a JS `prompt()`, and `window.prompt` is disabled inside
 * WKWebView.
 *
 * Behaviour contract:
 *   - Enter submits (calls `onSubmit(value)` if non-empty after trim).
 *   - Esc cancels.
 *   - Click on the backdrop cancels.
 *   - Empty / whitespace-only input is ignored — the modal stays open
 *     and a (separate) `error` message remains visible if set. The
 *     caller is responsible for closing the modal on success.
 *   - The input is auto-focused on open. The focused element is restored
 *     to whatever the document had focused before the modal opened, on
 *     close — so closing via Esc/backdrop doesn't strand focus on a
 *     hidden input.
 */
export interface PromptModalProps {
  open: boolean;
  title: string;
  label: string;
  defaultValue?: string;
  error?: string | null;
  submitLabel?: string;
  cancelLabel?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

export function PromptModal({
  open,
  title,
  label,
  defaultValue = "",
  error = null,
  submitLabel = "OK",
  cancelLabel = "Cancel",
  onCancel,
  onSubmit,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // When opening: snapshot the previously-focused element, then focus
  // the input on the next frame so React has committed the input to the
  // DOM first.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    setValue(defaultValue);
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open, defaultValue]);

  // Esc-to-cancel (only while the modal is open). Bound on `keydown` at
  // the backdrop level so it works even if the input has lost focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to whatever the page had focused before we opened.
      previouslyFocused.current?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => {
    const v = value.trim();
    if (v.length === 0) return; // ignore empty/blank submit
    onSubmit(v);
  };

  return (
    <div
      data-testid="prompt-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        // Backdrop click (not the inner card) cancels. We test the
        // target explicitly so clicking on the card doesn't dismiss.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        data-testid="prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-80 rounded-md bg-zinc-800 border border-zinc-700 shadow-lg p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        <label className="flex flex-col gap-1 text-xs text-zinc-300">
          {label}
          <input
            ref={inputRef}
            data-testid="prompt-modal-input"
            type="text"
            className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-zinc-400"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        {error !== null && error.length > 0 && (
          <div
            data-testid="prompt-modal-error"
            className="text-xs text-red-400 whitespace-pre-wrap break-words"
          >
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-1">
          <button
            data-testid="prompt-modal-cancel"
            type="button"
            className="px-3 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            data-testid="prompt-modal-submit"
            type="button"
            className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
            onClick={submit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
