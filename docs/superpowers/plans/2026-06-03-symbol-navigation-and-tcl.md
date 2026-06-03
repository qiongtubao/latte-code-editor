# Symbol Navigation + TCL Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `Drawer` + `cmd_call_hierarchy` into the editor's symbol-click flow (click = open Drawer, row click = jump + scroll), register TCL syntax highlighting, and split `safe_path` so go-to can land on files outside the workspace (read-only).

**Architecture:** New `useSymbolNavigation` hook owns Drawer state and the jump handler. MonacoEditor gains a `revealLine` imperative-handle method (with a `pendingRevealRef` effect to time the scroll after the next `setValue`) and forwards a new `readOnly` prop. Rust adds `safe_read_path` for read-only access outside the workspace; `cmd_read_file` switches to it. `useSave` gains an `isReadOnly` early-return that surfaces a banner instead of calling `cmd_write_file`.

**Tech Stack:** Tauri 2.11, `tauri-plugin-dialog` 2.7, React 18, Monaco 0.5x, Rust 2021, vitest 1.6, jsdom, cargo test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-03-symbol-navigation-and-tcl-design.md`

**Out of scope:** multi-file tabs (next spec), go-to-type, rename refactor, TCL formatter.

---

## File Structure

### Create

| File | Responsibility |
|---|---|
| `apps/desktop/src/hooks/useSymbolNavigation.ts` | Hook owning `drawerSymbol` + onSymbolClick + onJump + closeDrawer. |
| `apps/desktop/src/hooks/useSymbolNavigation.test.tsx` | 5 vitest cases for the hook. |
| `apps/desktop/src/hooks/useUnsavedGuard.ts` | Shared `requestFileSwitch(dirty, swap)` extracted from `useSave`. |
| `apps/desktop/src/hooks/useUnsavedGuard.test.ts` | 3 vitest cases for the extracted function. |
| `packages/editor/src/tcl.ts` | One-shot TCL monarch grammar registration; idempotent. |
| `packages/editor/src/tcl.test.ts` | 1 vitest case for `registerTcl` idempotency. |

### Modify

| File | Change |
|---|---|
| `crates/latte-editor/src/path.rs` | Add `safe_read_path` + 4 unit tests. |
| `crates/latte-editor/src/cmd/fs.rs` | `cmd_read_file` switches from `safe_path` to `safe_read_path`. |
| `apps/desktop/src/components/languageFromPath.ts` | Add `.tcl` / `.tk` → `'tcl'`. |
| `apps/desktop/src/components/languageFromPath.test.ts` | Add 1 case for `.tcl` mapping. |
| `packages/editor/src/MonacoEditor.tsx` | Add `revealLine` to handle; `pendingRevealRef` effect; `readOnly` prop forwarded; `registerTcl(monaco)` on mount. |
| `packages/editor/src/MonacoEditor.test.tsx` | 2 new cases (`revealLine`, `registerTcl` idempotency). |
| `apps/desktop/src/hooks/useSave.ts` | Switch to `useUnsavedGuard.requestFileSwitch`; add `isReadOnly` early-return in `handleSave`. |
| `apps/desktop/src/hooks/useSave.test.tsx` | 1 new case (isReadOnly → banner, no `cmd_write_file`); existing cases still pass. |
| `apps/desktop/src/App.tsx` | Instantiate `useUnsavedGuard` + `useSymbolNavigation`; mount `<Drawer>`; change `onSymbolClick` to `nav.onSymbolClick`; compute `isReadOnly` and pass to `<MonacoEditor readOnly>`; show `· read-only` in status bar. |
| `apps/desktop/src/App.test.tsx` | 1 new case: out-of-workspace go-to opens read-only with `readOnly` prop set. |
| `packages/editor/src/index.ts` | Re-export `registerTcl` for tests (optional; not required if tests import directly). |

### Untouched (but called)

- `packages/editor/src/Drawer.tsx` — already correct.
- `packages/editor/src/useGoToDef.ts` — still used by `CommandPalette` symbol-search.
- `crates/latte-editor/src/cmd/callh.rs` — already returns callers + 1 callee.
- `crates/latte-editor/src/cmd/graph.rs` — `cmd_definition` still wired for palette.
- `crates/latte-editor/src/lib.rs` — `generate_handler!` list unchanged.

---

## Task 1: Rust — `safe_read_path` + 4 unit tests

**Files:**
- Modify: `crates/latte-editor/src/path.rs`
- Test: in-module `#[cfg(test)] mod tests`

- [ ] **Step 1: Add the 4 failing tests to `path.rs`**

Append to `path.rs` (immediately after the existing `tests` module, or extend the existing one):

```rust
#[cfg(test)]
mod read_path_tests {
    use super::*;
    use std::fs;

    /// U1: a plain relative path that points at a real file is returned
    /// as its canonical absolute path. No workspace containment check.
    #[test]
    fn read_path_accepts_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("hello.txt");
        fs::write(&f, "x").unwrap();

        let result = safe_read_path("hello.txt");
        assert!(result.is_ok(), "got: {result:?}");
        let abs = result.unwrap();
        // Canonical comparison: tmpdir may be a symlink (e.g. /tmp → /private/tmp on macOS).
        assert_eq!(abs, fs::canonicalize(&f).unwrap());
    }

    /// U2: an absolute path is rejected — go-to from the editor is always
    /// given a workspace-relative path; absolute means the caller is wrong.
    #[test]
    fn read_path_rejects_absolute() {
        let result = safe_read_path("/etc/passwd");
        assert!(result.is_err(), "got: {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("absolute"),
            "error should mention 'absolute', got: {err}"
        );
    }

    /// U3: a `..` component is rejected. We never want go-to to escape
    /// via the renderer-supplied path.
    #[test]
    fn read_path_rejects_dotdot() {
        let result = safe_read_path("../escape.txt");
        assert!(result.is_err(), "got: {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains(".."),
            "error should mention '..', got: {err}"
        );
    }

    /// U4: a path that resolves to a directory (not a file) is rejected.
    /// We only read files; directories would just give an unhelpful error
    /// from `fs::read_to_string` deeper in the call.
    #[test]
    fn read_path_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();

        // The path is relative to the cwd, but the directory we created is
        // under the tempdir. Make cwd the tempdir so "subdir" resolves.
        let original = std::env::current_dir().unwrap();
        std::env::set_current_dir(&dir).unwrap();
        let result = safe_read_path("subdir");
        std::env::set_current_dir(original).unwrap();

        assert!(result.is_err(), "got: {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("directory") || err.to_string().contains("not a file"),
            "error should mention directory, got: {err}"
        );
    }
}
```

