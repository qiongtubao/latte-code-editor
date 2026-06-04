import { useCallback, useEffect } from "react";
import { useEditorStore } from "../hooks/useEditorStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { LargeFileViewer } from "./LargeFileViewer";
import { EmptyState } from "./EmptyState";
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
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        handleOpenFile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, handleOpenFile]);

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
