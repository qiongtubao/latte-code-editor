import { useState } from "react";
import { MonacoEditor } from "@latte/editor";
import { useGoToDef, type GoToLocation } from "@latte/editor/useGoToDef";

export default function App() {
  const [content, setContent] = useState("// Welcome to Latte");
  const [path, setPath] = useState("welcome.ts");
  const goto = useGoToDef();

  return (
    <div className="h-screen flex flex-col">
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
      <div className="h-6 px-3 flex items-center text-[11px] bg-zinc-800">{path} {goto.busy && "· jumping…"}</div>
    </div>
  );
}
