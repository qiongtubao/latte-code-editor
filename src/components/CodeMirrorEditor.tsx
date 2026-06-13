import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { languages } from "./languageExtensions";
import { useSettingsStore } from "../hooks/useSettingsStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { cmThemes, getHighlightStyle } from "../hooks/themes";
interface CodeMirrorProps {
  content: string;
  filePath: string | null;
  onChange: (content: string) => void;
  onCtrlClick?: (word: string, x: number, y: number) => void;
}

export function CodeMirrorEditor({ content, filePath, onChange, onCtrlClick }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const targetLine = useEditorStore((s) => s.targetLine);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onChange);
  const onCtrlClickRef = useRef(onCtrlClick);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onCtrlClickRef.current = onCtrlClick; }, [onCtrlClick]);
  useEffect(() => { contentRef.current = content; }, [content]);

  const buildEditor = () => {
    const container = containerRef.current;
    if (!container) return;

    const langExt = languages(filePath);
    const { theme, fontSize, lineNumbers, wordWrap } = useSettingsStore.getState();

    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        basicSetup,
        getHighlightStyle(theme),
        cmThemes[theme],
        EditorView.theme({
          "&": { fontSize: `${fontSize}px` },
          ".cm-gutters": lineNumbers ? {} : { display: "none" },
          ".cm-content": { whiteSpace: wordWrap ? "pre-wrap" : "pre" },
        }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        langExt,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
  };

  // Initial build + rebuild on file change
  useEffect(() => {
    buildEditor();
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, [filePath]);

  // 滚动到 targetLine（仅在 targetLine 变化时触发，不跟 content/filePath 耦合）
  useEffect(() => {
    const view = viewRef.current;
    if (!view || targetLine == null || targetLine < 1) return;
    const safeLine = Math.min(targetLine, view.state.doc.lines);
    if (safeLine < 1) return;
    const lineObj = view.state.doc.line(safeLine);
    view.dispatch({
      selection: { anchor: lineObj.from, head: lineObj.from },
      effects: EditorView.scrollIntoView(lineObj.from, { y: "center" }),
    });
    // 用完清掉，避免下次 effect 重触发
    useEditorStore.getState().setTargetLine(null);
  }, [targetLine]);
  // Rebuild on settings change
  useEffect(() => {
    // Clean and rebuild when store fires
    const unsub = useSettingsStore.subscribe(() => {
      viewRef.current?.destroy();
      containerRef.current!.innerHTML = "";
      buildEditor();
    });
    return unsub;
  }, []);

  // Ctrl+Click handler — pick the entire token (Identifier, function name,
  // macro name, type name, etc.) at the click position. This mirrors VS Code
  // semantics: clicking anywhere inside `println!` resolves to `println`.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    const handler = (e: MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const word = wordAtPos(view, pos);
      if (word) {
        e.preventDefault();
        onCtrlClickRef.current?.(word, e.clientX, e.clientY);
      }
    };

    view.dom.addEventListener("click", handler);
    return () => view.dom.removeEventListener("click", handler);
  }, [filePath]);
  return <div ref={containerRef} className="h-full overflow-auto" />;
}

/**
 * Resolve the symbol under the cursor position using CodeMirror's
 * Lezer syntax tree. Returns the entire token text, e.g. clicking anywhere
 * inside `println!` yields `println`. Falls back to a simple identifier scan
 * for plain text or languages without a parser.
 */
export function wordAtPos(view: EditorView, pos: number): string | null {
  const state = view.state;
  // First, try the deepest node the position falls within.
  const node = syntaxTree(state).resolveInner(pos, -1);
  if (node) {
    const text = state.doc.sliceString(node.from, node.to).trim();
    if (text.length > 0) return text;
  }
  // Fallback: simple identifier scan on the same line.
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  const before = line.text.slice(0, offset);
  const after = line.text.slice(offset);
  const head = before.match(/[A-Za-z_][A-Za-z0-9_]*!?$/)?.[0] ?? "";
  const tail = after.match(/^[A-Za-z0-9_]*!?/)?.[0] ?? "";
  const combined = head + tail;
  return combined.length > 0 ? combined : null;
}
