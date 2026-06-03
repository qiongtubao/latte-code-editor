import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { requestFileSwitch as requestFileSwitchShared } from "./useUnsavedGuard.js";

/**
 * Structural shape of the MonacoEditor imperative handle. Defined
 * here (rather than imported from `@latte/editor`) so this hook
 * doesn't have to know the package's public surface — keeps the
 * package/host boundary one-way and lets the editor package evolve
 * its exports without forcing churn in `apps/desktop`.
 */
export interface MonacoEditorLike {
  syncSavedContent: (content: string) => void;
}

export type SaveStatus = "idle" | "saving" | "saved";

/**
 * The renderer's view of an open file. `content` is the current
 * in-memory editor buffer; `savedContent` is the last-known on-disk
 * baseline. The dirty flag is `content !== savedContent`.
 */
export interface OpenFile {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  language: string;
  /**
   * Set when the file was opened from outside the workspace (e.g.
   * via go-to-definition landing on a `.d.ts` inside `node_modules`).
   * The status bar surfaces this as `· read-only` and `useSave.handleSave`
   * short-circuits with a banner instead of writing to disk.
   */
  isReadOnly?: boolean;
}

export interface UseSaveArgs {
  /** The currently open file, or `null` if no buffer is active. */
  file: OpenFile | null;
  /** Setter for `file` in the parent (must be a React state setter
   *  so the function form is supported — `cmd_write_file` returns
   *  asynchronously, and a concurrent keystroke could update
   *  `file.content` between the `invoke` and the `setFile`). */
  setFile: Dispatch<SetStateAction<OpenFile | null>>;
  /** Imperative handle from `<MonacoEditor ref={...} />`. `null` is
   *  expected when no file is open (the editor isn't mounted). */
  monacoRef: RefObject<MonacoEditorLike | null>;
}

export interface UseSaveReturn {
  /** Latest dirty flag reported by the editor (via `onDirtyChange`). */
  dirty: boolean;
  /** Passed to `<MonacoEditor onDirtyChange={...} />`. The editor
   *  fires it on every content change AND on every `[savedContent]`
   *  effect tick — the latter is what clears the dirty flag on
   *  "load fresh from disk" (e.g. `onFileOpen`) even when the
   *  editor value didn't change. */
  setDirty: (dirty: boolean) => void;
  saveStatus: SaveStatus;
  /** Editor-pane top banner. Auto-dismisses after 5s; the host
   *  (`App.tsx`) renders it just above the editor. */
  editorBanner: string | null;
  /** Imperative setter for `editorBanner`. Used by `App.tsx` to
   *  surface non-save errors (e.g. `cmd_read_file` failures). */
  setEditorBanner: (msg: string | null) => void;
  /**
   * Wraps a state-mutating swap in a "discard unsaved?" confirm.
   * Pass a thunk that does the actual swap. If the file is clean,
   * the thunk runs immediately; otherwise a `window.confirm` blocks
   * and the thunk only runs on accept.
   *
   * Used at all 3 file-switch sites in `App.tsx`:
   *   - clicking a different file in the FileTree
   *   - the `workspace-changed` event handler (drag-drop a folder)
   *   - the go-to-definition swap
   */
  requestFileSwitch: (swap: () => void) => void;
  /**
   * Cmd+S handler. Writes the current file's content to disk via
   * `cmd_write_file`, updates `savedContent` on success, and shows
   * `saving…`/`saved ✓` in the status bar. Bound in `MonacoEditor`
   * via `ed.addCommand(CtrlCmd | KeyS, ...)`.
   *
   * Pass `{ isReadOnly: true }` to short-circuit with a banner
   * instead of writing — used when the active buffer is from
   * outside the workspace (e.g. opened by go-to-definition) and
   * should not be silently persisted.
   */
  handleSave: (opts?: { isReadOnly?: boolean }) => Promise<void>;
}

