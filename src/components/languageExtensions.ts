import { cpp } from "@codemirror/lang-cpp";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";

export function languages(filePath: string | null): Extension {
  if (!filePath) return [];

  const ext = filePath.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
      return javascript({
        typescript: ext === "ts" || ext === "tsx",
        jsx: ext === "tsx" || ext === "jsx",
      });
    case "rs":
      return rust();
    case "py":
      return python();
    case "json":
    case "jsonc":
      return json();
    case "c":
    case "h":
      return cpp();
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return cpp();
    case "md":
    case "mdx":
      return markdown();
    default:
      return [];
  }
}
