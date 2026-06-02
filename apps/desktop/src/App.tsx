import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MonacoEditor } from "@latte/editor";
import { useGoToDef, type GoToLocation } from "@latte/editor/useGoToDef";
import { TopBar } from "./components/TopBar.js";
import { EmptyState } from "./components/EmptyState.js";
import type { Sample } from "./samples.js";

interface OpenFile {
  path: string;
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

  return (
    <div data-testid="app-shell" className="h-screen flex flex-col">
      <TopBar workspace={workspace} onWorkspace={setWorkspace} />
      <div className="flex-1 min-h-0">
        {file ? (
          <MonacoEditor
            value={file.content}
            language={file.language}
            onChange={(v) => setFile({ ...file, content: v })}
            onSymbolClick={(sym) => {
              void goto
                .onSymbolClick(sym)
                .then((loc: GoToLocation | null) => {
                  if (loc) setFile({ path: loc.file, content: "// TODO: load from disk", language: "typescript" });
                })
                .catch((err: unknown) => {
                  console.error("go-to-definition failed:", err);
                });
            }}
          />
        ) : (
          <EmptyState onOpen={(s: Sample) => setFile({ path: s.path, content: s.content, language: s.language })} />
        )}
      </div>
      <div data-testid="status-bar" className="h-6 px-3 flex items-center text-[11px] bg-zinc-800">
        {file?.path ?? workspace ?? "latte"} {goto.busy && "· jumping…"}
      </div>
    </div>
  );
}
