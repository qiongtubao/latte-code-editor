import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MonacoEditor } from "@latte/editor";
import { useGoToDef, type GoToLocation } from "@latte/editor/useGoToDef";

export default function App() {
  const [content, setContent] = useState("// Welcome to Latte");
  const [path, setPath] = useState("welcome.ts");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const goto = useGoToDef();

  // Fetch the current workspace on mount so the `useEffect` below can
  // depend on it and re-inject user CSS/JS hooks when the workspace
  // changes. T25 restores the last-opened workspace in `setup()`, so by
  // the time the renderer mounts, `state.workspace` is populated.
  useEffect(() => {
    invoke<string | null>("cmd_get_workspace").then(setWorkspace).catch((err: unknown) => {
      console.error("cmd_get_workspace failed:", err);
    });
  }, []);

  // T26: inject the workspace's user CSS/JS hooks (if any) into the
  // document. Re-runs whenever the workspace path changes so that
  // switching workspaces replaces (not accumulates) the injected tags.
  //
  // SECURITY: `user.js` is read from the workspace's .latte/hooks/ dir
  // and injected into the document. This is `eval`-equivalent and will
  // run any code the workspace owner put there. Only open workspaces
  // you trust. (See plan §T26 for the design rationale.)
  //
  // TODO: watch .latte/hooks/{user.css,user.js} for live reload.
  useEffect(() => {
    if (workspace === null) return;
    const styleEl = document.createElement("style");
    const scriptEl = document.createElement("script");
    // Track elements in refs via locals for cleanup; the next effect
    // run (on workspace change) will remove them before injecting the
    // new ones, preventing accumulation.
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
      <MonacoEditor
        value={content}
        language="typescript"
        onChange={setContent}
        onSymbolClick={(sym) => {
          // Don't propagate the rejection — Monaco won't await, and an
          // unhandled rejection here would surface as a console error
          // with no recovery path. Log it so the failure is at least
          // visible.
          void goto
            .onSymbolClick(sym)
            .then((loc: GoToLocation | null) => {
              if (loc) {
                setPath(loc.file);
                // TODO: read file content via invoke('read_file', { path: loc.file })
              }
            })
            .catch((err: unknown) => {
              console.error("go-to-definition failed:", err);
            });
        }}
      />
      <div data-testid="status-bar" className="h-6 px-3 flex items-center text-[11px] bg-zinc-800">{path} {goto.busy && "· jumping…"}</div>
    </div>
  );
}
