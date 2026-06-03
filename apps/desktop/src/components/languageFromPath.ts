/**
 * Map a file path to the Monaco language id we'd want to load for it.
 * Falls back to "plaintext" for unknown extensions.
 *
 * Kept exhaustive for the languages the rest of the app's Monaco setup
 * already knows about (TypeScript, JavaScript, JSON, Markdown, Rust,
 * C, C++, TOML-as-ini, Python, CSS, HTML). Adding a new mapping here
 * is the single place to extend language detection — the editor itself
 * doesn't infer from file content.
 *
 * C/C++ note: `.h` headers are mapped to `cpp` rather than `c` because
 * in real-world C/C++ projects `.h` files are shared between C and C++
 * translation units and the cpp grammar's tokenization is a strict
 * superset. Users who actually need C-mode highlighting on a `.h`
 * file can change the language manually (Monaco's built-in language
 * picker is unaffected by this mapping).
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
    case "c":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "c++":
    case "h":
    case "hpp":
    case "hh":
    case "hxx":
    case "h++":
      return "cpp";
    case "toml":
      return "ini"; // Monaco has no TOML id; ini is close enough.
    case "py":
      return "python";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "tcl":
    case "tk":
      return "tcl";
    default:
      return "plaintext";
  }
}
