# Symbol Navigation + TCL Highlighting — Design Spec

**Date:** 2026-06-03
**Scope:** One design covering three sub-features that ship as a single
implementation cycle. A separate spec covers multi-file tabs (deferred
to the next round).
**Status:** Draft for review.

---

## Goal

Close the gap between "backend can answer questions about the code
graph" and "the user can ask those questions from the editor":

1. **TCL syntax highlighting.** `.tcl` files render as coloured source
   in Monaco. Monarch grammar registered once at editor mount.
2. **Go to function implementation.** Clicking a symbol in Monaco
   shows a Drawer panel listing that symbol's callers and its
   implementation. Clicking the implementation row in the Drawer
   opens the file and scrolls to the definition line.
3. **Go to callers.** Same Drawer, the callers rows. Click any
   caller to open the file at that call site.

`cmd_definition` / `cmd_references` / `cmd_call_hierarchy` already
exist on the Rust side; `Drawer.tsx` and `useGoToDef` already exist
on the renderer side. The work is *wiring*, with three small
additions: a `useSymbolNavigation` hook, a `revealLine` imperative
handle method, and a `safe_read_path` that lets go-to land on files
outside the workspace (read-only).

---

## Non-goals

- **Multi-file tabs.** Open a file with go-to → current file closes.
  This is a known wart; the next spec addresses it.
- **Go-to from a *call* (vs. a definition).** Clicking on a function
  *name* in a caller file currently shows the call hierarchy for
  that name. We do not yet support "go to the specific call site in
  the caller file from the definition"; that's implicit in the
  existing data flow because the caller's file:line is already
  in the Drawer.
- **TCL formatter / auto-indent.** Monarch tokens only. Bracket
  matching comes for free from Monaco's built-in bracket scanner.
- **Refactoring from Drawer.** No "rename" / "go to type" / "find all
  references" beyond what the Drawer already shows.
- **Persisting Drawer state across launches.** The Drawer opens on
  click, closes on the X, and is forgotten on relaunch.
- **Speculative `safe_read_path` for untrusted paths.** We allow
  reads outside the workspace as long as the path doesn't traverse
  via `..` and points at a real file. We do not implement any
  additional sandboxing.

---

## Architecture

### Component diagram

```
                  ┌─────────────────────────────┐
                  │       App.tsx               │
                  │                             │
                  │  workspace, file            │
                  │  monacoRef ──► editor       │
                  │  useSave({...})             │
                  │  useSymbolNavigation({...}) │◄── new
                  │                             │
                  │  MonacoEditor               │
                  │   onSymbolClick(s) ────► nav.onSymbolClick
                  │   onJump(n)        ────► nav.onJump  (Drawer row)
                  │   revealLine(line) ◄─── nav (after setFile)
                  │                             │
                  │  Drawer                     │
                  │   symbol    = nav.drawerSymbol
                  │   onJump(n) = nav.onJump
                  │   onClose   = nav.closeDrawer
                  └─────────────┬───────────────┘
                                │ cmd_read_file(path) [+ safe_read_path]
                                ▼
                          Rust: cmd_read_file
                                │
                                ▼
                          safe_read_path(rel)
```

### New components

#### `useSymbolNavigation` (new hook)

`apps/desktop/src/hooks/useSymbolNavigation.ts`. Owns:

- `drawerSymbol: string | null` — the symbol whose call hierarchy
  the Drawer currently shows. `null` ⇒ Drawer closed.
- `onSymbolClick(symbol)` — set `drawerSymbol` only. Does **not**
  swap files; that was the previous (broken) behaviour and the user
  opted for "click = Drawer, jump is a separate action" in the
  brainstorm.
- `onJump(node)` — guarded by `requestFileSwitch` (unsaved ⇒
  confirm), then `cmd_read_file(node.file)` → `setFile({...,
  isReadOnly: computed})` → `monacoRef.current?.revealLine(node.line)`.
  If `node.file` is already the active file, skip the `cmd_read_file`
  and `setFile` and call `revealLine` directly.
- `closeDrawer()` — `setDrawerSymbol(null)`.

Inputs: `{ file, setFile, monacoRef, requestFileSwitch, setEditorBanner, workspace }`.

#### `safe_read_path` (Rust)

`crates/latte-editor/src/path.rs`. Replaces `safe_path` for read-only
calls. Rules:

