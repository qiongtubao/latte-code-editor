import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { EditorTheme } from "./useSettingsStore";

export const cmThemes: Record<EditorTheme, ReturnType<typeof EditorView.theme>> = {
  monokai: EditorView.theme({
    "&": { color: "#f8f8f2", backgroundColor: "#272822" },
    ".cm-gutters": { backgroundColor: "#1e1f1c", color: "#75715e", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#3e3d32" },
    ".cm-activeLine": { backgroundColor: "#3e3d3220" },
    ".cm-cursor": { borderLeftColor: "#f8f8f0" },
    ".cm-selectionBackground": { backgroundColor: "#49483e80" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#49483e" },
    ".cm-matchingBracket": { backgroundColor: "#3b3a32", outline: "1px solid #75715e" },
  }, { dark: true }),

  dracula: EditorView.theme({
    "&": { color: "#f8f8f2", backgroundColor: "#282a36" },
    ".cm-gutters": { backgroundColor: "#21222c", color: "#6272a4", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#44475a" },
    ".cm-activeLine": { backgroundColor: "#44475a30" },
    ".cm-cursor": { borderLeftColor: "#f8f8f0" },
    ".cm-selectionBackground": { backgroundColor: "#44475a80" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#44475a" },
    ".cm-matchingBracket": { backgroundColor: "#56594d", outline: "1px solid #6272a4" },
  }, { dark: true }),

  oneDark: EditorView.theme({
    "&": { color: "#abb2bf", backgroundColor: "#282c34" },
    ".cm-gutters": { backgroundColor: "#21252b", color: "#636d83", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#2c313a" },
    ".cm-activeLine": { backgroundColor: "#2c313a50" },
    ".cm-cursor": { borderLeftColor: "#528bff" },
    ".cm-selectionBackground": { backgroundColor: "#3e445180" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#3e4451" },
    ".cm-matchingBracket": { backgroundColor: "#2c313a", outline: "1px solid #636d83" },
  }, { dark: true }),

  solarizedLight: EditorView.theme({
    "&": { color: "#657b83", backgroundColor: "#fdf6e3" },
    ".cm-gutters": { backgroundColor: "#eee8d5", color: "#93a1a1", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#eee8d5" },
    ".cm-activeLine": { backgroundColor: "#eee8d580" },
    ".cm-cursor": { borderLeftColor: "#657b83" },
    ".cm-selectionBackground": { backgroundColor: "#eee8d5" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#d6d1bf" },
    ".cm-matchingBracket": { backgroundColor: "#eee8d5", outline: "1px solid #93a1a1" },
  }, { dark: false }),

  githubLight: EditorView.theme({
    "&": { color: "#24292e", backgroundColor: "#ffffff" },
    ".cm-gutters": { backgroundColor: "#ffffff", color: "#959da5", borderRight: "1px solid #e1e4e8" },
    ".cm-activeLineGutter": { backgroundColor: "#f6f8fa" },
    ".cm-activeLine": { backgroundColor: "#f6f8fa" },
    ".cm-cursor": { borderLeftColor: "#24292e" },
    ".cm-selectionBackground": { backgroundColor: "#c8c8fa" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#c8c8fa" },
    ".cm-matchingBracket": { backgroundColor: "#f6f8fa", outline: "1px solid #d1d5da" },
  }, { dark: false }),
};

const themeHighlights: Record<EditorTheme, HighlightStyle> = {
  monokai: HighlightStyle.define([
    { tag: t.keyword, color: "#f92672" },
    { tag: t.comment, color: "#75715e", fontStyle: "italic" },
    { tag: t.string, color: "#e6db74" },
    { tag: t.number, color: "#ae81ff" },
    { tag: t.function(t.variableName), color: "#a6e22e" },
    { tag: t.typeName, color: "#66d9ef" },
    { tag: t.operator, color: "#f92672" },
    { tag: t.macroName, color: "#a6e22e", fontStyle: "italic" },
  ]),
  dracula: HighlightStyle.define([
    { tag: t.keyword, color: "#ff79c6" },
    { tag: t.comment, color: "#6272a4", fontStyle: "italic" },
    { tag: t.string, color: "#f1fa8c" },
    { tag: t.number, color: "#bd93f9" },
    { tag: t.function(t.variableName), color: "#50fa7b" },
    { tag: t.typeName, color: "#8be9fd" },
    { tag: t.macroName, color: "#50fa7b", fontStyle: "italic" },
  ]),
  oneDark: HighlightStyle.define([
    { tag: t.keyword, color: "#c678dd" },
    { tag: t.comment, color: "#5c6370", fontStyle: "italic" },
    { tag: t.string, color: "#98c379" },
    { tag: t.number, color: "#d19a66" },
    { tag: t.function(t.variableName), color: "#61afef" },
    { tag: t.typeName, color: "#e5c07b" },
    { tag: t.macroName, color: "#61afef", fontStyle: "italic" },
  ]),
  solarizedLight: HighlightStyle.define([
    { tag: t.keyword, color: "#859900" },
    { tag: t.comment, color: "#93a1a1", fontStyle: "italic" },
    { tag: t.string, color: "#2aa198" },
    { tag: t.number, color: "#d33682" },
    { tag: t.function(t.variableName), color: "#268bd2" },
    { tag: t.typeName, color: "#b58900" },
    { tag: t.macroName, color: "#268bd2", fontStyle: "italic" },
  ]),
  githubLight: HighlightStyle.define([
    { tag: t.keyword, color: "#d73a49" },
    { tag: t.comment, color: "#6a737d", fontStyle: "italic" },
    { tag: t.string, color: "#032f62" },
    { tag: t.number, color: "#005cc5" },
    { tag: t.function(t.variableName), color: "#6f42c1" },
    { tag: t.typeName, color: "#22863a" },
    { tag: t.macroName, color: "#6f42c1", fontStyle: "italic" },
  ]),
};

export function getHighlightStyle(theme: EditorTheme): ReturnType<typeof syntaxHighlighting> {
  return syntaxHighlighting(themeHighlights[theme]);
}