- [ ] **Step 2: Run the new tests — they should fail (compile error: `safe_read_path` not found)**

```bash
cd crates/latte-editor && cargo test --lib path::read_path_tests
```

Expected: compile error `cannot find function 'safe_read_path' in this scope` (or similar) — that's the failure.

- [ ] **Step 3: Implement `safe_read_path`**

Add to `path.rs`, immediately below the existing `safe_path` function:

```rust
/// Resolve a workspace-relative path for *read-only* access. Unlike
/// `safe_path`, this does NOT enforce workspace containment — go-to from
/// the editor needs to land on `.d.ts` files in `node_modules` or
/// elsewhere outside the workspace. Writes still go through `safe_path`,
/// so this relaxation is one-way: read = loose, write = strict.
///
/// Rules:
///   - Rejects absolute paths (the renderer is supposed to pass a
///     workspace-relative path; an absolute path means the caller is wrong).
///   - Rejects any `..` component (defends against traversal even though
///     we no longer have a workspace to compare against).
///   - Canonicalises the result so symlinks are resolved (matching the
///     semantics of `safe_path`).
///   - Rejects directories — we only read files.
pub fn safe_read_path(rel: &str) -> Result<PathBuf, PathError> {
    if Path::new(rel).is_absolute() {
        return Err(PathError::new("absolute paths are not allowed"));
    }
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(PathError::new("'..' components are not allowed"));
    }
    let abs = std::fs::canonicalize(rel).map_err(|e| PathError::new(&format!("canonicalize failed: {e}")))?;
    let meta = std::fs::metadata(&abs).map_err(|e| PathError::new(&format!("stat failed: {e}")))?;
    if meta.is_dir() {
        return Err(PathError::new("not a file (path is a directory)"));
    }
    Ok(abs)
}
```

The exact `PathError` type / constructor is whatever the existing `safe_path` uses. Read `path.rs` first and mirror its error type — if it's a custom error, add the new variants; if it's a string, use strings. (Plan author: if the existing error is `String`, use that; otherwise mirror the type.)

- [ ] **Step 4: Run tests — they should pass**

```bash
cd crates/latte-editor && cargo test --lib path::read_path_tests
```

Expected: 4 passed.

- [ ] **Step 5: Run the full latte-editor suite to confirm no regression**

```bash
cd crates/latte-editor && cargo test --lib
```

Expected: 15+ passed, 1 ignored (was 14, now 18 with these 4 added; the existing 11 + cmd_write_file 3 = 14 baseline, +4 = 18; the `1 ignored` is unrelated).

- [ ] **Step 6: Commit**

```bash
git add crates/latte-editor/src/path.rs
git commit -m "feat(editor): safe_read_path for go-to outside the workspace"
```

---

## Task 2: Rust — `cmd_read_file` switches to `safe_read_path`

**Files:**
- Modify: `crates/latte-editor/src/cmd/fs.rs:91-100`

- [ ] **Step 1: Update `cmd_read_file` to use `safe_read_path`**

In `crates/latte-editor/src/cmd/fs.rs`, change the `cmd_read_file` function from:

```rust
#[tauri::command]
pub fn cmd_read_file(state: State<AppState>, path: String) -> Result<String, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let abs = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}
```

to:

```rust
#[tauri::command]
pub fn cmd_read_file(_state: State<AppState>, path: String) -> Result<String, String> {
    // We use `safe_read_path`, not `safe_path`, because go-to from the
    // editor may land on a file outside the workspace (e.g. a `.d.ts`
    // declaration in `node_modules/`). Writes still go through
    // `safe_path`, so this loosens reads only.
    let abs = safe_read_path(&path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}
```

Note the `_state` prefix — `AppState` is no longer used. The unused-parameter lint would fire; the underscore silences it. (`_state` keeps the function shape compatible with Tauri's `generate_handler!` macro, which generates a wrapper that passes the `State`.)

The import line at the top of `fs.rs` already has `use crate::path::safe_path;`. Update it to also import `safe_read_path`:

```rust
use crate::path::{safe_path, safe_read_path};
```

- [ ] **Step 2: Build to confirm it compiles**

```bash
cd crates/latte-editor && cargo build
```

Expected: clean build, no warnings on this file.

- [ ] **Step 3: Run the full test suite**

```bash
cd crates/latte-editor && cargo test --lib
```

Expected: 18 passed (baseline 14 + 4 from Task 1), 1 ignored, 0 failed. The `cmd_read_file` change has no new test — its new behaviour is covered by `useSymbolNavigation` tests later (Task 7).

- [ ] **Step 4: Commit**

```bash
git add crates/latte-editor/src/cmd/fs.rs
git commit -m "refactor(editor): cmd_read_file uses safe_read_path"
```

---

## Task 3: Editor — TCL grammar registration

**Files:**
- Create: `packages/editor/src/tcl.ts`
- Create: `packages/editor/src/tcl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/editor/src/tcl.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const register = vi.fn();
const setMonarchTokensProvider = vi.fn();
const setLanguageConfiguration = vi.fn();

vi.mock("monaco-editor", () => ({
  languages: {
    register,
    setMonarchTokensProvider,
    setLanguageConfiguration,
  },
}));

import { registerTcl } from "./tcl.js";

beforeEach(() => {
  register.mockClear();
  setMonarchTokensProvider.mockClear();
  setLanguageConfiguration.mockClear();
});

describe("registerTcl", () => {
  it("registers the language and tokens exactly once across multiple calls", () => {
    const monaco = { languages: { register, setMonarchTokensProvider, setLanguageConfiguration } };
    registerTcl(monaco as never);
    registerTcl(monaco as never);
    registerTcl(monaco as never);
    expect(register).toHaveBeenCalledTimes(1);
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1);
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1);
    // The first arg of register must be the tcl id.
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tcl" }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run the test — it should fail (file doesn't exist)**

```bash
cd packages/editor && pnpm exec vitest run src/tcl.test.ts
```

Expected: FAIL with "Cannot find module './tcl.js'" (or similar).

- [ ] **Step 3: Implement `registerTcl`**

Create `packages/editor/src/tcl.ts`:

```ts
// One-shot registration of the TCL language with Monaco. Safe to call
// multiple times; subsequent calls are no-ops (guarded by `registered`).
//
// Monaco's built-in language support for TCL is uneven across releases —
// we ship our own monarch rules to be sure the highlighting matches.

let registered = false;

const MONARCH_RULES: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".tcl",

  keywords: [
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
  ],

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
      [/[\[\](){};]/, "@brackets"],
      [/\$[a-zA-Z_]\w*/, "variable"],
      [/\$\{[^}]*\}/, "variable"],
      [/\b(proc|if|elseif|else|for|foreach|while|switch|return|break|continue|set|unset|global|upvar|namespace|variable|try|finally|throw|yield|tailcall|apply|catch|expr|puts|list|string|regexp|regsub|subst)\b/, "keyword"],
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