export function useSave({ file, setFile, monacoRef }: UseSaveArgs): UseSaveReturn {
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [editorBanner, setEditorBannerState] = useState<string | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const saveStatusTimer = useRef<number | null>(null);

  // Snapshot the file at the moment handleSave is invoked. The Cmd+S
  // path is hot and the IPC is async, so a concurrent onChange could
  // update file.content while `cmd_write_file` is awaiting. We capture
  // path+content once via this ref so the in-flight save isn't
  // confused by intervening keystrokes (and so the post-await setFile
  // doesn't accidentally clobber them — see the function-form setFile
  // call below).
  const fileRef = useRef(file);
  useEffect(() => { fileRef.current = file; }, [file]);

  // 5s auto-dismiss for the editor banner. Same shape as the
  // FileTree banner timer; centralised here because useSave owns the
  // message lifecycle.
  const showEditorBanner = useCallback((msg: string) => {
    setEditorBannerState(msg);
    if (bannerTimer.current !== null) clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => {
      setEditorBannerState(null);
      bannerTimer.current = null;
    }, 5000);
  }, []);

  // Cleanup both timers on unmount so we don't setState on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (bannerTimer.current !== null) {
        clearTimeout(bannerTimer.current);
        bannerTimer.current = null;
      }
      if (saveStatusTimer.current !== null) {
        clearTimeout(saveStatusTimer.current);
        saveStatusTimer.current = null;
      }
    };
  }, []);

  // Reset dirty when the active file becomes null (e.g., workspace
  // switched, last file closed). Without this, the next opened file
  // would inherit a stale dirty=true until its first
  // [savedContent] effect tick — usually a single frame, but visible
  // in the status bar.
  useEffect(() => {
    if (file === null) setDirty(false);
  }, [file]);

  // Mirror `dirty` into a ref so `requestFileSwitch` can be a stable
  // `useCallback([])` — otherwise the workspace-changed effect in
  // `App.tsx` would re-subscribe to the Tauri event every time the
  // user toggled the dirty flag (every keystroke), which is wasteful
  // and noisy in devtools.
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const requestFileSwitch = useCallback((swap: () => void) => {
    requestFileSwitchShared(dirtyRef.current, swap);
  }, []);

  const handleSave = useCallback(async (opts?: { isReadOnly?: boolean }) => {
    const f = fileRef.current;
    if (f === null) return;
    if (opts?.isReadOnly === true) {
      showEditorBanner(`read-only — cannot save: ${f.path}`);
      return;
    }
    setSaveStatus("saving");
    try {
      await invoke("cmd_write_file", { path: f.path, content: f.content });
      // C2 fix: synchronously clear the MonacoEditor baseline BEFORE
      // `setFile`, so a keystroke landing between `setFile` and the
      // prop arriving at the editor doesn't briefly flip dirty=true
      // (old baseline vs. current editor value) and produce a
      // one-frame ● flicker in the status bar.
      monacoRef.current?.syncSavedContent(f.content);
      // Function-form setFile: even if the user typed during the
      // in-flight save, we only touch `savedContent` — the parent's
      // `content` (with the latest keystrokes) is preserved. After
      // this, dirty = editor.value !== savedContent = typed !==
      // saved → correctly stays true if the user kept typing.
      setFile((prev) =>
        prev === null ? null : { ...prev, savedContent: f.content },
      );
      setSaveStatus("saved");
      if (saveStatusTimer.current !== null) clearTimeout(saveStatusTimer.current);
      saveStatusTimer.current = window.setTimeout(() => {
        setSaveStatus("idle");
        saveStatusTimer.current = null;
      }, 2000);
    } catch (err) {
      setSaveStatus("idle");
      showEditorBanner(`save failed: ${String(err)}`);
    }
  }, [setFile, monacoRef, showEditorBanner]);

  return {
    dirty,
    setDirty,
    saveStatus,
    editorBanner,
    setEditorBanner: setEditorBannerState,
    requestFileSwitch,
    handleSave,
  };
}