- Rejects absolute paths.
- Rejects any `..` component.
- `fs::canonicalize` (resolves symlinks; that's fine for read).
- Rejects directories (we only read files).
- Does **not** check workspace containment.

`cmd_read_file` switches to this. All write paths
(`cmd_write_file` / `cmd_create_file` / `cmd_create_dir` /
`cmd_delete_entry`) keep `safe_path` as-is.

#### `revealLine` (MonacoEditor handle)

`packages/editor/src/MonacoEditor.tsx`. New method on
`MonacoEditorHandle`:

```ts
revealLine(line: number): void
```

Implementation: `editor.revealLineInCenterIfOutsideViewport(line)`.
The "IfOutsideViewport" variant avoids yanking the user away from
where they were reading when the line is already visible (e.g. when
`onJump` targets the currently-open file).

To handle the race between `setFile` (which triggers a React render
and a re-set of `editor.setValue`) and the imperative `revealLine`,
`MonacoEditor` keeps a `pendingRevealRef: useRef<number | null>`:

```ts
revealLine(line) { pendingRevealRef.current = line; }
useEffect(() => {
  const line = pendingRevealRef.current;
  if (line === null) return;
  pendingRevealRef.current = null;
  editorRef.current?.revealLineInCenterIfOutsideViewport(line);
}, [value, pendingRevealRef.current]);
```

The dep on `value` (not just `pendingRevealRef.current`) ensures the
scroll fires *after* the new content is loaded; clearing the ref in
the same effect prevents a re-fire on the next keystroke.

#### TCL grammar

`packages/editor/src/tcl.ts`. One file. Exposes `registerTcl(monaco)`
which is idempotent. Registers:

- `monaco.languages.register({ id: 'tcl', extensions: ['.tcl', '.tk'], aliases: ['Tcl', 'tcl', 'TCL'] })`
- `monaco.languages.setMonarchTokensProvider('tcl', MONARCH_RULES)`
  covering: `set` / `unset` / `proc` / `if` / `elseif` / `else` /
  `for` / `foreach` / `while` / `switch` / `return` / `break` /
  `continue` / `global` / `upvar` / `puts` / `expr` / `list` / `string`
  / `regexp` / `regsub` / `subst` / `catch` / `namespace` / `variable`
  / `apply` / `try` / `finally` / `throw` / `yield` / `tailcall` as
  keyword; `# ... \n` as line comment; `"..."` / `{...}` as strings
  (with backslash escapes); `[...]` as bracket pair (deeper colour
  via nested tokenizer).
- `monaco.languages.setLanguageConfiguration('tcl', { comments: { lineComment: '#' }, brackets: [['{','}'],['[',']'],['(',')'],['"','"']] })`
  for the comment-line shortcut and bracket pair matching.

`MonacoEditor.tsx` calls `registerTcl(monaco)` once in a mount
effect. Guarded by a module-level `let registered = false` so
subsequent mounts are no-ops.

`apps/desktop/src/components/languageFromPath.ts` adds the `.tcl` /
`.tk` extensions mapping to `'tcl'`.

### Components modified

- `apps/desktop/src/App.tsx` — instantiate `useSymbolNavigation`,
  mount `<Drawer>`, change `onSymbolClick` to call `nav.onSymbolClick`
  (no more `goto.onSymbolClick` from the editor — that's the
  old go-to-def path that always swapped files with a placeholder
  body, see `// TODO: load from disk` on the current line 147).
  `useGoToDef` itself stays in the codebase (still useful as a
  standalone hook for `CommandPalette`'s `@symbol` search results
  that want to jump without opening the Drawer).
- `packages/editor/src/MonacoEditor.tsx` — add `revealLine` to the
  handle, add the `pendingRevealRef` effect, register TCL on mount.
- `packages/editor/src/MonacoEditor.test.tsx` — new test for
  `revealLine` and an idempotency test for `registerTcl`.
- `crates/latte-editor/src/cmd/fs.rs` — `cmd_read_file` switches to
  `safe_read_path`.
- `crates/latte-editor/src/lib.rs` — unchanged.
- `crates/latte-editor/src/path.rs` — add `safe_read_path` + 3
  single-assertion unit tests.
- `apps/desktop/src/components/languageFromPath.ts` — add `.tcl` /
  `.tk`.
- `apps/desktop/src/hooks/useSave.ts` — add an `isReadOnly` early
  return in `handleSave` that surfaces a banner. `isReadOnly` is
  computed in App.tsx and passed in.
- `apps/desktop/src/App.test.tsx` — update fixtures (existing
  `cmd_read_file` mock now goes through `safe_read_path` — same
  wire shape, no change needed unless a test reads an
  out-of-workspace path).
- `apps/desktop/src/hooks/useSave.test.tsx` — add one test: when
  `isReadOnly` is true, `handleSave` returns immediately and shows
  the banner, without calling `cmd_write_file`.
- New: `apps/desktop/src/hooks/useSymbolNavigation.test.tsx` —
  5 cases (see Test plan below).
- New: `packages/editor/src/tcl.test.ts` — at least one test that
  `registerTcl` is idempotent and registers the expected language id.

### Read-only outside-workspace

- `App.tsx` computes `isReadOnly = workspace !== null && !file.path.startsWith(workspace + "/")`
  (file outside the workspace tree, but still allowed by
  `safe_read_path`).
- Passes `readOnly={isReadOnly}` to `<MonacoEditor>`.
- `<MonacoEditor>` forwards to `editor.updateOptions({ readOnly })`.
- `useSave.handleSave` early-returns with `showEditorBanner("read-only — cannot save: <path>")`
  when `isReadOnly`. `cmd_write_file` is never called.
- The status bar shows `· read-only` (new state) when the file is
  outside the workspace, alongside the existing `· ●` / `· saving…`
  markers. Mutually exclusive with `· ●` because read-only files
  can't be dirty (they'd fail to save). Implementation: status bar
  reads `useSave.isReadOnly` exposed via the hook's return type.

