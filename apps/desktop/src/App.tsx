import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Drawer, MonacoEditor, type MonacoEditorHandle } from "@latte/editor";
import { TopBar } from "./components/TopBar.js";
import { EmptyState } from "./components/EmptyState.js";
import { FileTree } from "./components/FileTree.js";
import { languageFromPath } from "./components/languageFromPath.js";
import { useSave, type OpenFile } from "./hooks/useSave.js";
import { useSymbolNavigation } from "./hooks/useSymbolNavigation.js";
import type { Sample } from "./samples.js";

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  // Imperative handle from <MonacoEditor>. Passed into useSave so
  // handleSave can call `syncSavedContent` synchronously on success
  // (C2 fix: avoids a one-frame ● flicker in the status bar).
  const monacoRef = useRef<MonacoEditorHandle | null>(null);
  const {
    dirty,
    setDirty,
    saveStatus,
    editorBanner,
    setEditorBanner,
    requestFileSwitch,
    handleSave,
  } = useSave({ file, setFile, monacoRef });

  // The Drawer replaces the old go-to-definition wiring: clicking a
  // symbol in the editor opens the Drawer; clicking a row in the
  // Drawer jumps (with `revealLine`) and sets `isReadOnly` for files
  // outside the workspace.
  const nav = useSymbolNavigation({
    file,
    setFile,
    monacoRef,
    workspace,
    requestFileSwitch,
    setEditorBanner,
  });

  // A file is read-only if it's open AND its path is not under the
  // workspace root. `node_modules/*.d.ts` and any external jump
  // target qualify. Used by the editor prop AND the save guard AND
  // the status bar text — keep all three driven by this one value.
  const isReadOnly =
    file !== null && workspace !== null && !file.path.startsWith(workspace + "/");

  useEffect(() => {
    invoke<string | null>("cmd_get_workspace").then(setWorkspace).catch((err: unknown) => {
      console.error("cmd_get_workspace failed:", err);
    });
  }, []);

  // Keep React state in sync when the workspace changes from the Rust side
  // (e.g. OS-level drag-drop in `lib.rs`, or a `cmd_set_workspace` invoked
  // by something other than the TopBar button). The payload is ignored;
  // we re-fetch from `cmd_get_workspace` so we always render the canonical
  // value rather than trusting the event payload.
  useEffect(() => {
    const unlistenPromise = listen<string>("workspace-changed", () => {
      // requestFileSwitch is stable (useSave keeps `dirty` in a ref),
      // so this effect's deps don't churn on every keystroke.
      requestFileSwitch(() => {
        invoke<string | null>("cmd_get_workspace")
          .then(setWorkspace)
          .catch((err: unknown) => console.error("cmd_get_workspace failed:", err));
      });
    });
    return () => {
      unlistenPromise.then((u) => u()).catch(() => {});
    };
  }, [requestFileSwitch]);

  // T26 user hook injection (unchanged from previous App.tsx)
  useEffect(() => {
    if (workspace === null) return;
    const styleEl = document.createElement("style");
    const scriptEl = document.createElement("script");
    let mounted = true;
    invoke<{ css: string | null; js: string | null }>("cmd_user_hook")
      .then((h) => {
        if (!mounted) return;
        if (h.css) {
          styleEl.textContent = h.css;
          document.head.appendChild(styleEl);
        }
        if (h.js) {
          scriptEl.textContent = h.js;
          document.body.appendChild(scriptEl);
        }
      })
      .catch((err: unknown) => {
        console.error("cmd_user_hook failed:", err);
      });
    return () => {
      mounted = false;
      styleEl.remove();
      scriptEl.remove();
    };
  }, [workspace]);

  // Open a file from the tree: read it from disk via the Rust side and
  // install it as the active editor buffer. The `name` is sent alongside
  // `path` so the editor can display a clean title in the status bar.
  // The whole thing is wrapped in `requestFileSwitch` so an unsaved
  // edit prompts before clobbering the current buffer; a failed read
  // (binary file, permissions, etc.) just surfaces the editor banner
  // and leaves the previously-open file alone.
  const onFileOpen = (path: string, name: string) => {
    invoke<string>("cmd_read_file", { path })
      .then((content) => {
        requestFileSwitch(() => {
          setFile({
            path,
            name,
            content,
            language: languageFromPath(path),
            savedContent: content,
          });
        });
      })
      .catch((err: unknown) => {
        setEditorBanner(`read failed: ${path} — ${String(err)}`);
      });
  };

  return (
    <div data-testid="app-shell" className="h-screen flex flex-col">
      <TopBar workspace={workspace} onWorkspace={setWorkspace} />
      <div className="flex-1 min-h-0 flex">
        {workspace !== null && (
          <FileTree workspace={workspace} onFileOpen={onFileOpen} />
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          {editorBanner !== null && (
            <div
              data-testid="editor-banner"
              role="alert"
              className="px-3 py-1 bg-red-900/60 text-red-100 text-xs border-b border-red-800 whitespace-pre-wrap break-words"
            >
              {editorBanner}
            </div>
          )}
          {file ? (
            <MonacoEditor
              ref={monacoRef}
              value={file.content}
              language={file.language}
              path={file.path}
              savedContent={file.savedContent}
              onChange={(v) => setFile({ ...file, content: v })}
              onSave={() => handleSave({ isReadOnly })}
              onDirtyChange={setDirty}
              readOnly={isReadOnly}
              onSymbolClick={(sym) => nav.onSymbolClick(sym)}
            />
          ) : workspace !== null ? (
            <div
              data-testid="editor-placeholder"
              className="h-full flex items-center justify-center text-sm text-zinc-500 bg-zinc-900"
            >
              Select a file from the tree
            </div>
          ) : (
            <EmptyState
              onOpen={(s: Sample) =>
                requestFileSwitch(() =>
                  setFile({
                    path: s.path,
                    name: s.name,
                    content: s.content,
                    language: s.language,
                    savedContent: s.content,
                  }),
                )
              }
            />
          )}
          {nav.drawerSymbol !== null && (
            <Drawer
              symbol={nav.drawerSymbol}
              onClose={nav.closeDrawer}
              onJump={nav.onJump}
            />
          )}
        </div>
      </div>
      <div data-testid="status-bar" className="h-6 px-3 flex items-center justify-between text-[11px] bg-zinc-800">
        <span>
          {file?.path ?? workspace ?? "latte"}
          {isReadOnly && " · read-only"}
          {dirty && !isReadOnly && saveStatus === "idle" && " · ●"}
          {saveStatus === "saving" && " · saving…"}
          {saveStatus === "saved" && " · saved ✓"}
        </span>
      </div>
    </div>
  );
}
