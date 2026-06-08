import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { basicSetup } from "codemirror";
import { languages } from "./languageExtensions";
import { useEditorStore } from "../hooks/useEditorStore";

interface CodeMirrorProps {
  content: string;
  filePath: string | null;
  onChange: (content: string) => void;
  /** Called when user Ctrl+Click on a symbol — shows definition popup */
  onCtrlClick?: (word: string, x: number, y: number) => void;
}

export function CodeMirrorEditor({ content, filePath, onChange, onCtrlClick }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onChange);
  const onCtrlClickRef = useRef(onCtrlClick);

  // Keep callbacks fresh
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onCtrlClickRef.current = onCtrlClick; }, [onCtrlClick]);
  useEffect(() => { contentRef.current = content; }, [content]);

  useEffect(() => {
    if (!containerRef.current) return;

    const langExt = languages(filePath);

    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        basicSetup,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        langExt,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [filePath]);

  // Ctrl+Click handler
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    const handler = (event: MouseEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return;
      const word = view.state.wordAt(pos);
      if (!word) return;
      const text = view.state.doc.sliceString(word.from, word.to);
      if (!text || text.length === 0) return;
      // Only trigger for multi-word (potential definition names)
      if (text.match(/^[a-zA-Z_]\w*$/)) {
        onCtrlClickRef.current?.(text, event.clientX, event.clientY);
      }
    };

    view.dom.addEventListener("click", handler);
    return () => view.dom.removeEventListener("click", handler);
  }, [filePath]);

  // Sync content from external changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    }
  }, [content]);

  // Scroll to target line + column when set
  useEffect(() => {
    const view = viewRef.current;
    const { targetLine, targetColumn } = useEditorStore.getState();
    if (!view || !targetLine || targetLine <= 0) return;

    const timer = setTimeout(() => {
      try {
        const doc = view.state.doc;
        const safeLine = Math.min(targetLine, doc.lines);
        const pos = doc.line(safeLine);
        const anchor = targetColumn != null && targetColumn > 0
          ? Math.min(pos.from + targetColumn - 1, pos.to)
          : pos.from;
        view.dispatch({
          selection: { anchor },
          effects: EditorView.scrollIntoView(anchor, { y: "center" }),
        });
        view.focus();
      } catch {
        // line/col might be out of range
      }
      useEditorStore.getState().setTargetLine(null);
    }, 50);

    return () => clearTimeout(timer);
  });

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto"
      style={{ background: "#1e1e1e" }}
    />
  );
}