### Data flow — happy path

```
user clicks "foo" in Monaco
   │
   ▼
MonacoEditor onSymbolClick("foo")
   │
   ▼
useSymbolNavigation.onSymbolClick("foo")
   │ setDrawerSymbol("foo")
   │
   ▼
Drawer useEffect([symbol]) → invoke<CallNode[]>("cmd_call_hierarchy", { symbol: "foo" })
   │
   ▼
Drawer's onJump(node) when user clicks a row
   │
   ▼
useSymbolNavigation.onJump(node)
   │ requestFileSwitch(...)
   │   └─ if dirty: confirm dialog; abort on cancel
   │
   ▼
cmd_read_file(node.file)
   │
   ▼
safe_read_path(node.file)
   │ (works whether or not node.file is inside the workspace)
   │
   ▼
setFile({ path, name, content, language, savedContent: content, isReadOnly })
   │
   ▼
MonacoEditor re-renders with new value
   │ [value, pendingRevealRef.current] effect fires
   │ monacoRef.current.revealLine(node.line)
   ▼
User sees the file at the right line, Drawer still showing foo's hierarchy
```

### Error handling

| Failure | Surface |
|---|---|
| `cmd_read_file` rejects (binary, missing, perms) | `setEditorBanner("open failed: <path> — <err>")` from `useSymbolNavigation`. No file swap. |
| `safe_read_path` rejects (`..`, absolute, dir) | `cmd_read_file` returns the same `Err` shape as before. Banner. |
| `cmd_call_hierarchy` rejects (no graph) | `Drawer` catches and `console.error`s; UI shows "no hierarchy available". We do *not* elevate to a banner — Drawer is exploratory, the user is browsing. |
| No `callee` row in hierarchy (symbol undeclared in graph) | `Drawer` simply omits the row. The caller rows still work. |
| `revealLine` called on a stale ref (file not yet loaded) | The `pendingRevealRef` effect waits for the next `[value, ...]` tick; the scroll fires as soon as the new value lands. If the editor is *remounting* (e.g. language change forces a new model), the `revealLine` is best-effort — we accept that an out-of-viewport scroll on a fresh mount may briefly miss. We can address in a follow-up by keying the editor on language. |
| Save attempted on read-only file | `useSave` early-returns with `showEditorBanner("read-only — cannot save: <path>")`. `saveStatus` is set to `"idle"` (not `"saved"`), so the status bar doesn't lie. |

---

## Test plan

### Rust (3 new)

- `path::tests::read_path_accepts_relative_path`
  - relative path → `Ok(abs)`, `abs` is a file
- `path::tests::read_path_rejects_absolute`
  - `/etc/passwd` → `Err` matching `"absolute"` (or whatever
    existing error string we use)
- `path::tests::read_path_rejects_dotdot`
  - `../escape.txt` → `Err` mentioning `..` or `parent`
- `path::tests::read_path_rejects_directory`
  - `subdir/` → `Err` (we only read files)

`cmd_read_file` does not get a new test — its behaviour change is
"uses safe_read_path", which is exercised transitively by
`useSymbolNavigation.test.tsx`.

