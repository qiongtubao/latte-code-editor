import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MonacoEditor } from "@latte/editor";
import { useGoToDef, type GoToLocation } from "@latte/editor/useGoToDef";
import { TopBar } from "./components/TopBar.js";
import { EmptyState } from "./components/EmptyState.js";
import { FileTree } from "./components/FileTree.js";
import { languageFromPath } from "./components/languageFromPath.js";
import type { Sample } from "./samples.js";

interface OpenFile {
  path: string;
  name: string;
  content: string;
  language: string;
}

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const goto = useGoToDef();

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
      invoke<string | null>("cmd_get_workspace")
        .then(setWorkspace)
        .catch((err: unknown) => console.error("cmd_get_workspace failed:", err));
    });
    return () => {
      unlistenPromise.then((u) => u()).catch(() => {});
    };
  }, []);

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
  const onFileOpen = async (path: string, name: string) => {
    try {
      const content = await invoke<string>("cmd_read_file", { path });
      setFile({ path, name, content, language: languageFromPath(path) });
    } catch (err) {
      console.error("cmd_read_file failed:", err);
      // Surface the error in the editor pane by loading the message as
      // the file content. Keeps the user in the app instead of dropping
      // them back to the empty state on a read failure.
      setFile({
        path,
        name,
        content: `// failed to read ${path}\n// ${String(err)}`,
        language: "plaintext",
      });
    }
  };

  return (
    <div data-testid="app-shell" className="h-screen flex flex-col">
      <TopBar workspace={workspace} onWorkspace={setWorkspace} />
      <div className="flex-1 min-h-0 flex">
        {workspace !== null && (
          <FileTree workspace={workspace} onFileOpen={onFileOpen} />
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          {file ? (
            <MonacoEditor
              value={file.content}
              language={file.language}
              path={file.path}
              onChange={(v) => setFile({ ...file, content: v })}
              onSymbolClick={(sym) => {
                void goto
                  .onSymbolClick(sym)
                  .then((loc: GoToLocation | null) => {
                    if (loc) setFile({ path: loc.file, name: loc.file.split("/").pop() ?? loc.file, content: "// TODO: load from disk", language: "typescript" });
                  })
                  .catch((err: unknown) => {
                    console.error("go-to-definition failed:", err);
                  });
              }}
            />
          ) : workspace !== null ? (
            <div
              data-testid="editor-placeholder"
              className="h-full flex items-center justify-center text-sm text-zinc-500 bg-zinc-900"
            >
              Select a file from the tree
            </div>
          ) : (
            <EmptyState onOpen={(s: Sample) => setFile({ path: s.path, name: s.name, content: s.content, language: s.language })} />
          )}
        </div>
      </div>
      <div data-testid="status-bar" className="h-6 px-3 flex items-center text-[11px] bg-zinc-800">
        {file?.path ?? workspace ?? "latte"} {goto.busy && "· jumping…"}
      </div>
    </div>
  );
}
