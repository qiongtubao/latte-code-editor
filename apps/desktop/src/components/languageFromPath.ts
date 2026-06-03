/**
 * Map a file path to the Monaco language id we'd want to load for it.
 * Falls back to "plaintext" for unknown extensions.
 *
 * Kept exhaustive for the languages the rest of the app's Monaco setup
 * already knows about (TypeScript, JavaScript, JSON, Markdown, Rust,
 * TOML-as-ini, Python, CSS, HTML). Adding a new mapping here is the
 * single place to extend language detection — the editor itself doesn't
 * infer from file content.
 */
export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "rs":
      return "rust";
    case "toml":
      return "ini"; // Monaco has no TOML id; ini is close enough.
    case "py":
      return "python";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    default:
      return "plaintext";
  }
}
