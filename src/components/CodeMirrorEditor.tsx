import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
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

  // Ctrl+Click handler
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    const handler = (e: MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const w = view.state.doc.sliceString(pos, pos + 50).match(/^[a-zA-Z_]\w*/)?.[0];
      if (w) { e.preventDefault(); onCtrlClickRef.current?.(w, e.clientX, e.clientY); }
    };

    view.dom.addEventListener("click", handler);
    return () => view.dom.removeEventListener("click", handler);
  }, [filePath]);

  return <div ref={containerRef} className="h-full overflow-auto" />;
}
