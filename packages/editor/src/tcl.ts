// One-shot registration of the TCL language with Monaco. Safe to call
// multiple times; subsequent calls are no-ops (guarded by `registered`).
//
// Monaco's built-in language support for TCL is uneven across releases —
// we ship our own monarch rules to be sure the highlighting matches.

import type * as monaco from "monaco-editor";

let registered = false;

const KEYWORDS = [
  "after", "append", "apply", "array", "binary", "break", "catch",
  "cd", "chan", "clock", "close", "concat", "continue", "encoding",
  "eof", "error", "eval", "exec", "exit", "expr", "fblocked",
  "fconfigure", "fcopy", "file", "fileevent", "flush", "for",
  "foreach", "format", "gets", "glob", "global", "history", "if",
  "incr", "info", "interp", "join", "lappend", "lassign", "lindex",
  "linsert", "list", "llength", "load", "lrange", "lrepeat",
  "lreplace", "lreverse", "lsearch", "lset", "lsort", "namespace",
  "open", "package", "pid", "proc", "puts", "pwd", "read", "regexp",
  "regsub", "rename", "return", "scan", "seek", "set", "socket",
  "source", "split", "string", "subst", "switch", "tailcall", "tell",
  "throw", "time", "trace", "try", "unknown", "unload", "unset",
  "update", "uplevel", "upvar", "variable", "vwait", "while",
  "yield", "yieldto",
];

// Built once from KEYWORDS so the array stays the single source of truth.
const KEYWORD_PATTERN = new RegExp(`\\b(?:${KEYWORDS.join("|")})\\b`);

const MONARCH_RULES: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".tcl",

  keywords: KEYWORDS,

  brackets: [
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],

  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/"/, "string", "@string_double"],
      [/\{/, "string.curly", "@string_curly"],
      [/[\[\]{}()]/, "@brackets"],
      [/\$[a-zA-Z_]\w*/, "variable"],
      [/\$\{[^}]*\}/, "variable"],
      [KEYWORD_PATTERN, "keyword"],
      [/-?\d+\.\d+([eE][\-+]?\d+)?/, "number.float"],
      [/-?\d+/, "number"],
      [/[a-zA-Z_][\w-]*(?=\s*\()/, "entity.name.function"],
      [/[a-zA-Z_][\w-]*/, "identifier"],
      [/\s+/, "white"],
      [/[;,]/, "delimiter"],
    ],
    string_double: [
      [/[^\\"$]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    string_curly: [
      [/[^\\${}]+/, "string"],
      [/\\./, "string.escape"],
      [/\$\{[^{}]*\}/, "variable"],
      [/\$[a-zA-Z_]\w*/, "variable"],
      [/\{/, "string.curly", "@push"],
      [/\}/, "string.curly", "@pop"],
    ],
  },
};

const LANGUAGE_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["[", "]"],
    ["{", "}"],
    ["(", ")"],
    ['"', '"'],
  ],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

export function registerTcl(monaco: { languages: typeof import("monaco-editor").languages }): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({
    id: "tcl",
    extensions: [".tcl", ".tk"],
    aliases: ["Tcl", "tcl", "TCL"],
  });
  monaco.languages.setMonarchTokensProvider("tcl", MONARCH_RULES);
  monaco.languages.setLanguageConfiguration("tcl", LANGUAGE_CONFIG);
}
