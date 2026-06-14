import { useCallback, useEffect } from "react";
import { useEditorStore } from "../hooks/useEditorStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { LargeFileViewer } from "./LargeFileViewer";
import { EmptyState } from "./EmptyState";
import { DocViewer } from "./DocViewer";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openFile, saveFile } from "../api/commands";
interface EditorPanelProps {
  onCtrlClick?: (word: string, x: number, y: number) => void;
}
export function EditorPanel({ onCtrlClick }: EditorPanelProps) {
  const {
    currentContent,
    setContent,
    openFileOrSwitch,
    modified,
    tabState,
    filePath,
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
          <DocViewer content={currentContent} filePath={filePath || undefined} />
        );
      case "code":
        return (
          <CodeMirrorEditor
            onCtrlClick={onCtrlClick}
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
