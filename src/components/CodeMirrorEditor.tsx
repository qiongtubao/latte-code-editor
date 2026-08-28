import { useEffect, useRef } from "react";
import { EditorView, keymap, Decoration, type DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { languages } from "./languageExtensions";
import { useSettingsStore } from "../hooks/useSettingsStore";
import { useEditorStore } from "../hooks/useEditorStore";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { cmThemes, getHighlightStyle } from "../hooks/themes";
import { toWorkspaceRel } from "../chatBridge";

/** 跳转目标行的一次性高亮（chat 跳转而来自动示意）。 */
const flashLineEffect = StateEffect.define<number>();
const clearFlashEffect = StateEffect.define<null>();
const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        const line = tr.state.doc.lineAt(e.value);
        deco = Decoration.set([Decoration.line({ class: "cm-jump-flash" }).range(line.from)]);
      } else if (e.is(clearFlashEffect)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const FLASH_MS = 1600;
interface CodeMirrorProps {
  content: string;
  filePath: string | null;
  onChange: (content: string) => void;
  onCtrlClick?: (word: string, x: number, y: number, filePath: string | null, line?: number) => void;
  onShowInGraph?: (word: string, filePath: string | null) => void;
}

export function CodeMirrorEditor({ content, filePath, onChange, onCtrlClick, onShowInGraph }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const targetLine = useEditorStore((s) => s.targetLine);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onChange);
  const onCtrlClickRef = useRef(onCtrlClick);
  const onShowInGraphRef = useRef(onShowInGraph);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onCtrlClickRef.current = onCtrlClick; }, [onCtrlClick]);
useEffect(() => { onShowInGraphRef.current = onShowInGraph; }, [onShowInGraph]);
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
        flashLineField,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
  };

  // buildEditor 每次渲染重建且闭包捕获 filePath。两个用到它的 effect 都经
  // 这个 ref 取最新实现：订阅那个只注册一次（不能进依赖），初始构建那个只想
  // 在 filePath 变化时重建（不想因 buildEditor 每次变化而重建）。
  const buildEditorRef = useRef(buildEditor);
  buildEditorRef.current = buildEditor;

  // Initial build + rebuild on file change
  useEffect(() => {
    buildEditorRef.current();
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
      effects: [
        EditorView.scrollIntoView(lineObj.from, { y: "center" }),
        flashLineEffect.of(lineObj.from),
      ],
    });
    // 高亮动画播完即清除（装饰随文档变更自动 map，不会残留错位）。
    // 必须在 cleanup 里 clearTimeout：1.6s 内连续跳转多次时，早先的定时器
    // 到点会把**当次**的高亮提前清掉；组件在这段时间内卸载则是纯泄漏
    // （viewRef.current?. 兜住了空引用，所以不会崩）。
    const flashTimer = window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: clearFlashEffect.of(null) });
    }, FLASH_MS);
    // 用完清掉，避免下次 effect 重触发
    useEditorStore.getState().setTargetLine(null);
    return () => window.clearTimeout(flashTimer);
  }, [targetLine]);
  // Rebuild on settings change
  //
  // 此前这个 effect 是空依赖，订阅回调因此永久持有首次渲染的 buildEditor：
  // 切换文件后再改字号/主题，编辑器会用**旧的 filePath** 重建，加载错误的
  // 语言扩展。经上方 buildEditorRef 取最新实现即可，订阅仍只注册一次。
  useEffect(() => {
    // Clean and rebuild when store fires
    const unsub = useSettingsStore.subscribe(() => {
      viewRef.current?.destroy();
      viewRef.current = null;
      // 卸载竞态下 container 可能已不存在，别用非空断言
      if (containerRef.current) containerRef.current.innerHTML = "";
      buildEditorRef.current();
    });
    return unsub;
  }, []);

  // Ctrl+Click / F12 / context menu handlers
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    const clickHandler = (e: MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const word = wordAtPos(view, pos);
      if (word) {
        e.preventDefault();
        const line = view.state.doc.lineAt(pos).number;
        onCtrlClickRef.current?.(word, e.clientX, e.clientY, filePath, line);
      }
    };

    // ---------- F12 → show definition (at cursor) ----------
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== "F12") return;
      const head = view.state.selection.main.head;
      const word = wordAtPos(view, head);
      if (word) {
        e.preventDefault();
        const coords = view.coordsAtPos(head);
        const x = coords ? coords.left : 0;
        const y = coords ? coords.bottom : 0;
        const line = view.state.doc.lineAt(head).number;
        onCtrlClickRef.current?.(word, x, y, filePath, line);
      }
    };


    // ---------- Context menu → definition / show-in-graph ----------
    let menuEl: HTMLDivElement | null = null;

    const closeMenu = () => {
      if (menuEl) { menuEl.remove(); menuEl = null; }
    };

    const contextHandler = (e: MouseEvent) => {
      e.preventDefault();
      closeMenu();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const sel = view.state.selection.main;
      const hasSelection = !sel.empty;
      const word = wordAtPos(view, pos);
      if (!word && !hasSelection) return;

      menuEl = document.createElement("div");
      menuEl.className = "fixed z-50 bg-surface-3 border border-edge rounded shadow-xl py-1 text-xs min-w-[140px]";
      menuEl.style.left = `${e.clientX}px`;
      menuEl.style.top = `${e.clientY}px`;

      const mkItem = (label: string, onclick: () => void) => {
        const item = document.createElement("button");
        item.className = "w-full text-left px-3 py-1.5 text-fg hover:bg-info cursor-pointer";
        item.textContent = label;
        item.onclick = () => { closeMenu(); onclick(); };
        menuEl!.appendChild(item);
      };

      // 询问 Agent（有选区时）：选区引用 + quote 经 ask-agent 事件
      // 打进 chat 输入框（App.tsx → chatBridge → iframe）。
      if (hasSelection) {
        mkItem("询问 Agent", () => {
          const startLine = view.state.doc.lineAt(sel.from).number;
          const endLine = view.state.doc.lineAt(sel.to).number;
          let quote = view.state.doc.sliceString(sel.from, sel.to);
          if (quote.length > 2000) quote = `${quote.slice(0, 2000)}…`;
          const ws = useWorkspaceStore.getState();
          const root = (ws.activeWorkspaceId && ws.workspaces[ws.activeWorkspaceId]?.project_root) || null;
          window.dispatchEvent(new CustomEvent("ask-agent", {
            detail: { path: toWorkspaceRel(filePath, root), startLine, endLine, quote },
          }));
        });
      }

      if (word) {
        mkItem("跳转定义", () => onCtrlClickRef.current?.(word, e.clientX, e.clientY, filePath));
        mkItem("在图谱中查看", () => onShowInGraphRef.current?.(word, filePath));
      }

      document.body.appendChild(menuEl);
      // Click outside to dismiss
      const outsideHandler = (ev: MouseEvent) => {
        if (menuEl && !menuEl.contains(ev.target as Node)) { closeMenu(); document.removeEventListener("mousedown", outsideHandler); }
      };
      document.addEventListener("mousedown", outsideHandler);
    };

    view.dom.addEventListener("click", clickHandler);
    view.dom.addEventListener("keydown", keyHandler);
    view.dom.addEventListener("contextmenu", contextHandler);
    return () => {
      view.dom.removeEventListener("click", clickHandler);
      view.dom.removeEventListener("keydown", keyHandler);
      view.dom.removeEventListener("contextmenu", contextHandler);
      closeMenu();
    };
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
