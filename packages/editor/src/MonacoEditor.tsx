import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as monaco from "monaco-editor";
import { registerTcl } from "./tcl.js";

/**
 * Imperative handle exposed by `MonacoEditor` via `forwardRef`. The
 * parent (`useSave.handleSave`) calls `syncSavedContent` *before*
 * `setFile` so the disk baseline updates on the same tick as the
 * parent's saved-state change. Without it, a keystroke that lands
 * between the parent's `setFile({...file, savedContent: new})` and
 * the prop arriving at the editor would briefly see the OLD baseline
 * in `savedContentRef`, report `dirty=true` from the
 * `onDidChangeModelContent` callback, and produce a one-frame ●
 * flicker in the status bar.
 */
export interface MonacoEditorHandle {
  syncSavedContent: (content: string) => void;
}

export interface MonacoEditorProps {
  value: string;
  language: string;
  /**
   * Workspace-relative path of the file being edited. Used to detect
   * "external switch to a different file" vs "in-place edit" so we
   * can avoid calling `ed.setValue` on every keystroke (which would
   * reset the cursor and selection). Pass `null` for transient buffers
   * that should always be reloaded from `value`.
   */
  path: string | null;
  /**
   * Last-known on-disk content. The dirty flag is computed as
   * `editor.getValue() !== savedContent`. Updated via the
   * `[savedContent]` effect (prop-driven) or the imperative
   * `syncSavedContent` handle (caller-driven, synchronous).
   */
  savedContent: string;
  onChange?: (v: string) => void;
  /** Bound to Ctrl/Cmd+S via `editor.addCommand`; fires the save flow. */
  onSave: () => void;
  /**
   * Reports dirty/clean transitions as a boolean. Fired from
   * `onDidChangeModelContent` and from the `[savedContent]` effect
   * (so a "load fresh from disk" flow clears the ● even when the
   * editor value didn't change). The status bar in `App.tsx` renders
   * the `· ●` glyph from this signal.
   */
  onDirtyChange?: (dirty: boolean) => void;
  onSymbolClick?: (symbol: string) => void;
}

export const MonacoEditor = forwardRef<MonacoEditorHandle, MonacoEditorProps>(
  function MonacoEditor(
    { value, language, path, savedContent, onChange, onSave, onDirtyChange, onSymbolClick },
    ref,
  ) {
    const divRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    // Keep latest callbacks in refs so the editor's persistent listeners
    // never call a stale closure after the parent re-renders.
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const onDirtyChangeRef = useRef(onDirtyChange);
    const onSymbolClickRef = useRef(onSymbolClick);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
    useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);
    useEffect(() => { onSymbolClickRef.current = onSymbolClick; }, [onSymbolClick]);
    // Disk baseline. Mirrors the `savedContent` prop via the [savedContent]
    // effect below; also updateable synchronously through the imperative
    // `syncSavedContent` handle so the parent can clear the dirty flag on
    // the same tick as its `setFile` (avoids the one-frame flicker noted
    // on `MonacoEditorHandle`).
    const savedContentRef = useRef(savedContent);
    // Tracks the `path` we last fully loaded into the editor. Same-file
    // edits (path unchanged) skip the `setValue` call entirely so the
    // cursor survives every keystroke. `null` means "never loaded".
    const lastLoadedPath = useRef<string | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        syncSavedContent(content) {
          savedContentRef.current = content;
          // Recompute dirty on the same tick so the parent doesn't see
          // a stale baseline for one frame. If the editor hasn't been
          // mounted yet (this can fire before the mount effect), the
          // next [savedContent] effect will pick it up.
          const ed = editorRef.current;
          if (ed) onDirtyChangeRef.current?.(ed.getValue() !== content);
        },
      }),
      [],
    );

    useEffect(() => {
      if (!divRef.current) return;
      const ed = monaco.editor.create(divRef.current, {
        value, language, theme: "vs-dark",
        automaticLayout: true, fontSize: 13, minimap: { enabled: false },
      });
      ed.onDidChangeModelContent(() => {
        const v = ed.getValue();
        onChangeRef.current?.(v);
        onDirtyChangeRef.current?.(v !== savedContentRef.current);
      });
      ed.onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const pos = e.target.position;
        if (!pos) return;
        const model = ed.getModel();
        if (!model) return;
        const word = model.getWordAtPosition(pos);
        if (word) onSymbolClickRef.current?.(word.word);
      });
      // Ctrl/Cmd+S → save. We use `addCommand` (not a document keydown
      // listener) so the binding lives inside Monaco's command system
      // and doesn't race with Monaco's own `editor.action.saveFile`
      // binding. V2 may need `addKeybindingRule` to fully suppress
      // that one.
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current();
      });
      editorRef.current = ed;
      // Idempotent: `tcl.ts` guards with a module-level `registered`
      // flag, so mounting multiple MonacoEditor instances is safe.
      registerTcl(monaco);
      // Record the initial load so the [path, value] effect below
      // doesn't redundantly re-setValue the same content on mount.
      lastLoadedPath.current = path;
      return () => { ed.dispose(); };
    }, []);

    // Sync `value` into the editor ONLY when `path` changes — i.e., the
    // parent switched to a different file. Same-file edits update the
    // model in-place via `onDidChangeModelContent`; re-calling
    // `setValue` here would clobber the cursor and selection. The
    // `path === null` case (transient buffers) is treated as "always
    // reload" so test/storybook callers can force a refresh.
    useEffect(() => {
      const ed = editorRef.current;
      if (!ed) return;
      if (path !== null && lastLoadedPath.current === path) return;
      ed.setValue(value);
      lastLoadedPath.current = path;
    }, [path, value]);

    useEffect(() => {
      const ed = editorRef.current;
      if (!ed) return;
      const model = ed.getModel();
      if (model) monaco.editor.setModelLanguage(model, language);
    }, [language]);

    // Keep `savedContentRef` aligned with the latest prop, and re-fire
    // the dirty callback so out-of-band "load from disk" flows (e.g.
    // `onFileOpen`) clear the ● even if the editor value didn't change.
    useEffect(() => {
      savedContentRef.current = savedContent;
      const ed = editorRef.current;
      if (ed) onDirtyChangeRef.current?.(ed.getValue() !== savedContent);
    }, [savedContent]);

    // Use inline `style` (not Tailwind `flex-1 w-full min-h-0`): the
    // desktop Tailwind config only scans `apps/desktop/src`, so the
    // utility classes that would be generated for those classNames are
    // missing — and silently falling back to defaults. Inline styles
    // are guaranteed to apply regardless of the consumer's Tailwind
    // config. In a `flex flex-col` parent, `flex: 1 1 0%; min-height:
    // 0;` claims the remaining space and lets the inner Monaco div
    // shrink below its content size if needed.
    return <div ref={divRef} style={{ flex: "1 1 0%", minHeight: 0, width: "100%" }} />;
  },
);