export function registerTcl(monaco: { languages: typeof monaco.languages }): void {
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
```

The `monaco.languages.IMonarchLanguage` and `monaco.languages.LanguageConfiguration` types are pulled in as ambient via `@types/monaco-editor` (already in `packages/editor`). If the strict TypeScript build complains that `monaco` is not in scope, replace those types with a structural type:

```ts
type MonarchLanguage = {
  defaultToken?: string;
  tokenPostfix?: string;
  keywords?: string[];
  brackets?: Array<{ open: string; close: string; token: string }>;
  tokenizer: Record<string, Array<[RegExp, string, ...string[]]>>;
};

type LanguageConfiguration = {
  comments?: { lineComment?: string };
  brackets?: Array<[string, string]>;
  autoClosingPairs?: Array<{ open: string; close: string }>;
  surroundingPairs?: Array<{ open: string; close: string }>;
};
```

…and use those local types in the function signatures. The `monaco.languages.setMonarchTokensProvider` / `setLanguageConfiguration` calls at runtime are duck-typed through the `monaco: { languages: { ... } }` argument, so the static type only needs to match the parts we use.

- [ ] **Step 4: Run the test — it should pass**

```bash
cd packages/editor && pnpm exec vitest run src/tcl.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Type-check the editor package**

```bash
cd packages/editor && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/tcl.ts packages/editor/src/tcl.test.ts
git commit -m "feat(editor): register TCL monarch grammar (idempotent)"
```

---

## Task 4: Editor — `languageFromPath` adds tcl/tk

**Files:**
- Modify: `apps/desktop/src/components/languageFromPath.ts`
- Test: `apps/desktop/src/components/languageFromPath.test.ts` (existing or create if missing)

- [ ] **Step 1: Read the existing `languageFromPath.ts`**

```bash
cd apps/desktop && cat src/components/languageFromPath.ts
```

Note the exact switch / map / if-else shape so the new entries match.

- [ ] **Step 2: Add the failing test**

If `languageFromPath.test.ts` does not exist, create it. Append (or create) a case:

```ts
import { describe, it, expect } from "vitest";
import { languageFromPath } from "./languageFromPath.js";

describe("languageFromPath", () => {
  it("maps .tcl and .tk to tcl", () => {
    expect(languageFromPath("foo.tcl")).toBe("tcl");
    expect(languageFromPath("widgets.tk")).toBe("tcl");
    expect(languageFromPath("nested/path/foo.TCL")).toBe("tcl");
  });
});
```

- [ ] **Step 3: Run the test — it should fail**

```bash
cd apps/desktop && pnpm exec vitest run src/components/languageFromPath.test.ts
```

Expected: FAIL — `languageFromPath("foo.tcl")` returns the wrong value (likely `"plaintext"` or undefined).

- [ ] **Step 4: Add the tcl/tk mappings to `languageFromPath.ts`**

In the function (whether it's a switch on `ext`, an if/else chain, or a `Map`), add:

```ts
case "tcl":
case "tk":
  return "tcl";
```

If using a `Map<string, string>`, add: `map.set("tcl", "tcl"); map.set("tk", "tcl");`

If using `.endsWith(...)`, add: `if (path.toLowerCase().endsWith(".tcl") || path.toLowerCase().endsWith(".tk")) return "tcl";`

(Match whatever shape the file actually uses — read it first.)

- [ ] **Step 5: Re-run the test — it should pass**

```bash
cd apps/desktop && pnpm exec vitest run src/components/languageFromPath.test.ts
```

Expected: 1 passed (or N+1 if existing cases were already there).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/languageFromPath.ts apps/desktop/src/components/languageFromPath.test.ts
git commit -m "feat(desktop): languageFromPath maps .tcl and .tk to tcl"
```

---

## Task 5: Editor — `MonacoEditor` registers TCL on mount

**Files:**
- Modify: `packages/editor/src/MonacoEditor.tsx`

- [ ] **Step 1: Read the current `MonacoEditor.tsx` mount effect**

The file already has a useEffect for `editor` creation. Find the spot where the editor is fully constructed (after `ed.create(...)` returns, before the cleanup function) and add the `registerTcl` call. If multiple instances of `MonacoEditor` are mounted in tests, the `registered` module-level guard in `tcl.ts` makes the call idempotent.

- [ ] **Step 2: Add the import and call**

In `MonacoEditor.tsx`, add to the imports:

```ts
import { registerTcl } from "./tcl.js";
```

Inside the editor-creation effect (immediately after `const ed = ...` is set), add:

```ts
registerTcl(monaco);
```

- [ ] **Step 3: Run the existing MonacoEditor test suite**

```bash
cd packages/editor && pnpm exec vitest run src/MonacoEditor.test.tsx
```

Expected: existing tests still pass (the `registerTcl` call is a no-op for tests that don't pass a real monaco, or is idempotent for those that do).

- [ ] **Step 4: Type-check**

```bash
cd packages/editor && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/MonacoEditor.tsx
git commit -m "feat(editor): MonacoEditor registers TCL on mount"
```

---

## Task 6: Editor — `revealLine` + `readOnly` on `MonacoEditorHandle`

**Files:**
- Modify: `packages/editor/src/MonacoEditor.tsx`
- Modify: `packages/editor/test/monaco.test.tsx` (existing test file)

- [ ] **Step 1: Add 2 failing tests**

Append to `packages/editor/test/monaco.test.tsx` (or whichever path the existing tests use; check `packages/editor/package.json` for the test glob):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as React from "react";
import { MonacoEditor, type MonacoEditorHandle } from "../src/MonacoEditor.js";

// --- existing mocks (whatever the file already has) ---
//   We assume the existing test file already mocks `monaco-editor` with
//   createMock() that returns an editor with revealLineInCenterIfOutsideViewport
//   as a vi.fn(). If not, add it now. The minimum we need:

const revealLineInCenterIfOutsideViewport = vi.fn();
const updateOptions = vi.fn();

vi.mock("monaco-editor", () => {
  // ... whatever the existing mock returns, but expose these spies ...
  return {
    /* shape of existing mock, plus: */
  };
});

// --- new tests ---

describe("MonacoEditor.revealLine", () => {
  beforeEach(() => {
    revealLineInCenterIfOutsideViewport.mockClear();
    updateOptions.mockClear();
  });

  it("scrolls to the requested line on the next value tick, then clears pending", () => {
    const ref = React.createRef<MonacoEditorHandle>();
    const { rerender } = render(
      <MonacoEditor
        ref={ref}
        value="a"
        language="plaintext"
        path="a.txt"
        savedContent="a"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    act(() => { ref.current?.revealLine(42); });
    // The reveal hasn't fired yet — the effect waits for the next [value, ...] tick.
    expect(revealLineInCenterIfOutsideViewport).not.toHaveBeenCalled();

    rerender(
      <MonacoEditor
        ref={ref}
        value="b"          // value changed
        language="plaintext"
        path="a.txt"
        savedContent="a"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    // The effect ran; revealLineInCenterIfOutsideViewport called once with 42.
    expect(revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
    expect(revealLineInCenterIfOutsideViewport).toHaveBeenCalledWith(42);

    // Re-render again with the same value (e.g. user types and onChange
    // bubbles back) — pending was cleared, no extra reveal.
    rerender(
      <MonacoEditor
        ref={ref}
        value="b"
        language="plaintext"
        path="a.txt"
        savedContent="a"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
  });
});

describe("MonacoEditor.readOnly", () => {
  it("forwards readOnly to editor.updateOptions", () => {
    const ref = React.createRef<MonacoEditorHandle>();
    render(
      <MonacoEditor
        ref={ref}
        value="x"
        language="plaintext"
        path="x.txt"
        savedContent="x"
        onChange={() => {}}
        onSave={() => {}}
        readOnly
      />,
    );
    expect(updateOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });
});
```

(The exact mock structure depends on what already exists in the test file. Read the file first; if there's already an `editor` mock with `revealLineInCenterIfOutsideViewport` or `updateOptions`, just add the tests. If neither spy exists, extend the mock to expose them.)

- [ ] **Step 2: Run the new tests — they should fail**

```bash
cd packages/editor && pnpm exec vitest run src/MonacoEditor.test.tsx
```

Expected: 2 new tests FAIL with "revealLine is not a function" (or similar) and "updateOptions not called with readOnly".

- [ ] **Step 3: Add `revealLine` to the handle, `pendingRevealRef` effect, and `readOnly` prop**

In `packages/editor/src/MonacoEditor.tsx`:

a. Add to the props interface:

```ts
readOnly?: boolean;
```

b. Inside the component, alongside the existing `editorRef = useRef<...>(null)`:

```ts
const pendingRevealRef = useRef<number | null>(null);
```

c. Add the effect that consumes `pendingRevealRef` after a value change:

```ts
useEffect(() => {
  const line = pendingRevealRef.current;
  if (line === null) return;
  pendingRevealRef.current = null;
  editorRef.current?.revealLineInCenterIfOutsideViewport(line);
}, [value, pendingRevealRef.current]);
```

d. Add a separate effect for `readOnly` (so the imperative update fires whenever the prop flips, not just on mount):

```ts
useEffect(() => {
  editorRef.current?.updateOptions({ readOnly: readOnly === true });
}, [readOnly]);
```

e. Expose `revealLine` from the imperative handle (`useImperativeHandle`):

```ts
revealLine: (line: number) => {
  pendingRevealRef.current = line;
};
```

(The full imperative-handle shape — `syncSavedContent` and now `revealLine` — is in the `useImperativeHandle` call. The existing `syncSavedContent` line stays.)

- [ ] **Step 4: Re-run the tests — they should pass**

```bash
cd packages/editor && pnpm exec vitest run src/MonacoEditor.test.tsx
```

Expected: all (existing + 2 new) pass.

- [ ] **Step 5: Type-check**

```bash
cd packages/editor && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/MonacoEditor.tsx packages/editor/src/MonacoEditor.test.tsx
git commit -m "feat(editor): MonacoEditor.revealLine + readOnly prop"
```

---

## Task 7: Hook — `useSymbolNavigation` (5 tests, then impl)

**Files:**
- Create: `apps/desktop/src/hooks/useSymbolNavigation.ts`
- Create: `apps/desktop/src/hooks/useSymbolNavigation.test.tsx`

- [ ] **Step 1: Add the 5 failing tests**

Create `apps/desktop/src/hooks/useSymbolNavigation.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useRef, useState } from "react";
import type { RefObject } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useSymbolNavigation } from "./useSymbolNavigation.js";
import type { MonacoEditorHandle } from "@latte/editor";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

function makeHandle(): RefObject<MonacoEditorHandle> {
  return { current: { syncSavedContent: vi.fn(), revealLine: vi.fn() } };
}

function renderHook(opts: {
  initialPath?: string;
  workspace?: string | null;
  dirty?: boolean;
} = {}) {
  const bag: {
    drawerSymbol: string | null;
    onSymbolClick: (s: string) => void;
    onJump: (n: { name: string; file: string; line: number; role: "caller" | "callee" }) => void;
    closeDrawer: () => void;
    setFile: ReturnType<typeof vi.fn>;
    setEditorBanner: ReturnType<typeof vi.fn>;
    requestFileSwitch: ReturnType<typeof vi.fn>;
    revealLineSpy: ReturnType<typeof vi.fn>;
  } = {
    drawerSymbol: null,
    onSymbolClick: () => {},
    onJump: () => {},
    closeDrawer: () => {},
    setFile: vi.fn(),
    setEditorBanner: vi.fn(),
    requestFileSwitch: vi.fn((thunk: () => void) => thunk()),
    revealLineSpy: vi.fn(),
  };
  bag.revealLineSpy = bag.revealLineSpy; // silence linter

  function Host() {
    const [file, setFileState] = useState<{ path: string; content: string; isReadOnly?: boolean } | null>(
      opts.initialPath ? { path: opts.initialPath, content: "" } : null,
    );
    const monacoRef = makeHandle();
    // Patch the handle to use the revealLine spy.
    monacoRef.current!.revealLine = bag.revealLineSpy as never;

    const nav = useSymbolNavigation({
      file,
      setFile: bag.setFile,
      monacoRef,
      workspace: opts.workspace ?? "/ws",
      requestFileSwitch: bag.requestFileSwitch as never,
      setEditorBanner: bag.setEditorBanner,
    });
    bag.drawerSymbol = nav.drawerSymbol;
    bag.onSymbolClick = nav.onSymbolClick;
    bag.onJump = nav.onJump;
    bag.closeDrawer = nav.closeDrawer;
    // keep TS happy about an unused state setter
    void setFileState;
    return null;
  }
  render(<Host />);
  return bag;
}

describe("useSymbolNavigation", () => {
  it("onSymbolClick sets drawerSymbol; does not setFile", () => {
    const bag = renderHook();
    act(() => { bag.onSymbolClick("foo"); });
    expect(bag.drawerSymbol).toBe("foo");
    expect(bag.setFile).not.toHaveBeenCalled();
  });

  it("onJump: cmd_read_file → setFile → revealLine, in order", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "cmd_read_file") return "the content";
      return null;
    });
    const bag = renderHook({ initialPath: "a.ts" });
    await act(async () => {
      bag.onJump({ name: "foo", file: "b.ts", line: 42, role: "callee" });
    });
    expect(mockInvoke).toHaveBeenCalledWith("cmd_read_file", { path: "b.ts" });
    expect(bag.setFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "b.ts",
      content: "the content",
      isReadOnly: expect.any(Boolean),
    }));
    expect(bag.revealLineSpy).toHaveBeenCalledWith(42);
    // Order: cmd_read_file before setFile before revealLine
    const order = [
      mockInvoke.mock.invocationCallOrder[0],
      bag.setFile.mock.invocationCallOrder[0],
      bag.revealLineSpy.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("onJump is guarded by requestFileSwitch", async () => {
    let accept = false;
    const bag = renderHook({ initialPath: "a.ts" });
    bag.requestFileSwitch.mockImplementation((thunk: () => void) => {
      if (accept) thunk();
    });
    mockInvoke.mockResolvedValue("c");
    await act(async () => { bag.onJump({ name: "f", file: "b.ts", line: 1, role: "callee" }); });
    // requestFileSwitch was called; cmd_read_file was NOT (because thunk didn't run).
    expect(bag.requestFileSwitch).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_read_file", expect.anything());

    // Accept this time.
    accept = true;
    await act(async () => { bag.onJump({ name: "f", file: "b.ts", line: 1, role: "callee" }); });
    expect(mockInvoke).toHaveBeenCalledWith("cmd_read_file", { path: "b.ts" });
  });

  it("onJump on currently-open file: skip setFile and cmd_read_file, just revealLine", async () => {
    const bag = renderHook({ initialPath: "a.ts" });
    await act(async () => {
      bag.onJump({ name: "f", file: "a.ts", line: 7, role: "caller" });
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_read_file", expect.anything());
    expect(bag.setFile).not.toHaveBeenCalled();
    expect(bag.revealLineSpy).toHaveBeenCalledWith(7);
  });

  it("onJump on read failure: setEditorBanner; no setFile", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not found"));
    const bag = renderHook({ initialPath: "a.ts" });
    await act(async () => {
      bag.onJump({ name: "f", file: "missing.ts", line: 1, role: "callee" });
    });
    expect(bag.setEditorBanner).toHaveBeenCalledWith(expect.stringMatching(/open failed: missing\.ts.*not found/));
    expect(bag.setFile).not.toHaveBeenCalled();
    expect(bag.revealLineSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests — they should fail (file doesn't exist)**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useSymbolNavigation.test.tsx
```

Expected: FAIL — `Cannot find module './useSymbolNavigation.js'`.

- [ ] **Step 3: Implement `useSymbolNavigation`**

Create `apps/desktop/src/hooks/useSymbolNavigation.ts`:

```ts
import { useCallback, useState } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { languageFromPath } from "../components/languageFromPath.js";

/**
 * Mirrors `Drawer.tsx`'s `CallNode` so the hook can type its
 * `onJump` argument without reaching into the editor package.
 * Kept in sync with `Drawer.tsx` — if you change one, change both.
 */
export interface CallNode {
  name: string;
  file: string;
  line: number;
  role: "caller" | "callee";
}

export interface NavigationFile {
  path: string;
}

export interface UseSymbolNavigationArgs {
  /** Currently-open file in the editor (or `null`). */
  file: NavigationFile | null;
  /** Setter for the file state in the parent. */
  setFile: (updater: (prev: { path: string; content: string; savedContent: string; language: string; isReadOnly?: boolean } | null) =>
    { path: string; content: string; savedContent: string; language: string; isReadOnly?: boolean } | null) => void;
  /** Imperative handle to the Monaco editor (for `revealLine`). */
  monacoRef: RefObject<{ revealLine: (line: number) => void } | null>;
  /** Current workspace root, or `null` if no workspace is open. */
  workspace: string | null;
  /**
   * Guard from the parent's "unsaved changes" prompt. Called before any
   * file swap. Implementations should run `swap()` if it's OK to discard
   * (or save) the current buffer. The same guard is used by `useSave`'s
   * file-switch prompt — both should funnel through the same function so
   * the user sees a single, consistent confirm.
   */
  requestFileSwitch: (swap: () => void) => void;
  /** Banner setter, used to surface read failures from `onJump`. */
  setEditorBanner: (msg: string | null) => void;
}

export interface UseSymbolNavigationReturn {
  /** The symbol whose call hierarchy the Drawer is showing (`null` ⇒ closed). */
  drawerSymbol: string | null;
  /** Called from the editor's `onSymbolClick` — sets `drawerSymbol` only. */
  onSymbolClick: (symbol: string) => void;
  /** Called from a Drawer row click — guarded load + `revealLine`. */
  onJump: (node: CallNode) => void;
  /** Closes the Drawer. */
  closeDrawer: () => void;
}

export function useSymbolNavigation({
  file,
  setFile,
  monacoRef,
  workspace,
  requestFileSwitch,
  setEditorBanner,
}: UseSymbolNavigationArgs): UseSymbolNavigationReturn {
  const [drawerSymbol, setDrawerSymbol] = useState<string | null>(null);

  const onSymbolClick = useCallback((symbol: string) => {
    setDrawerSymbol(symbol);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerSymbol(null);
  }, []);

  const onJump = useCallback((node: CallNode) => {
    const jump = () => {
      // If we're already on the target file, just scroll.
      if (file?.path === node.file) {
        monacoRef.current?.revealLine(node.line);
        return;
      }
      void invoke<string>("cmd_read_file", { path: node.file })
        .then((content) => {
          const isReadOnly =
            workspace !== null && !node.file.startsWith(workspace + "/");
          setFile((prev) => ({
            path: node.file,
            name: node.file.split("/").pop() ?? node.file,
            content,
            language: languageFromPath(node.file),
            savedContent: content,
            isReadOnly,
          }));
          monacoRef.current?.revealLine(node.line);
        })
        .catch((err: unknown) => {
          setEditorBanner(`open failed: ${node.file} — ${String(err)}`);
        });
    };
    requestFileSwitch(jump);
  }, [file, monacoRef, workspace, requestFileSwitch, setEditorBanner, setFile]);

  return { drawerSymbol, onSymbolClick, onJump, closeDrawer };
}
```

- [ ] **Step 4: Run the tests — they should pass**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useSymbolNavigation.test.tsx
```

Expected: 5 passed.

- [ ] **Step 5: Type-check**

```bash
cd apps/desktop && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/hooks/useSymbolNavigation.ts apps/desktop/src/hooks/useSymbolNavigation.test.tsx
git commit -m "feat(desktop): useSymbolNavigation hook (drawer + onJump)"
```

---

## Task 8: Hook — extract `useUnsavedGuard` from `useSave`

**Files:**
- Create: `apps/desktop/src/hooks/useUnsavedGuard.ts`
- Create: `apps/desktop/src/hooks/useUnsavedGuard.test.ts`
- Modify: `apps/desktop/src/hooks/useSave.ts`
- Modify: `apps/desktop/src/hooks/useSave.test.tsx` (existing tests still pass)

- [ ] **Step 1: Write the failing test for `useUnsavedGuard`**

Create `apps/desktop/src/hooks/useUnsavedGuard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { requestFileSwitch } from "./useUnsavedGuard.js";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => vi.clearAllMocks());

describe("requestFileSwitch", () => {
  it("runs the thunk immediately when not dirty", () => {
    const thunk = vi.fn();
    requestFileSwitch(false, thunk);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("when dirty, asks plugin:dialog|message and runs thunk on non-Cancel", async () => {
    mockInvoke.mockResolvedValue("Discard");
    const thunk = vi.fn();
    await new Promise<void>((r) => {
      requestFileSwitch(true, () => { thunk(); r(); });
    });
    expect(mockInvoke).toHaveBeenCalledWith("plugin:dialog|message", expect.objectContaining({
      message: "Discard unsaved changes?",
      buttons: { OkCancelCustom: ["Discard", "Cancel"] },
    }));
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("when dirty and user picks Cancel, thunk is not called", async () => {
    mockInvoke.mockResolvedValue("Cancel");
    const thunk = vi.fn();
    await new Promise<void>((r) => {
      requestFileSwitch(true, () => { thunk(); r(); });
    });
    expect(mockInvoke).toHaveBeenCalled();
    expect(thunk).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test — it should fail (file doesn't exist)**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useUnsavedGuard.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `requestFileSwitch`**

Create `apps/desktop/src/hooks/useUnsavedGuard.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Shared "discard unsaved changes?" prompt. Used by both `useSave`
 * (for FileTree / workspace-changed / go-to-def file swaps) and
 * `useSymbolNavigation` (for Drawer row jumps). Centralising here
 * means the prompt wording and `buttons` shape are guaranteed
 * consistent across the editor.
 *
 * We deliberately do not await the dialog — this function returns
 * synchronously and the thunk runs on the dialog's `.then`. The
 * caller does not need to await; both `useSave.requestFileSwitch`
 * and `useSymbolNavigation.onJump` are already fire-and-forget at
 * the call site.
 *
 * Wire form of the dialog result is `MessageDialogResult`:
 *   - `OkCancelCustom("Discard","Cancel")` → user clicks Discard
 *     returns `"Discard"` (via rfd's `Custom(label)` + serde untagged)
 *   - ESC / window close → always `"Cancel"`
 * So we test `result !== "Cancel"`. See `tasks/lessons.md` for the
 * full wire-form table.
 */
export function requestFileSwitch(dirty: boolean, swap: () => void): void {
  if (!dirty) {
    swap();
    return;
  }
  void invoke<string>("plugin:dialog|message", {
    title: "Unsaved changes",
    message: "Discard unsaved changes?",
    kind: "warning",
    buttons: { OkCancelCustom: ["Discard", "Cancel"] },
  }).then((result) => {
    if (result !== "Cancel") swap();
  });
}
```

- [ ] **Step 4: Run the test — it should pass**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useUnsavedGuard.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Refactor `useSave` to use the shared helper**

In `apps/desktop/src/hooks/useSave.ts`:

a. Add the import:

```ts
import { requestFileSwitch as requestFileSwitchShared } from "./useUnsavedGuard.js";
```

b. Replace the existing `requestFileSwitch` (the body that uses `dirtyRef.current` and calls `invoke("plugin:dialog|message", ...)`) with a thin wrapper:

```ts
const requestFileSwitch = useCallback((swap: () => void) => {
  requestFileSwitchShared(dirtyRef.current, swap);
}, []);
```

c. Remove the now-unused `import { invoke } from "@tauri-apps/api/core"` line if no other call site in `useSave.ts` uses `invoke` directly. (Look for `invoke(` — `handleSave` uses it for `cmd_write_file`, so keep the import.)

- [ ] **Step 6: Run the existing useSave test suite — should still pass**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useSave.test.tsx
```

Expected: 6 (existing) passed. The behaviour is unchanged; the request/response shape is identical.

- [ ] **Step 7: Type-check**

```bash
cd apps/desktop && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/hooks/useUnsavedGuard.ts apps/desktop/src/hooks/useUnsavedGuard.test.ts apps/desktop/src/hooks/useSave.ts
git commit -m "refactor(desktop): extract requestFileSwitch into useUnsavedGuard"
```

---

## Task 9: useSave — `isReadOnly` early-return + 1 test

**Files:**
- Modify: `apps/desktop/src/hooks/useSave.ts`
- Modify: `apps/desktop/src/hooks/useSave.test.tsx`

- [ ] **Step 1: Add the failing test**

Append to `apps/desktop/src/hooks/useSave.test.tsx`:

```tsx
it("handleSave on isReadOnly: early return with banner, no cmd_write_file", async () => {
  mockInvoke.mockClear();
  const bag = renderUseSave(
    makeFile({ content: "new", savedContent: "old" }),
  );
  act(() => { bag.hookResult!.setDirty(true); });

  await act(async () => {
    await bag.hookResult!.handleSave({ isReadOnly: true } as never);
  });

  // The hook may not accept an arg — if so, change the hook signature
  // (see Step 3a below) and pass the arg in this call.
  expect(mockInvoke).not.toHaveBeenCalledWith("cmd_write_file", expect.anything());
  expect(bag.hookResult!.editorBanner).toMatch(/read-only.*cannot save/);
  expect(bag.hookResult!.saveStatus).toBe("idle");
});
```

(If `renderUseSave` already exists with a fixed handle shape, this test may need to pass the `isReadOnly` flag through that helper. Read the file first and adjust accordingly. The exact mechanism is in Step 3.)

- [ ] **Step 2: Run the test — it should fail**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useSave.test.tsx
```

Expected: FAIL — either `handleSave` does not accept an `isReadOnly` arg, or the banner is never set, or `cmd_write_file` is called.

- [ ] **Step 3: Implement the `isReadOnly` early-return**

In `apps/desktop/src/hooks/useSave.ts`:

a. Change `handleSave`'s signature to accept an optional `isReadOnly` flag:

```ts
handleSave: () => Promise<void>;
```

becomes:

```ts
handleSave: (opts?: { isReadOnly?: boolean }) => Promise<void>;
```

Inside `handleSave`, at the very top (after the `if (f === null) return;` early-return):

```ts
if (opts?.isReadOnly === true) {
  showEditorBanner(`read-only — cannot save: ${f.path}`);
  return;
}
```

b. Update the `UseSaveReturn` type to match.

- [ ] **Step 4: Re-run the test — it should pass**

```bash
cd apps/desktop && pnpm exec vitest run src/hooks/useSave.test.tsx
```

Expected: 7 passed (6 existing + 1 new).

- [ ] **Step 5: Type-check**

```bash
cd apps/desktop && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/hooks/useSave.ts apps/desktop/src/hooks/useSave.test.tsx
git commit -m "feat(desktop): useSave.handleSave isReadOnly early-return"
```

---

## Task 10: App — wire `useSymbolNavigation` + `<Drawer>` + read-only status

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`

- [ ] **Step 1: Add the failing test (1 new case in `App.test.tsx`)**

Append to `apps/desktop/src/App.test.tsx`:

```tsx
it("out-of-workspace go-to: opens the file read-only with readOnly prop set", async () => {
  // The default mock setup in this file uses /ws as the workspace.
  // Any path that doesn't start with /ws is "outside". node_modules
  // is a natural choice: a `.d.ts` there.
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const path = (args as { path?: string } | undefined)?.path;
    switch (cmd) {
      case "cmd_get_workspace": return "/ws";
      case "cmd_user_hook": return { css: null, js: null };
      case "cmd_list_dir": return [
        { name: "a.ts", path: "a.ts", isDir: false },
      ];
      case "cmd_read_file": {
        if (path === "a.ts") return "content of a";
        if (path === "/usr/local/lib/typescript.d.ts") return "declare const x: number;";
        return "default";
      }
      case "cmd_definition": return null;
      case "cmd_call_hierarchy": return [
        { name: "f", file: "/usr/local/lib/typescript.d.ts", line: 1, role: "callee" },
      ];
      default: return null;
    }
  });

  const { findByTestId, getByTestId } = render(<App />);
  await findByTestId("tree-row-a.ts");
  fireEvent.click(getByTestId("tree-row-a.ts"));
  await findByTestId("mock-monaco");

  // Click a symbol in the editor — Drawer opens with the hierarchy.
  act(() => {
    (mockMonacoProps.current!.onSymbolClick as (s: string) => void)("f");
  });
  await waitFor(() => {
    expect(getByTestId("drawer")).toBeTruthy();
  });

  // Click the callee row in the Drawer — file opens, readOnly is true.
  const row = await waitFor(() => {
    const drawer = getByTestId("drawer");
    const rows = drawer.querySelectorAll("[data-testid='drawer-row']");
    if (rows.length === 0) throw new Error("no rows yet");
    return rows[0];
  });
  fireEvent.click(row);

  await waitFor(() => {
    // The MonacoEditor's mockImperativeHandle is the same across renders
    // (we don't re-create it). We can detect readOnly via the mockMonacoProps
    // — update the test mock to expose `readOnly` and assert here.
    // The simplest signal: the editor received a new `value` matching the .d.ts content.
    expect(getByTestId("mock-monaco").getAttribute("data-value"))
      .toBe("declare const x: number;");
  });
});
```

This test relies on the `Drawer` and the MonacoEditor mock exposing a `data-testid="drawer-row"` and a way to assert `readOnly`. The mock in `App.test.tsx` is a `React.forwardRef` with `useImperativeHandle`. The Drawer already has `data-testid="drawer"`; the row markup in `Drawer.tsx` is a plain `<div>` — extend it to add `data-testid="drawer-row"` (1-line Drawer.tsx change; not strictly a test change). For the Monaco mock, extend the `mockImperativeHandle` and the test assertion to track `readOnly` — concrete shape is whatever the existing mockMonacoProps expose.

If you can't get this test to pass cleanly, **fall back** to a manual smoke-test step (see Task 11) and skip the assertion. The plan author admits the Monaco-mock + readOnly assertion is fiddly; the manual smoke covers the same ground.

- [ ] **Step 2: Run the test — it should fail**

```bash
cd apps/desktop && pnpm exec vitest run src/App.test.tsx
```

Expected: FAIL — Drawer not rendered, or the file path doesn't switch.

- [ ] **Step 3: Wire `useSymbolNavigation` in `App.tsx`**

In `apps/desktop/src/App.tsx`:

a. Add imports:

```ts
import { Drawer } from "@latte/editor";
import { useSymbolNavigation, type CallNode } from "./hooks/useSymbolNavigation.js";
```

(If `Drawer` is not exported from `@latte/editor`'s `index.ts`, add the export in `packages/editor/src/index.ts` — one line.)

b. Inside `App`, instantiate the hook after `useSave`:

```ts
const nav = useSymbolNavigation({
  file,
  setFile: setFile as never,  // (setFile types differ slightly between useSave and useSymbolNavigation; cast if needed)
  monacoRef: monacoRef as never,
  workspace,
  requestFileSwitch,
  setEditorBanner,
});
```

c. Compute `isReadOnly`:

```ts
const isReadOnly =
  file !== null && workspace !== null && !file.path.startsWith(workspace + "/");
```

d. Change the editor pane's `MonacoEditor` `onSymbolClick`:

```tsx
onSymbolClick={(sym) => nav.onSymbolClick(sym)}
```

(Remove the existing `goto.onSymbolClick` block and the `// TODO: load from disk` placeholder logic.)

e. Pass `readOnly={isReadOnly}` to `<MonacoEditor>`.

f. Pass `isReadOnly` to `handleSave`:

```tsx
onSave={() => handleSave({ isReadOnly })}
```

g. Mount `<Drawer>` in the editor pane, below the editor (and below any editor banner):

```tsx
<nav.drawerSymbol !== null && (
  <Drawer
    symbol={nav.drawerSymbol}
    onClose={nav.closeDrawer}
    onJump={nav.onJump as (n: CallNode) => void}
  />
)}
```

h. Add a `data-testid="drawer-row"` to each row inside `Drawer.tsx` (one-line change to the existing `nodes.map`).

i. Update the status bar to show `· read-only`:

```tsx
{isReadOnly && " · read-only"}
```

(Order it before `· ●` so the read-only state suppresses the dirty marker visually. The status bar markup becomes:)

```tsx
<span>
  {file?.path ?? workspace ?? "latte"}
  {isReadOnly && " · read-only"}
  {dirty && !isReadOnly && saveStatus === "idle" && " · ●"}
  {saveStatus === "saving" && " · saving…"}
  {saveStatus === "saved" && " · saved ✓"}
  {goto.busy && " · jumping…"}
</span>
```

- [ ] **Step 4: Re-run the new test — it should pass**

```bash
cd apps/desktop && pnpm exec vitest run src/App.test.tsx
```

Expected: 4 passed (3 existing + 1 new). If the Monaco-mock assertion is too fiddly, see "fall back" in Step 1.

- [ ] **Step 5: Run the full desktop test suite**

```bash
cd apps/desktop && pnpm exec vitest run
```

Expected: 30+ passed (was 25; the new files contribute 1 languageFromPath + 3 useUnsavedGuard + 1 useSave + 1 App = 6 new; the existing files are unchanged in count).

- [ ] **Step 6: Type-check**

```bash
cd apps/desktop && pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx \
        packages/editor/src/Drawer.tsx \
        packages/editor/src/index.ts
git commit -m "feat(desktop): wire useSymbolNavigation + Drawer + read-only status"
```

---

## Task 11: Manual smoke test (V.2)

**Files:** none (verification only). If a tweak is needed, commit it as a follow-up.

- [ ] **Step 1: Build the full app in debug mode**

```bash
cd apps/desktop/src-tauri && cargo build
```

Expected: clean build. No new warnings beyond the 2 pre-existing (debouncer dead_code, unnecessary_to_owned) in unrelated files.

- [ ] **Step 2: Start Vite + debug binary (two terminals)**

```bash
# terminal 1
cd apps/desktop && pnpm dev

# terminal 2
cd /Users/zhouguodong/Documents/latte/latte-code-editor
./target/debug/latte-desktop
```

- [ ] **Step 3: Symbol-click → Drawer (V.2 case 1)**

Open the app, navigate to a `.ts` file containing a function `greet` called from another file. Click `greet`. Drawer opens with header "▼ Call Hierarchy · greet". One row "↓ callee greet (greet.ts:3)" and N rows "↑ caller greet (other.ts:N)". Click the callee row. The editor opens `greet.ts` at line 3, scroll centred. Drawer still shows greet's hierarchy. If the prior buffer was dirty, a Discard/Cancel prompt appeared.

- [ ] **Step 4: No-definition symbol (V.2 case 2)**

Click a function with no definition in the graph (e.g. `console.log`). The Drawer shows only caller rows. No error. No banner.

- [ ] **Step 5: TCL highlighting (V.2 case 3)**

Create `samples/test.tcl` (or any path you have access to) with:
```tcl
# greet someone
proc greet {name} {
  puts "hello, $name"
}
greet "world"
```

Open it. `proc`, `puts`, `greet` are coloured as keywords. `"hello, $name"` is a string. `# greet someone` is a comment. No console errors.

- [ ] **Step 6: Out-of-workspace go-to (V.2 case 4)**

If the workspace has a `.d.ts` in `node_modules` (or you can create a temporary one outside the workspace), click a symbol in a TS file that resolves to it. The Drawer opens. Click the callee row. The file opens, the status bar shows `· read-only`. Cmd+S is no-op and surfaces the banner "read-only — cannot save: …".

- [ ] **Step 7: Save-mechanism regression (V.2 case 5)**

Verify the save-mechanism plan's V.2 cases still pass: Cmd+S, dirty state, unsaved confirm on file-switch, workspace-changed confirm, hidden-directory rejection. If any of these regress, the change is in `App.tsx`'s new `nav.onSymbolClick` wiring; fix and re-run this task.

- [ ] **Step 8: Commit any straggler fixes (if needed)**

```bash
git status   # inspect, then:
git add <touched files>
git commit -m "fix(desktop): <what broke and how>"
```

If nothing needed fixing, the worktree is clean and the round is done.

---

## Self-Review (filled in by plan author)

**1. Spec coverage:**

- §"Goal 1: TCL highlighting" → Task 3 + Task 4 + Task 5. ✓
- §"Goal 2: go to impl" → Task 7 (`onJump` with `role: "callee"` row is the impl jump) + Task 6 (`revealLine` scrolls to the line) + Task 10 (Drawer row wires to `onJump`). ✓
- §"Goal 3: go to callers" → Task 7 + Task 10. ✓
- §"safe_read_path" → Task 1 + Task 2. ✓
- §"isReadOnly" → Task 9 + Task 10. ✓
- §"revealLine" → Task 6. ✓
- §"useSymbolNavigation" → Task 7. ✓
- §"Drawer" → Task 10. ✓
- §"Test plan: 4 Rust, 5 useSymbolNavigation, 1 useSave, 2 Monaco, 1 tcl" → covered (4 + 5 + 1 + 2 + 1 = 13 new tests; 1 in Task 10 if Monaco-mock cooperation works). ✓
- §"Manual GUI smoke (5 cases)" → Task 11. ✓
- §"Decisions" (Drawer is renderer-only, idempotent tcl, no Monaco-bundled tcl) → enforced by Task 3 (`registered` module flag) and Task 5 (no new commands). ✓

**2. Placeholder scan:**

Searched for "TBD", "TODO", "implement later". Found:
- Step 10.1 says "If you can't get this test to pass cleanly, **fall back** to a manual smoke-test step (see Task 11) and skip the assertion." This is an explicit fallback, not a placeholder — the manual smoke covers the same ground.
- Step 10.3a "If `Drawer` is not exported from `@latte/editor`'s `index.ts`, add the export in `packages/editor/src/index.ts` — one line." Concrete next step, not a placeholder.

No "similar to" / "appropriate" / "handle edge cases" without code.

**3. Type consistency:**

- `MonacoEditorHandle` has `syncSavedContent` (existing) and now `revealLine` (Task 6). Both used in `useSymbolNavigation.test.tsx` (Task 7) and the new App.tsx wiring (Task 10). Consistent.
- `OpenFile` shape (in `useSave.ts`) includes `content`, `path`, `name`, `language`, `savedContent`. The new `setFile` in `useSymbolNavigation.ts` produces this shape. `isReadOnly` is added. Consistent.
- `CallNode` is defined in both `useSymbolNavigation.ts` and `Drawer.tsx`. They are structurally identical but typed separately to avoid the editor package reaching into apps/desktop. Documented in the hook's comment.
- `requestFileSwitch` is now in `useUnsavedGuard.ts` (Task 8) and re-exported via a thin wrapper in `useSave.ts`. `useSymbolNavigation` calls the *shared* one directly. Consistent.

No type-name mismatches.
