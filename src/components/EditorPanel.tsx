import { useCallback, useEffect } from "react";
import { useEditorStore } from "../hooks/useEditorStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { LargeFileViewer } from "./LargeFileViewer";
import { EmptyState } from "./EmptyState";
import { DocViewer } from "./DocViewer";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openFile, saveFile } from "../api/commands";
interface EditorPanelProps {
  onCtrlClick?: (word: string, x: number, y: number, filePath: string | null, line?: number) => void;
  onShowInGraph?: (word: string, filePath: string | null) => void;
}
export function EditorPanel({ onCtrlClick, onShowInGraph }: EditorPanelProps) {
  const {
    currentContent,
    setContent,
    openFileOrSwitch,
    modified,
    tabState,
    filePath,
    markdownMode,
    setMarkdownMode,
  } = useEditorStore();
  const handleOpenFile = useCallback(async () => {
    const selected = await dialogOpen({
      multiple: false,
      filters: [{ name: "All Files", extensions: ["*"] }],
    });

    if (typeof selected === "string") {
      try {
        const result = await openFile(selected);
        openFileOrSwitch(result);
      } catch (e) {
        console.error("Failed to open file:", e);
      }
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd + S: 保存
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      // Ctrl/Cmd + O: 打开文件
      if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        handleOpenFile();
      }
      // Ctrl/Cmd + Shift + R: 刷新当前文件
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "R") {
        e.preventDefault();
        useEditorStore.getState().refreshCurrentFile();
      }
      // Ctrl/Cmd + L: 手动触发当前文件 LSP
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "l") {
        e.preventDefault();
        triggerLspForCurrentFile();
      }
      // Ctrl/Cmd + Alt + H: 休眠当前 LSP
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === "h") {
        e.preventDefault();
        hibernateCurrentLsp();
      }
      // Ctrl/Cmd + Alt + S: 停止当前 LSP
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === "s") {
        e.preventDefault();
        stopCurrentLsp();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, handleOpenFile]);

  // LSP 手动触发函数
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
        return (
          <LargeFileViewer content={currentContent} fileName={filePath || ""} />
        );
      case "markdown":
        return (
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#252526] border-b border-gray-700 text-xs">
              <button
                onClick={() => setMarkdownMode("preview")}
                className={`px-2 py-0.5 rounded cursor-pointer ${markdownMode === "preview" ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-300 hover:bg-[#4a4a4a]"}`}
              >Preview</button>
              <button
                onClick={() => setMarkdownMode("source")}
                className={`px-2 py-0.5 rounded cursor-pointer ${markdownMode === "source" ? "bg-[#007acc] text-white" : "bg-[#3a3a3a] text-gray-300 hover:bg-[#4a4a4a]"}`}
              >Source</button>
              <span className="text-gray-500 ml-auto">{filePath?.split("/").pop()}</span>
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
