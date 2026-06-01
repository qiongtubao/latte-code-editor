import { useState } from "react";
import { MonacoEditor } from "@latte/editor";
import { useGoToDef } from "@latte/editor/useGoToDef";

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
        onSymbolClick={async (sym) => {
          const loc = await goto.onSymbolClick(sym);
          if (loc) {
            setPath(loc.file);
            // TODO: read file content via invoke('read_file', { path: loc.file })
          }
        }}
      />
      <div className="h-6 px-3 flex items-center text-[11px] bg-zinc-800">{path} {goto.busy && "· jumping…"}</div>
    </div>
  );
}
