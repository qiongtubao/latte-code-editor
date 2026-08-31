import { useCallback, useEffect } from "react";
import { useEditorStore } from "../hooks/useEditorStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { LargeFileViewer } from "./LargeFileViewer";
import { EmptyState } from "./EmptyState";
import { DocViewer } from "./DocViewer";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openFile, saveFile } from "../api/commands";
import { isChord } from "../utils/keyboard";
interface EditorPanelProps {
  onCtrlClick?: (word: string, x: number, y: number, filePath: string | null, line?: number) => void;
  onShowInGraph?: (word: string, filePath: string | null) => void;
}
export function EditorPanel({ onCtrlClick, onShowInGraph }: EditorPanelProps) {
  const {
    openFile: activeFile,
    currentContent,
    setContent,
    openFileOrSwitch,
    tabState,
    filePath,
    markdownMode,
    setMarkdownMode,
  } = useEditorStore();
  const handleOpenFile = useCallback(async () => {
    // dialogOpen 此前在 try 之外：对话框自身失败（插件不可用/被取消以外的
    // 错误）会产生未处理的 Promise 拒绝。
    try {
      const selected = await dialogOpen({
        multiple: false,
        filters: [{ name: "All Files", extensions: ["*"] }],
      });
      if (typeof selected !== "string") return;
      const result = await openFile(selected);
      openFileOrSwitch(result);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }, [openFileOrSwitch]);

  const handleSave = useCallback(async () => {
    if (!filePath) return;
    try {
      await saveFile(filePath, currentContent);
      useEditorStore.getState().setModified(false);
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }, [filePath, currentContent]);

  // LSP 手动触发函数。
  //
  // 必须定义在下方 keydown effect **之前**：该 effect 的依赖数组要列出这三个
  // 回调，而依赖数组在渲染期求值——若定义在后面，渲染时它们尚未初始化，会直接
  // 抛 ReferenceError（TDZ）。此前 effect 漏列这三项，靠 handleSave 随
  // currentContent 频繁变化而间接重订阅，属侥幸生效。
  const triggerLspForCurrentFile = useCallback(async () => {
    if (!filePath) return;
    const { detectFileLanguage, useLspStore } = await import("../hooks/useLspStore");
    const lang = detectFileLanguage(filePath);
    if (!lang) {
      console.log("[LSP] No language detected for file:", filePath);
      return;
    }
    await useLspStore.getState().startLsp(lang);
  }, [filePath]);

  const hibernateCurrentLsp = useCallback(async () => {
    if (!filePath) return;
    const { detectFileLanguage, useLspStore } = await import("../hooks/useLspStore");
    const lang = detectFileLanguage(filePath);
    if (!lang) return;
    await useLspStore.getState().hibernateLsp(lang);
  }, [filePath]);

  const stopCurrentLsp = useCallback(async () => {
    if (!filePath) return;
    const { detectFileLanguage, useLspStore } = await import("../hooks/useLspStore");
    const lang = detectFileLanguage(filePath);
    if (!lang) return;
    await useLspStore.getState().stopLsp(lang);
  }, [filePath]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // isChord 精确匹配修饰键：Ctrl+Alt+S 此前会同时命中「保存」和
      // 「停止 LSP」两个分支（各分支是独立 if 且未排除 Alt）。
      // Ctrl/Cmd + S: 保存
      if (isChord(e, "s")) {
        e.preventDefault();
        void handleSave();
      }
      // Ctrl/Cmd + O: 打开文件
      else if (isChord(e, "o")) {
        e.preventDefault();
        void handleOpenFile();
      }
      // Ctrl/Cmd + Shift + R: 刷新当前文件
      else if (isChord(e, "r", { shift: true })) {
        e.preventDefault();
        void useEditorStore.getState().refreshCurrentFile();
      }
      // Ctrl/Cmd + L: 手动触发当前文件 LSP
      else if (isChord(e, "l")) {
        e.preventDefault();
        void triggerLspForCurrentFile();
      }
      // Ctrl/Cmd + Alt + H: 休眠当前 LSP
      else if (isChord(e, "h", { alt: true })) {
        e.preventDefault();
        void hibernateCurrentLsp();
      }
      // Ctrl/Cmd + Alt + S: 停止当前 LSP
      else if (isChord(e, "s", { alt: true })) {
        e.preventDefault();
        void stopCurrentLsp();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, handleOpenFile, triggerLspForCurrentFile, hibernateCurrentLsp, stopCurrentLsp]);

  const handleChange = useCallback(
    (content: string) => {
      setContent(content);
    },
    [setContent],
  );

  const renderContent = () => {
    switch (tabState) {
      case "empty":
        return <EmptyState onOpen={handleOpenFile} />;
      case "large-file":
        return activeFile ? <LargeFileViewer file={activeFile} /> : <EmptyState onOpen={handleOpenFile} />;
      case "markdown":
        return (
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border-b border-edge text-xs">
              <button
                onClick={() => setMarkdownMode("preview")}
                className={`px-2 py-0.5 rounded cursor-pointer ${markdownMode === "preview" ? "bg-accent text-white" : "bg-control text-fg hover:bg-control-hover"}`}
              >Preview</button>
              <button
                onClick={() => setMarkdownMode("source")}
                className={`px-2 py-0.5 rounded cursor-pointer ${markdownMode === "source" ? "bg-accent text-white" : "bg-control text-fg hover:bg-control-hover"}`}
              >Source</button>
              <span className="text-fg-3 ml-auto">{filePath?.split("/").pop()}</span>
            </div>
            <div className="flex-1 overflow-hidden">
              {markdownMode === "preview" ? (
                <DocViewer content={currentContent} filePath={filePath || undefined} />
              ) : (
                <CodeMirrorEditor
                  onCtrlClick={onCtrlClick}
                  onShowInGraph={onShowInGraph}
                  content={currentContent}
                  filePath={filePath}
                  onChange={handleChange}
                />
              )}
            </div>
          </div>
        );
      case "code":
        return (
          <CodeMirrorEditor
            onCtrlClick={onCtrlClick}
            onShowInGraph={onShowInGraph}
            content={currentContent}
            filePath={filePath}
            onChange={handleChange}
          />
        );
      default:
        return <EmptyState onOpen={handleOpenFile} />;
    }
  };

  return <div className="h-full relative">{renderContent()}</div>;
}
