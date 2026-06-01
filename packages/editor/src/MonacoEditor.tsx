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

  useEffect(() => {
    if (!ref.current) return;
    const ed = monaco.editor.create(ref.current, {
      value, language, theme: "vs-dark",
      automaticLayout: true, fontSize: 13, minimap: { enabled: false },
    });
    ed.onDidChangeModelContent(() => onChange?.(ed.getValue()));
    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_GLYPH_MARGIN) return;
      const pos = e.target.position;
      if (!pos) return;
      const model = ed.getModel();
      if (!model) return;
      const word = model.getWordAtPosition(pos);
      if (word) onSymbolClick?.(word.word);
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
    if (ed) monaco.editor.setModelLanguage(ed.getModel()!, language);
  }, [language]);

  return <div ref={ref} className="h-full w-full" />;
}