### Vitest — `useSymbolNavigation` (5 new)

- `onSymbolClick sets drawerSymbol; does not setFile`
  - render host → call `onSymbolClick("foo")` → assert
    `drawerSymbol === "foo"` and `setFile` not called
- `onJump calls cmd_read_file then setFile then revealLine, in order`
  - mock `cmd_read_file` to return `"content"`, spy on setFile and
    `monacoRef.current.revealLine`
  - call `onJump({ file: "a.ts", line: 42, name: "foo", role: "callee" })`
  - assert `cmd_read_file` was called with `"a.ts"`, then `setFile`
    with `{ path: "a.ts", content: "content", ... }`, then
    `revealLine(42)`
- `onJump is guarded by requestFileSwitch when dirty`
  - set up `useSave` so `dirty === true`
  - spy on `requestFileSwitch`; assert `cmd_read_file` is *not*
    called until the confirm returns "accept"
- `onJump on currently-open file: skip setFile, call revealLine`
  - `file.path === node.file` already; `cmd_read_file` not called;
    `revealLine(line)` called
- `onJump on read failure: setEditorBanner, no setFile`
  - mock `cmd_read_file` to reject
  - call `onJump(...)` → assert `setEditorBanner` called with
    `"open failed: ..."` and `setFile` not called

### Vitest — `useSave` (1 new)

- `handleSave on readOnly: early return with banner, no cmd_write_file`
  - render host with `isReadOnly: true`, dirty: true
  - call `handleSave()` → assert `cmd_write_file` not called, banner
    contains `"read-only"`, `saveStatus === "idle"`

### Vitest — `MonacoEditor` (2 new + existing)

- `revealLine: pendingRevealRef + [value] effect scrolls then clears`
  - mock monaco editor with `revealLineInCenterIfOutsideViewport` spy
  - call `monacoRef.revealLine(42)`, then re-render with new `value`
  - assert spy called with `42`
  - re-render again with same value (typing) → spy not called a 2nd time
- `registerTcl: idempotent across multiple MonacoEditor mounts`
  - mount two `<MonacoEditor>` instances; assert
    `monaco.languages.register` was called exactly once with
    `{ id: 'tcl', ... }`

### Vitest — `tcl.ts` (1 new, standalone)

- `registerTcl registers language and tokens; calling twice is a no-op`
  - uses `vi.mock("monaco-editor", ...)`; verify both `register` and
    `setMonarchTokensProvider` are called once across two
    `registerTcl(monaco)` calls

### Manual GUI smoke (V.2 of this spec)

1. Open a workspace, navigate to a `.ts` file containing a
   function `greet` that's called from another file. Click
   `greet`. Drawer opens. The header reads "▼ Call Hierarchy ·
   greet". One row: "↓ callee greet (greet.ts:3)". Several rows
   above it: "↑ caller greet (main.ts:5)" etc. Click the callee
   row. The editor opens `greet.ts` at line 3, scroll centred.
   Drawer still shows greet's hierarchy. `requestFileSwitch`
   behaved correctly: if the prior buffer was dirty, a Discard /
   Cancel prompt appeared.
2. Same setup, but the function has no definition in the graph
   (e.g. a built-in like `console.log`). The Drawer shows only
   caller rows (no callee row). No error.
3. Create `samples/test.tcl` with the standard
   `proc greet {name} { puts "hello, $name" }` content. Open it
   from the tree. The file renders with `proc` / `puts` /
   `greet` coloured as keywords, `"hello, $name"` as a string,
   `#` comment if present. No JS errors in the devtools console.
