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
      doc: content,
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        history(),
        langExt,
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            contentRef.current = update.state.doc.toString();
            onChangeRef.current(contentRef.current);
          }
          if (update.selectionSet) {
            const word = update.view.state.wordAt(update.view.state.selection.main.head);
            const text = word ? update.view.state.doc.sliceString(word.from, word.to) : "";
            useEditorStore.getState().setCursorWord(text);
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
    const editorDom = containerRef.current;
    if (!editorDom) return;

    const handler = (e: MouseEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const cb = onCtrlClickRef.current;
      if (!cb) return;

      const view = viewRef.current;
      if (!view) return;

      const rect = editorDom.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pos = view.posAtCoords({ x, y });
      if (pos === null) return;

      const word = view.state.wordAt(pos);
      if (!word) return;
      const text = view.state.doc.sliceString(word.from, word.to);
      if (!text.trim()) return;

      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ selection: { anchor: pos } });
      cb(text, e.clientX, e.clientY);
    };

    editorDom.addEventListener("mousedown", handler);
    return () => editorDom.removeEventListener("mousedown", handler);
  }, [filePath]);

  // Sync content from external changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  }, [content]);
  // Scroll to target line when set
  useEffect(() => {
    const view = viewRef.current;
    const line = useEditorStore.getState().targetLine;
    if (!view || !line || line <= 0) return;

    const timer = setTimeout(() => {
      try {
        const doc = view.state.doc;
        const pos = doc.line(Math.min(line, doc.lines));
        view.dispatch({
          selection: { anchor: pos.from },
          scrollIntoView: true,
        });
      } catch {
        // line might be out of range
      }
      useEditorStore.getState().setTargetLine(null);
    }, 50);

    return () => clearTimeout(timer);
  });

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto"
      style={{ background: "#1e1e1e" }}
    />
  );
}
