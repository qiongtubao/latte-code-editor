import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

export interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (v: string) => void;
  onSymbolClick?: (symbol: string) => void;
}

export function MonacoEditor({ value, language, onChange, onSymbolClick }: MonacoEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Keep latest callbacks in refs so the editor's persistent listeners
  // never call a stale closure after the parent re-renders.
  const onChangeRef = useRef(onChange);
  const onSymbolClickRef = useRef(onSymbolClick);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSymbolClickRef.current = onSymbolClick; }, [onSymbolClick]);

  useEffect(() => {
    if (!ref.current) return;
    const ed = monaco.editor.create(ref.current, {
      value, language, theme: "vs-dark",
      automaticLayout: true, fontSize: 13, minimap: { enabled: false },
    });
    ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()));
    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const pos = e.target.position;
      if (!pos) return;
      const model = ed.getModel();
      if (!model) return;
      const word = model.getWordAtPosition(pos);
      if (word) onSymbolClickRef.current?.(word.word);
    });
    editorRef.current = ed;
    return () => { ed.dispose(); };
  }, []);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  // Use inline `style` (not Tailwind `flex-1 w-full min-h-0`): the
  // desktop Tailwind config only scans `apps/desktop/src`, so the
  // utility classes that would be generated for those classNames are
  // missing — and silently falling back to defaults. Inline styles
  // are guaranteed to apply regardless of the consumer's Tailwind
  // config. In a `flex flex-col` parent, `flex: 1 1 0%; min-height:
  // 0;` claims the remaining space and lets the inner Monaco div
  // shrink below its content size if needed.
  return <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, width: "100%" }} />;
}