4. Open a workspace, then from a TS file click a symbol whose
   definition lives outside the workspace (e.g. a function
   declared in `/usr/local/lib/.../typescript.d.ts` if the
   workspace has `@types/...` next to it). The Drawer opens. Click
   the callee row. `cmd_read_file` is allowed by `safe_read_path`
   even though the target is outside the workspace. The file
   opens, the title bar shows the absolute path, the status bar
   shows `· read-only`. Cmd+S is no-op and shows a banner. Cmd+Z
   still works (Monaco's undo).
5. Existing V.2 from the save-mechanism plan must still pass
   (Cmd+S, dirty state, unsaved confirm on file-switch,
   workspace-changed confirm, hidden-directory rejection).
   This is a regression-coverage smoke, not a new test.

---

## File map

### Create
- `apps/desktop/src/hooks/useSymbolNavigation.ts`
- `apps/desktop/src/hooks/useSymbolNavigation.test.tsx`
- `packages/editor/src/tcl.ts`
- `packages/editor/src/tcl.test.ts`

### Modify
- `apps/desktop/src/App.tsx` — wire `useSymbolNavigation`, mount
  `<Drawer>`, change `onSymbolClick`, compute `isReadOnly`, pass
  `readOnly` to MonacoEditor, surface `· read-only` in status bar
- `apps/desktop/src/hooks/useSave.ts` — `isReadOnly` early-return
  in `handleSave`
- `apps/desktop/src/hooks/useSave.test.tsx` — add 1 case
- `apps/desktop/src/components/languageFromPath.ts` — `.tcl` /
  `.tk`
- `packages/editor/src/MonacoEditor.tsx` — `revealLine` on handle,
  `pendingRevealRef` effect, `readOnly` prop forwarded, register
  TCL on mount
- `packages/editor/src/MonacoEditor.test.tsx` — 2 new cases
- `crates/latte-editor/src/path.rs` — `safe_read_path` + 4 tests
- `crates/latte-editor/src/cmd/fs.rs` — `cmd_read_file` uses
  `safe_read_path`

### Untouched
- `crates/latte-editor/src/cmd/callh.rs` — already returns callers
  + callee with role tags; `Drawer.tsx` already renders them. No
  change.
- `packages/editor/src/Drawer.tsx` — already correct; just gets
  mounted.
- `packages/editor/src/useGoToDef.ts` — kept for `CommandPalette`
  symbol-search use; not used in the click flow anymore.
- `crates/latte-editor/src/cmd/graph.rs` — `cmd_definition` is
  still used (by `useGoToDef` from the palette) but is *not* the
  primary path for click-driven go-to. We can leave it.

---

## Decisions and trade-offs

- **Click = Drawer, not jump.** A click reveals a panel; jumping
  is a second action. The user picked this in the brainstorm
  because it separates "I want to browse" from "I want to
  navigate". The Drawer's callee row is one click away from the
  implementation, which is fast enough.
- **Drawer is a renderer-only addition.** No new Rust commands.
  `cmd_call_hierarchy` already returns exactly the data the
  Drawer renders. We re-use the component as-is; the new code is
  just where it's mounted and how it's fed.
- **Read-only outside the workspace.** The user opted to relax
  the read path. We keep the write path locked. The status bar
  shows `· read-only` so the user understands why Cmd+S is
  inert.
- **`safe_read_path` does *not* open a sandbox.** We allow any
  file the process can read. This is appropriate for a local
  developer tool; a multi-tenant deployment would need
  additional layers. (We will revisit if/when the project
  changes scope.)
- **`revealLineInCenterIfOutsideViewport`.** Soft scroll — if the
  target line is already visible, do nothing. The strict
  `revealLineInCenter` would yank the user away from context.
- **Monaco's built-in tcl support is uneven.** Monaco ships a
  Monarch grammar for tcl out of the box (the `tcl` language id
  is in their `languageRegistry`), but it is not always loaded
  by default depending on the language set bundled. Calling
  `monaco.languages.register({ id: 'tcl' })` ourselves is the
  safest path; we ship our own monarch rules to be sure the
  experience matches.
- **`useSymbolNavigation` is a hook, not a context.** App.tsx is
  the only consumer in this round. A context would be over-engineered.
  The next spec (multi-file tabs) might revisit.

---

## Open questions for writing-plans

These are not blockers for the design; they are decisions the
implementation plan will make explicit.

- **TCL monarch rules: full or minimal?** Plan will start with the
  minimum needed to make `samples/test.tcl` look reasonable and
  extend only if a real `.tcl` file surfaces a need.
- **`requestFileSwitch` lives in `useSave`.** Coupling navigation
  to save is awkward. The plan can extract `requestFileSwitch`
  into a shared util (`apps/desktop/src/hooks/useUnsavedGuard.ts`?)
  so both `useSave` and `useSymbolNavigation` consume the same
  prompt logic. Or it can keep the call. *Lean toward extract*
  because `useSave` is already 200+ lines and the guard is
  general-purpose.
- **`Drawer` styling.** The current `Drawer.tsx` is `h-48` and
  sits below the editor. We keep that. Plan will decide
  whether to animate the open/close (probably not — Tailwind
  `transition-all` on `max-h-0 ↔ h-48` is one line and feels
  nicer than snap).
- **`onJump` is currently typed as `CallNode` but the Drawer's
  `onJump` is loosely typed.** Tighten in this round.
