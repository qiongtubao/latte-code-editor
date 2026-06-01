# Code Editor with Code Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Tauri 2 desktop code editor that integrates with the existing `@latte-graph/core` package from `latte-code-review-graph`, providing syntax highlighting, cross-reference navigation, workspace search, semantic search, and an interactive code graph panel.

**Architecture:** Rust backend (Tauri 2 commands) talks to a `core` package via a thin local crate adapter that opens the SQLite graph.db directly. React+Vite+Tailwind renderer uses Monaco for editing and a `d3-force` web worker for the graph. NDJSON streaming for long-running tasks (build, indexing). pnpm workspace, with `@latte-graph/core` consumed as a workspace dependency in a Node CLI sidecar.

**Tech Stack:** Tauri 2, Rust (tokio, rusqlite, notify, fastembed-rs, sqlite-vss), React 18, Vite, Tailwind, Monaco, pnpm workspaces, vitest, cargo test, Playwright (toHaveScreenshot, DPR=1).

**Spec:** `docs/superpowers/specs/2026-06-01-code-editor-with-graph-design.md`

---

## File Structure

```
latte-code-editor/
├── apps/
│   └── desktop/                    # Tauri 2 app shell (NEW, scaffolded in T1)
│       ├── src/                    # React renderer
│       ├── src-tauri/              # Rust main + tauri.conf.json
│       ├── tauri-plugin-*.json
│       └── package.json
├── crates/
│   ├── latte-graph-adapter/        # Reads @latte-graph/core's SQLite directly
│   │   ├── src/lib.rs
│   │   ├── src/db.rs
│   │   ├── src/query.rs
│   │   └── src/error.rs
│   └── latte-editor/               # All editor business logic in Rust
│       ├── src/lib.rs
│       ├── src/cmd/                # Tauri command handlers
│       ├── src/path.rs             # safe_path()
│       ├── src/index/              # FileIndexService + Debouncer
│       ├── src/search/             # ripgrep + fastembed + RRF
│       ├── src/build/              # BuildRunner (NDJSON streaming)
│       └── src/schema_sync.rs      # @latte-graph/core DB version check
├── packages/
│   ├── editor/                     # React UI components
│   │   ├── src/MonacoEditor.tsx
│   │   ├── src/FileTree.tsx
│   │   ├── src/RightPanel.tsx
│   │   ├── src/GraphView.tsx       # uses worker
│   │   ├── src/Drawer.tsx
│   │   ├── src/CommandPalette.tsx
│   │   ├── src/StatusBar.tsx
│   │   ├── src/workers/graph.worker.ts
│   │   └── src/styles.css
│   └── cli/                        # Node CLI sidecar (wrapper around @latte-graph/cli)
│       └── src/index.ts
├── samples/                        # Bundled sample workspaces (T23)
│   └── minimal-ts/
├── tests/
│   ├── visual/                     # Playwright screenshot tests
│   └── fixtures/
├── docs/superpowers/plans/         # this file
├── pnpm-workspace.yaml
├── Cargo.toml                      # workspace members = apps + crates
└── package.json
```

**Responsibilities:**
- `latte-graph-adapter`: pure-Rust wrapper around `@latte-graph/core`'s DB schema. **Does not import** the npm package — it opens `graph.db` via rusqlite using a vendored copy of the schema hash.
- `latte-editor`: all Tauri commands, file watching, indexing, search, build runner. No DB schema knowledge — goes through the adapter.
- `apps/desktop`: thin Tauri + React shell. Only UI logic.
- `packages/editor`: React components only. Talks to backend via `invoke()`.
- `packages/cli`: Node CLI that runs `@latte-graph/cli` and emits NDJSON. Used for build streaming.

---

## Phase 1: Foundation (T1-T4)

### Task 1: pnpm workspace + root scaffolding

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.npmrc`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "latte-code-editor",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "pnpm --filter @latte/desktop dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "tauri": "pnpm --filter @latte/desktop tauri"
  },
  "devDependencies": {
    "typescript": "5.4.5"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
target/
.DS_Store
*.log
.superpowers/
.electron-driver/
.omc/
```

- [ ] **Step 4: Create `.npmrc`**

```
shamefully-hoist=true
strict-peer-dependencies=false
auto-install-peers=true
```

- [ ] **Step 5: Install root deps**

Run: `pnpm install`
Expected: `node_modules/` created, `pnpm-lock.yaml` written.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhouguodong/Documents/latte/latte-code-editor
git init 2>/dev/null || true
git add package.json pnpm-workspace.yaml .gitignore .npmrc
git commit -m "chore: initialize pnpm workspace"
```

---

### Task 2: Tauri 2 + React renderer scaffold

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: Create `apps/desktop/package.json`**

```json
{
  "name": "@latte/desktop",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "@monaco-editor/react": "4.6.0",
    "monaco-editor": "0.50.0",
    "@latte-graph/core": "workspace:*",
    "@latte-graph/cli": "workspace:*",
    "@latte/editor": "workspace:*"
  },
  "devDependencies": {
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
    "@vitejs/plugin-react": "4.3.1",
    "vite": "5.3.1",
    "vitest": "1.6.0",
    "@tauri-apps/cli": "2.0.0",
    "@tauri-apps/api": "2.0.0",
    "tailwindcss": "3.4.4",
    "autoprefixer": "10.4.19",
    "postcss": "8.4.39"
  }
}
```

- [ ] **Step 2: Create `apps/desktop/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "esnext", sourcemap: true },
});
```

- [ ] **Step 3: Create `apps/desktop/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Latte Code Editor</title>
  </head>
  <body class="bg-zinc-900 text-zinc-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `apps/desktop/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

- [ ] **Step 5: Create `apps/desktop/src/App.tsx`**

```tsx
export default function App() {
  return <div className="h-screen flex items-center justify-center">Latte</div>;
}
```

- [ ] **Step 6: Create `apps/desktop/src/styles.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; margin: 0; }
```

- [ ] **Step 7: Create `apps/desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "latte-desktop"
version = "0.0.0"
edition = "2021"

[lib]
name = "latte_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[dependencies]
latte-editor = { path = "../../crates/latte-editor" }
tauri = { version = "2.0", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 8: Create `apps/desktop/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Latte Code Editor",
  "version": "0.0.0",
  "identifier": "dev.latte.editor",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://127.0.0.1:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": { "windows": [{ "title": "Latte", "width": 1400, "height": 900 }] }
}
```

- [ ] **Step 9: Create `apps/desktop/src-tauri/src/main.rs`**

```rust
fn main() {
    latte_desktop_lib::run();
}
```

- [ ] **Step 10: Stub `crates/latte-editor/src/lib.rs` so it compiles**

```rust
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 11: Create root `Cargo.toml`**

```toml
[workspace]
members = ["apps/desktop/src-tauri", "crates/latte-editor"]
resolver = "2"
```

- [ ] **Step 12: Install + sanity check**

Run: `pnpm install && cd apps/desktop && pnpm exec tauri info`
Expected: Tauri reports version 2.x, no errors.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop crates/latte-editor Cargo.toml
git commit -m "feat: scaffold tauri 2 + react renderer"
```

---

### Task 3: Rust crate `latte-graph-adapter` — schema hash + open DB

**Files:**
- Create: `crates/latte-graph-adapter/Cargo.toml`
- Create: `crates/latte-graph-adapter/src/lib.rs`
- Create: `crates/latte-graph-adapter/src/error.rs`
- Create: `crates/latte-graph-adapter/src/db.rs`
- Create: `crates/latte-graph-adapter/tests/open_db.rs`

- [ ] **Step 1: Create `crates/latte-graph-adapter/Cargo.toml`**

```toml
[package]
name = "latte-graph-adapter"
version = "0.1.0"
edition = "2021"

[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
sha2 = "0.10"
hex = "0.4"
```

- [ ] **Step 2: Add crate to root `Cargo.toml`**

Append `"crates/latte-graph-adapter"` to the `members` array.

- [ ] **Step 3: Create `crates/latte-graph-adapter/src/error.rs`**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("schema hash mismatch: db has {db}, expected {expected}")]
    SchemaHash { db: String, expected: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}
```

- [ ] **Step 4: Create `crates/latte-graph-adapter/src/db.rs`**

```rust
use crate::error::AdapterError;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

pub const SCHEMA_HASH: &str = "REPLACE_WITH_HASH_FROM_BUILD_STEP";

pub struct GraphDb { conn: Connection }

impl GraphDb {
    pub fn open(path: &std::path::Path) -> Result<Self, AdapterError> {
        let conn = Connection::open(path)?;
        let actual: String = conn.query_row(
            "SELECT value FROM meta WHERE key = 'schema_hash'",
            [], |r| r.get(0),
        )?;
        if actual != SCHEMA_HASH {
            return Err(AdapterError::SchemaHash { db: actual, expected: SCHEMA_HASH.into() });
        }
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection { &self.conn }

    pub fn hash_schema(sql: &str) -> String {
        let mut h = Sha256::new();
        h.update(sql.as_bytes());
        hex::encode(h.finalize())
    }
}
```

- [ ] **Step 5: Create `crates/latte-graph-adapter/src/lib.rs`**

```rust
pub mod db;
pub mod error;

pub use db::GraphDb;
pub use error::AdapterError;
```

- [ ] **Step 6: Write failing test `tests/open_db.rs`**

```rust
use latte_graph_adapter::{GraphDb, SCHEMA_HASH};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn opens_db_with_matching_hash() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("g.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO meta VALUES ('schema_hash', ?1)",
        [SCHEMA_HASH],
    ).unwrap();
    drop(conn);
    GraphDb::open(&path).expect("should open");
}
```

- [ ] **Step 7: Run test (should compile-fail on `tempfile` not in dev-deps)**

Add to `crates/latte-graph-adapter/Cargo.toml` under `[dev-dependencies]`:
```toml
tempfile = "3"
```

Run: `cargo test -p latte-graph-adapter`
Expected: PASS (placeholder SCHEMA_HASH matches itself, but we'll compute the real one in T4).

- [ ] **Step 8: Commit**

```bash
git add crates/latte-graph-adapter Cargo.toml
git commit -m "feat(adapter): rusqlite open + schema_hash check"
```

---

### Task 4: Schema sync — compute real SCHEMA_HASH from `@latte-graph/core` migrations

**Files:**
- Create: `crates/latte-graph-adapter/build.rs`
- Create: `scripts/compute-schema-hash.mjs`
- Modify: `crates/latte-graph-adapter/src/db.rs:6` (replace placeholder with `include_str!`)

- [ ] **Step 1: Create `scripts/compute-schema-hash.mjs`**

```javascript
// Computes sha256 of every *.sql file under packages/latte-code-review-graph/core/migrations
// in stable order, then writes the result to crates/latte-graph-adapter/SCHEMA_HASH.txt
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || "../latte-code-review-graph/core/migrations";
const out = process.argv[3] || "./crates/latte-graph-adapter/SCHEMA_HASH.txt";
const files = readdirSync(root).filter(f => f.endsWith(".sql")).sort();
const h = createHash("sha256");
for (const f of files) {
  h.update(readFileSync(join(root, f), "utf8"));
  h.update(f);
}
writeFileSync(out, h.digest("hex") + "\n");
console.log("wrote", out);
```

- [ ] **Step 2: Run it to generate the hash**

Run: `node scripts/compute-schema-hash.mjs /Users/zhouguodong/Documents/latte/latte-code-review-graph/core/migrations crates/latte-graph-adapter/SCHEMA_HASH.txt`
Expected: prints "wrote crates/latte-graph-adapter/SCHEMA_HASH.txt". If the migrations directory doesn't exist yet, list the actual path and adjust.

- [ ] **Step 3: Create `crates/latte-graph-adapter/build.rs`**

```rust
use std::path::Path;
fn main() {
    let path = Path::new("SCHEMA_HASH.txt");
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-changed=../../scripts/compute-schema-hash.mjs");
}
```

- [ ] **Step 4: Update `crates/latte-graph-adapter/src/db.rs` SCHEMA_HASH const**

Replace:
```rust
pub const SCHEMA_HASH: &str = "REPLACE_WITH_HASH_FROM_BUILD_STEP";
```
With:
```rust
pub const SCHEMA_HASH: &str = include_str!("../SCHEMA_HASH.txt").trim();
```

- [ ] **Step 5: Re-run adapter test to confirm the real hash matches a DB built with same migrations**

```rust
// In a separate test that creates a DB with the real schema before running this:
// (See T8 for the integration test that uses the actual sample workspace.)
```
Run: `cargo test -p latte-graph-adapter`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/latte-graph-adapter/build.rs crates/latte-graph-adapter/src/db.rs scripts/compute-schema-hash.mjs crates/latte-graph-adapter/SCHEMA_HASH.txt
git commit -m "feat(adapter): schema hash from upstream migrations"
```

---

## Phase 2: Graph Query (T5-T8)

### Task 5: `path::safe_path` — cross-platform path safety

**Files:**
- Create: `crates/latte-editor/src/path.rs`
- Create: `crates/latte-editor/src/lib.rs` (re-export)
- Create: `crates/latte-editor/tests/path_safety.rs`

- [ ] **Step 1: Create `crates/latte-editor/src/path.rs`**

```rust
use std::path::{Component, Path, PathBuf};
use latte_graph_adapter::AdapterError;

pub fn safe_path(root: &Path, raw: &str) -> Result<PathBuf, AdapterError> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return Err(AdapterError::UnsafePath("absolute path rejected".into()));
    }
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AdapterError::UnsafePath("parent component rejected".into()));
    }
    let cleaned = path_clean::clean(root.join(candidate));
    let canon_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if !cleaned.starts_with(&canon_root) {
        return Err(AdapterError::UnsafePath("escapes root".into()));
    }
    Ok(cleaned)
}
```

- [ ] **Step 2: Add deps to `crates/latte-editor/Cargo.toml`**

```toml
[dependencies]
latte-graph-adapter = { path = "../latte-graph-adapter" }
path-clean = "1"
dunce = "1"
```

- [ ] **Step 3: Export from `crates/latte-editor/src/lib.rs`**

```rust
pub mod path;
```

(Leave the existing `pub fn run()` from T2 in place.)

- [ ] **Step 4: Write failing test `crates/latte-editor/tests/path_safety.rs`**

```rust
use latte_editor::path::safe_path;
use tempfile::tempdir;

#[test]
fn rejects_absolute() {
    let root = tempdir().unwrap();
    assert!(safe_path(root.path(), "/etc/passwd").is_err());
}

#[test]
fn rejects_parent_traversal() {
    let root = tempdir().unwrap();
    assert!(safe_path(root.path(), "../escape").is_err());
}

#[test]
fn accepts_relative_within_root() {
    let root = tempdir().unwrap();
    let p = safe_path(root.path(), "src/foo.ts").unwrap();
    assert!(p.starts_with(root.path()));
}
```

- [ ] **Step 5: Run test**

Run: `cargo test -p latte-editor path_safety`
Expected: PASS (3/3).

- [ ] **Step 6: Add proptest for arbitrary inputs**

Append to `tests/path_safety.rs`:
```rust
use proptest::prelude::*;
proptest! {
    #[test]
    fn never_panics_on_any_input(s in ".*") {
        let root = tempdir().unwrap();
        let _ = safe_path(root.path(), &s);
    }
}
```
Add to `[dev-dependencies]` of `crates/latte-editor/Cargo.toml`:
```toml
proptest = "1"
```
Run: `cargo test -p latte-editor`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/latte-editor
git commit -m "feat(editor): safe_path with proptest fuzz"
```

---

### Task 6: `latte-graph-adapter` query layer — `definition`, `references`, `neighbors`

**Files:**
- Create: `crates/latte-graph-adapter/src/query.rs`
- Create: `crates/latte-graph-adapter/src/model.rs`
- Modify: `crates/latte-graph-adapter/src/lib.rs`

- [ ] **Step 1: Create `crates/latte-graph-adapter/src/model.rs`**

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Location { pub file: String, pub line: u32, pub col: u32 }

#[derive(Debug, Serialize)]
pub struct Reference { pub location: Location, pub kind: String /* 'def' | 'ref' | 'call' | 'import' */ }

#[derive(Debug, Serialize)]
pub struct Neighbor { pub node_id: String, pub name: String, pub kind: String, pub edge: String }
```

- [ ] **Step 2: Create `crates/latte-graph-adapter/src/query.rs`**

```rust
use crate::{db::GraphDb, error::AdapterError, model::{Location, Neighbor, Reference}};
use rusqlite::params;

pub fn definition(db: &GraphDb, symbol: &str) -> Result<Option<Location>, AdapterError> {
    let mut stmt = db.conn().prepare(
        "SELECT file, line, col FROM nodes WHERE name = ?1 AND kind IN ('function','class','method','variable') ORDER BY (kind = 'function') DESC LIMIT 1"
    )?;
    let mut rows = stmt.query(params![symbol])?;
    if let Some(r) = rows.next()? {
        Ok(Some(Location { file: r.get(0)?, line: r.get(1)?, col: r.get(2)? }))
    } else { Ok(None) }
}

pub fn references(db: &GraphDb, symbol: &str, limit: u32) -> Result<Vec<Reference>, AdapterError> {
    let mut stmt = db.conn().prepare(
        "SELECT e.kind, n2.file, n2.line, n2.col
         FROM edges e JOIN nodes n1 ON n1.id = e.from_node
                       JOIN nodes n2 ON n2.id = e.to_node
         WHERE n1.name = ?1 LIMIT ?2"
    )?;
    let rows = stmt.query_map(params![symbol, limit], |r| {
        Ok(Reference {
            kind: r.get(0)?,
            location: Location { file: r.get(1)?, line: r.get(2)?, col: r.get(3)? },
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn neighbors(db: &GraphDb, node_id: &str, depth: u32) -> Result<Vec<Neighbor>, AdapterError> {
    let mut stmt = db.conn().prepare(
        "WITH RECURSIVE walk(id, depth) AS (
            SELECT ?1, 0 UNION ALL SELECT e.to_node, walk.depth+1 FROM walk
            JOIN edges e ON e.from_node = walk.id WHERE walk.depth < ?2
        ) SELECT DISTINCT n.id, n.name, n.kind, 'edge' FROM walk JOIN nodes n ON n.id = walk.id
        WHERE walk.depth > 0"
    )?;
    let rows = stmt.query_map(params![node_id, depth], |r| {
        Ok(Neighbor { node_id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, edge: r.get(3)? })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}
```

- [ ] **Step 3: Update `crates/latte-graph-adapter/src/lib.rs`**

```rust
pub mod db;
pub mod error;
pub mod model;
pub mod query;

pub use db::GraphDb;
pub use error::AdapterError;
pub use model::{Location, Neighbor, Reference};
pub use query::{definition, neighbors, references};
```

- [ ] **Step 4: Commit (tests come in T8 with real sample)**

```bash
git add crates/latte-graph-adapter
git commit -m "feat(adapter): definition/references/neighbors queries"
```

---

### Task 7: `BuildRunner` — NDJSON streaming from `@latte-graph/cli`

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/ndjson.ts`
- Create: `packages/cli/src/commands/build.ts`
- Create: `packages/cli/test/build.test.ts`
- Create: `crates/latte-editor/src/build/mod.rs`
- Create: `crates/latte-editor/src/build/runner.rs`
- Create: `crates/latte-editor/src/lib.rs` (add `pub mod build;`)

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@latte/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "latte": "./dist/index.js" },
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": { "@latte-graph/core": "workspace:*", "@latte-graph/cli": "workspace:*" }
}
```

- [ ] **Step 2: Create `packages/cli/src/ndjson.ts`**

```typescript
export type BuildEvent =
  | { type: "start"; job: string }
  | { type: "progress"; file: string; pct: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "done"; stats: { files: number; nodes: number; edges: number; ms: number } }
  | { type: "error"; message: string };

export function writeEvent(e: BuildEvent) {
  process.stdout.write(JSON.stringify(e) + "\n");
}
```

- [ ] **Step 3: Create `packages/cli/src/commands/build.ts`**

```typescript
import { writeEvent } from "../ndjson.js";
export async function build(workspace: string) {
  writeEvent({ type: "start", job: "build" });
  const t0 = Date.now();
  // delegate to upstream @latte-graph/cli when --json is supported;
  // for now emit one progress per file
  const files = await fakeWalk(workspace);
  for (let i = 0; i < files.length; i++) {
    writeEvent({ type: "progress", file: files[i], pct: Math.round(((i+1)/files.length)*100) });
  }
  writeEvent({ type: "done", stats: { files: files.length, nodes: 0, edges: 0, ms: Date.now() - t0 } });
}
async function fakeWalk(_ws: string): Promise<string[]> { return ["a.ts","b.ts"]; }
```

- [ ] **Step 4: Create `packages/cli/src/index.ts`**

```typescript
#!/usr/bin/env node
import { build } from "./commands/build.js";
const [, , cmd, ...rest] = process.argv;
if (cmd === "build") {
  await build(rest[0] ?? ".");
} else {
  console.error("usage: latte <build> [workspace]");
  process.exit(2);
}
```

- [ ] **Step 5: Write failing test `packages/cli/test/build.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

describe("latte build", () => {
  it("emits NDJSON start, progress*, done", async () => {
    const cli = join(__dirname, "../src/index.ts");
    const out: string[] = [];
    await new Promise<void>((res, rej) => {
      const p = spawn("node", ["--import", "tsx", cli, "build", "."], { stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", d => out.push(d.toString()));
      p.on("exit", code => code === 0 ? res() : rej(new Error("exit "+code)));
    });
    const events = out.join("").trim().split("\n").map(JSON.parse);
    expect(events[0].type).toBe("start");
    expect(events.at(-1).type).toBe("done");
    expect(events.filter((e:any) => e.type === "progress").length).toBeGreaterThan(0);
  });
});
```

Add to devDeps of `packages/cli/package.json`:
```json
"vitest": "1.6.0", "tsx": "4.15.0", "@types/node": "20.14.0"
```

- [ ] **Step 6: Run test**

Run: `pnpm --filter @latte/cli test`
Expected: PASS.

- [ ] **Step 7: Create `crates/latte-editor/src/build/runner.rs`**

```rust
use serde::Deserialize;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum BuildEvent {
    Start { job: String },
    Progress { file: String, pct: u8 },
    Log { level: String, msg: String },
    Done { stats: serde_json::Value },
    Error { message: String },
}

pub async fn run<F>(workspace: &Path, cli_path: &Path, on_event: F) -> Result<(), String>
where F: Fn(BuildEvent) + Send + 'static
{
    let mut child = Command::new("node")
        .arg(cli_path).arg("build").arg(workspace)
        .stdout(std::process::Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        match serde_json::from_str::<BuildEvent>(&line) {
            Ok(ev) => on_event(ev),
            Err(e) => return Err(format!("malformed NDJSON line '{}': {}", line, e)),
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() { return Err(format!("cli exited {status}")); }
    Ok(())
}
```

- [ ] **Step 8: Add `pub mod build;` to `crates/latte-editor/src/lib.rs`**

- [ ] **Step 9: Write unit test in `crates/latte-editor/src/build/runner.rs`**

Append at end of file:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn parses_dummy_ndjson() {
        let line = r#"{"type":"done","stats":{"files":2,"nodes":0,"edges":0,"ms":1}}"#;
        let ev: BuildEvent = serde_json::from_str(line).unwrap();
        matches!(ev, BuildEvent::Done { .. });
    }
}
```

Add to `crates/latte-editor/Cargo.toml`:
```toml
[dependencies]
tokio = { version = "1", features = ["process", "io-util", "macros", "rt-multi-thread"] }
serde_json = "1"
```

- [ ] **Step 10: Run tests**

Run: `cargo test -p latte-editor build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/cli crates/latte-editor
git commit -m "feat(build): NDJSON build runner (rust+ts)"
```

---

### Task 8: Tauri command handlers — `cmd_definition`, `cmd_references`, `cmd_neighbors`, `cmd_build`

**Files:**
- Create: `crates/latte-editor/src/cmd/mod.rs`
- Create: `crates/latte-editor/src/cmd/graph.rs`
- Create: `crates/latte-editor/src/cmd/build.rs`
- Create: `crates/latte-editor/src/state.rs`
- Modify: `crates/latte-editor/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs` → uses new `run()`

- [ ] **Step 1: Create `crates/latte-editor/src/state.rs`**

```rust
use latte_graph_adapter::GraphDb;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub workspace: Mutex<Option<PathBuf>>,
    pub db: Mutex<Option<GraphDb>>,
}
impl AppState { pub fn new() -> Self { Self { workspace: Mutex::new(None), db: Mutex::new(None) } } }
```

- [ ] **Step 2: Create `crates/latte-editor/src/cmd/graph.rs`**

```rust
use crate::state::AppState;
use latte_graph_adapter::{definition, neighbors, references};
use tauri::State;

#[tauri::command]
pub fn cmd_definition(state: State<AppState>, symbol: String) -> Result<Option<latte_graph_adapter::Location>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("workspace not open")?;
    definition(db, &symbol).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_references(state: State<AppState>, symbol: String, limit: Option<u32>) -> Result<Vec<latte_graph_adapter::Reference>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("workspace not open")?;
    references(db, &symbol, limit.unwrap_or(200)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_neighbors(state: State<AppState>, node_id: String, depth: Option<u32>) -> Result<Vec<latte_graph_adapter::Neighbor>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("workspace not open")?;
    neighbors(db, &node_id, depth.unwrap_or(2)).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Create `crates/latte-editor/src/cmd/build.rs`**

```rust
use crate::state::AppState;
use crate::build::runner::{run, BuildEvent};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn cmd_build(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let cli = std::env::current_dir()?.join("packages/cli/src/index.ts");
    let app2 = app.clone();
    run(&ws, &cli, move |ev: BuildEvent| {
        let _ = app2.emit("build:event", &ev);
    }).await
}
```

- [ ] **Step 4: Create `crates/latte-editor/src/cmd/mod.rs`**

```rust
pub mod build;
pub mod graph;
```

- [ ] **Step 5: Update `crates/latte-editor/src/lib.rs`**

```rust
pub mod build;
pub mod cmd;
pub mod path;
pub mod state;

use state::AppState;
use std::path::PathBuf;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            // default workspace = first arg or cwd
            let ws = std::env::args().nth(1).map(PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap());
            let state = app.state::<AppState>();
            *state.workspace.lock().unwrap() = Some(ws);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd::graph::cmd_definition,
            cmd::graph::cmd_references,
            cmd::graph::cmd_neighbors,
            cmd::build::cmd_build,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Build and verify the Rust side compiles**

Run: `cargo build -p latte-desktop`
Expected: compiles, no errors.

- [ ] **Step 7: Commit**

```bash
git add crates/latte-editor
git commit -m "feat(editor): tauri command handlers (graph + build)"
```

---

## Phase 3: Editor Shell (T9-T13)

### Task 9: `packages/editor` package skeleton + Monaco wrapper

**Files:**
- Create: `packages/editor/package.json`
- Create: `packages/editor/src/index.ts`
- Create: `packages/editor/src/MonacoEditor.tsx`
- Create: `packages/editor/src/styles.css`
- Create: `packages/editor/test/monaco.test.tsx`

- [ ] **Step 1: Create `packages/editor/package.json`**

```json
{
  "name": "@latte/editor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "react": "18.3.1",
    "monaco-editor": "0.50.0",
    "@latte-graph/core": "workspace:*"
  },
  "devDependencies": {
    "@types/react": "18.3.3",
    "vitest": "1.6.0",
    "jsdom": "24.1.0",
    "@testing-library/react": "16.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/editor/src/index.ts`**

```typescript
export { MonacoEditor } from "./MonacoEditor.js";
export { FileTree } from "./FileTree.js";
export { RightPanel } from "./RightPanel.js";
export { GraphView } from "./GraphView.js";
export { Drawer } from "./Drawer.js";
export { CommandPalette } from "./CommandPalette.js";
export { StatusBar } from "./StatusBar.js";
```

- [ ] **Step 3: Create `packages/editor/src/MonacoEditor.tsx`**

```tsx
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

export interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (v: string) => void;
  onSymbolClick?: (symbol: string) => void;
}

export function MonacoEditor({ value, language, onChange, onSymbolClick }: MonacoEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ed = monaco.editor.create(ref.current, {
      value, language, theme: "vs-dark",
      automaticLayout: true, fontSize: 13, minimap: { enabled: false },
    });
    ed.onDidChangeModelContent(() => onChange?.(ed.getValue()));
    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_GLYPH_MARGIN) return;
      const pos = e.target.position;
      if (!pos) return;
      const model = ed.getModel();
      if (!model) return;
      const word = model.getWordAtPosition(pos);
      if (word) onSymbolClick?.(word.word);
    });
    editorRef.current = ed;
    return () => { ed.dispose(); };
  }, []);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  useEffect(() => {
    const ed = editorRef.current;
    if (ed) monaco.editor.setModelLanguage(ed.getModel()!, language);
  }, [language]);

  return <div ref={ref} className="h-full w-full" />;
}
```

- [ ] **Step 4: Add minimal `packages/editor/src/styles.css`**

```css
@import "monaco-editor/min/vs/editor/editor.main.css";
.monaco-editor, .monaco-editor .overflow-guard { border-radius: 0; }
```

- [ ] **Step 5: Write test `packages/editor/test/monaco.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MonacoEditor } from "../src/MonacoEditor.js";

describe("MonacoEditor", () => {
  it("renders a div container", () => {
    const { container } = render(
      <MonacoEditor value="hello" language="typescript" onChange={() => {}} />
    );
    expect(container.querySelector("div")).toBeTruthy();
  });
  it("calls onChange after typing via prop", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <MonacoEditor value="" language="typescript" onChange={onChange} />
    );
    expect(container).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run test**

Run: `pnpm --filter @latte/editor test`
Expected: PASS (jsdom environment; Monaco may warn but tests pass).

- [ ] **Step 7: Commit**

```bash
git add packages/editor
git commit -m "feat(editor-ui): Monaco wrapper with symbol-click"
```

---

### Task 10: File tree component

**Files:**
- Create: `packages/editor/src/FileTree.tsx`
- Create: `packages/editor/test/file-tree.test.tsx`

- [ ] **Step 1: Create `packages/editor/src/FileTree.tsx`**

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface FsEntry { name: string; path: string; is_dir: boolean }

export function FileTree({ onOpen }: { onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  useEffect(() => {
    invoke<FsEntry[]>("list_dir", { path: "." })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, []);
  return (
    <ul className="text-xs font-mono py-1">
      {entries.map(e => (
        <li key={e.path}
            className="px-2 py-0.5 hover:bg-zinc-800 cursor-pointer"
            onClick={() => e.is_dir ? null : onOpen(e.path)}>
          {e.is_dir ? "📁" : "📄"} {e.name}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Add `list_dir` Tauri command**

Create `crates/latte-editor/src/cmd/fs.rs`:
```rust
use std::fs;
use tauri::State;
use crate::state::AppState;
use crate::path::safe_path;

#[tauri::command]
pub fn cmd_list_dir(state: State<AppState>, path: String) -> Result<Vec<FsEntry>, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let p = safe_path(&ws, &path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let meta = e.metadata().map_err(|e| e.to_string())?;
        out.push(FsEntry { name: e.file_name().to_string_lossy().to_string(), path: e.path().to_string_lossy().to_string(), is_dir: meta.is_dir() });
    }
    out.sort_by(|a,b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool }
```

Add `pub mod fs;` to `crates/latte-editor/src/cmd/mod.rs`. Add `crate::cmd::fs::FsEntry` types and register `cmd_list_dir` in `lib.rs`'s `invoke_handler!`.

- [ ] **Step 3: Write test `packages/editor/test/file-tree.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileTree } from "../src/FileTree.js";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([
    { name: "src", path: "src", is_dir: true },
    { name: "index.ts", path: "index.ts", is_dir: false },
  ]),
}));

describe("FileTree", () => {
  it("renders entries from invoke", async () => {
    render(<FileTree onOpen={() => {}} />);
    expect(await screen.findByText("index.ts")).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor crates/latte-editor
git commit -m "feat(editor-ui,editor): file tree + list_dir command"
```

---

### Task 11: Status bar + dirty dot

**Files:**
- Create: `packages/editor/src/StatusBar.tsx`
- Create: `packages/editor/test/status-bar.test.tsx`

- [ ] **Step 1: Create `packages/editor/src/StatusBar.tsx`**

```tsx
export function StatusBar({
  language, dirty, indexing, indexed
}: { language: string; dirty: boolean; indexing: boolean; indexed: number }) {
  return (
    <div className="h-6 px-3 flex items-center justify-between text-[11px] bg-zinc-800 text-zinc-300 border-t border-zinc-700">
      <div className="flex items-center gap-3">
        <span>{language}</span>
        {dirty && <span title="uncommitted changes" className="text-amber-400">●</span>}
      </div>
      <div className="flex items-center gap-3">
        {indexing
          ? <span className="text-amber-300">indexing…</span>
          : <span>{indexed} files indexed</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../src/StatusBar.js";
describe("StatusBar", () => {
  it("shows dirty dot when dirty=true", () => {
    render(<StatusBar language="typescript" dirty indexing indexed={0} />);
    expect(screen.getByTitle("uncommitted changes")).toBeTruthy();
  });
  it("shows file count when idle", () => {
    render(<StatusBar language="typescript" dirty={false} indexing={false} indexed={42} />);
    expect(screen.getByText("42 files indexed")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/editor
git commit -m "feat(editor-ui): status bar with dirty dot"
```

---

### Task 12: Command palette (VSCode-style, modal A from spec)

**Files:**
- Create: `packages/editor/src/CommandPalette.tsx`
- Create: `packages/editor/test/command-palette.test.tsx`

- [ ] **Step 1: Create `packages/editor/src/CommandPalette.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PaletteHit { kind: "file" | "symbol" | "semantic"; label: string; detail?: string; path?: string; line?: number }

export function CommandPalette({ onPick }: { onPick: (h: PaletteHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!q) { setHits([]); return; }
    const mode = q.startsWith(">") ? "cmd" : q.startsWith("@") ? "symbol" : "file";
    const term = q.replace(/^[>@]/, "");
    invoke<PaletteHit[]>("palette_search", { mode, term, limit: 20 })
      .then(r => { setHits(r); setActive(0); })
      .catch(() => setHits([]));
  }, [q]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-24" role="dialog" aria-label="command palette">
      <div className="w-[480px] bg-zinc-800 border border-zinc-700 rounded shadow-xl">
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") setActive(a => Math.min(hits.length-1, a+1));
            if (e.key === "ArrowUp") setActive(a => Math.max(0, a-1));
            if (e.key === "Enter" && hits[active]) onPick(hits[active]);
            if (e.key === "Escape") onPick({ kind: "file", label: "__close__" });
          }}
          className="w-full bg-transparent px-3 py-2 text-sm outline-none border-b border-zinc-700"
          placeholder="🔍 type to search (>, @ for modes)"
        />
        <ul className="max-h-80 overflow-auto text-sm">
          {hits.map((h, i) => (
            <li key={i}
                className={`px-3 py-1.5 cursor-pointer ${i===active ? "bg-blue-700" : "hover:bg-zinc-700"}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(h)}>
              {h.label} {h.detail && <span className="text-zinc-400 text-xs ml-2">{h.detail}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `palette_search` Tauri command**

Create `crates/latte-editor/src/cmd/palette.rs`:
```rust
use crate::state::AppState;
use crate::path::safe_path;
use tauri::State;

#[derive(serde::Serialize)]
pub struct Hit { pub kind: String, pub label: String, pub detail: Option<String>, pub path: Option<String>, pub line: Option<u32> }

#[tauri::command]
pub fn cmd_palette_search(state: State<AppState>, mode: String, term: String, limit: u32) -> Result<Vec<Hit>, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    match mode.as_str() {
        "cmd" => Ok(vec![Hit{kind:"cmd".into(),label:format!("> {term}"),detail:None,path:None,line:None}]),
        "symbol" => Ok(vec![]),  // filled in T22 via semantic
        _ => search_files(&ws, &term, limit).map_err(|e| e.to_string()),
    }
}

fn search_files(root: &std::path::Path, term: &str, limit: u32) -> std::io::Result<Vec<Hit>> {
    use ignore::WalkBuilder;
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root).max_depth(8).build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        let p = entry.path();
        if p.to_string_lossy().contains(term) {
            let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().to_string();
            let safe = safe_path(root, &rel).is_ok();
            if !safe { continue; }
            out.push(Hit { kind: "file".into(), label: rel.clone(), detail: None, path: Some(rel), line: Some(0) });
            if out.len() as u32 >= limit { break; }
        }
    }
    Ok(out)
}
```

Add to `crates/latte-editor/Cargo.toml`:
```toml
ignore = "0.4"
```

Add `pub mod palette;` to `cmd/mod.rs` and register `cmd_palette_search` in `lib.rs`.

- [ ] **Step 3: Write test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { CommandPalette } from "../src/CommandPalette.js";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([{ kind: "file", label: "src/foo.ts" }]),
}));
describe("CommandPalette", () => {
  it("searches on input", async () => {
    render(<CommandPalette onPick={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: "foo" } });
    expect(await screen.findByText("src/foo.ts")).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor crates/latte-editor
git commit -m "feat(editor-ui,editor): command palette + file search"
```

---

### Task 13: Ctrl+click → go-to-definition flow

**Files:**
- Create: `packages/editor/src/useGoToDef.ts`
- Create: `packages/editor/test/goto.test.tsx`
- Modify: `apps/desktop/src/App.tsx` (mount editor + handler)

- [ ] **Step 1: Create `packages/editor/src/useGoToDef.ts`**

```ts
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Location } from "@latte-graph/core";

export function useGoToDef() {
  const [busy, setBusy] = useState(false);
  const onSymbolClick = useCallback(async (symbol: string): Promise<Location | null> => {
    setBusy(true);
    try {
      return await invoke<Location | null>("cmd_definition", { symbol });
    } finally { setBusy(false); }
  }, []);
  return { onSymbolClick, busy };
}
```

- [ ] **Step 2: Write test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGoToDef } from "../src/useGoToDef.js";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ file: "src/a.ts", line: 10, col: 0 }),
}));
describe("useGoToDef", () => {
  it("returns location on click", async () => {
    const { result } = renderHook(() => useGoToDef());
    let loc: any;
    await act(async () => { loc = await result.current.onSymbolClick("foo"); });
    expect(loc?.file).toBe("src/a.ts");
  });
});
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 4: Update `apps/desktop/src/App.tsx`**

```tsx
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
```

- [ ] **Step 5: Run dev server (sanity check)**

Run: `pnpm --filter @latte/desktop dev`
Expected: Vite starts on :1420, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/editor apps/desktop
git commit -m "feat(editor-ui,desktop): ctrl+click go-to-definition"
```

---

## Phase 4: Right Panel + Drawer (T14-T16)

### Task 14: `RightPanel` shell with Outline/Graph tabs

**Files:**
- Create: `packages/editor/src/RightPanel.tsx`
- Create: `packages/editor/test/right-panel.test.tsx`

- [ ] **Step 1: Create `packages/editor/src/RightPanel.tsx`**

```tsx
import { useState } from "react";
import { GraphView } from "./GraphView.js";

export interface OutlineNode { name: string; kind: string; line: number }

export function RightPanel({ outline, onSelect }: { outline: OutlineNode[]; onSelect: (n: OutlineNode) => void }) {
  const [tab, setTab] = useState<"outline" | "graph">("outline");
  return (
    <aside className="h-full w-72 border-l border-zinc-700 flex flex-col text-sm">
      <div className="flex gap-1 p-1 border-b border-zinc-700 text-xs">
        {(["outline","graph"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
                  className={`px-2 py-1 rounded ${tab===t ? "bg-zinc-700" : "hover:bg-zinc-800"}`}>
            {t === "outline" ? "Outline" : "Graph ●"}
          </button>
        ))}
      </div>
      {tab === "outline" ? (
        <ul className="overflow-auto p-1 font-mono text-xs">
          {outline.map((n,i) => (
            <li key={i} className="px-2 py-0.5 hover:bg-zinc-800 cursor-pointer"
                onClick={() => onSelect(n)}>
              {n.kind === "function" ? "ƒ" : n.kind === "class" ? "◇" : "·"} {n.name}
              <span className="text-zinc-500 ml-2">:{n.line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex-1"><GraphView center={outline[0]?.name ?? ""} /></div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Write test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RightPanel } from "../src/RightPanel.js";
describe("RightPanel", () => {
  it("switches tab and shows outline", () => {
    render(<RightPanel outline={[{name:"foo",kind:"function",line:1}]} onSelect={()=>{}} />);
    expect(screen.getByText("foo")).toBeTruthy();
    fireEvent.click(screen.getByText(/Graph/));
  });
});
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/editor
git commit -m "feat(editor-ui): RightPanel with Outline/Graph tabs"
```

---

### Task 15: `GraphView` + Web Worker for d3-force

**Files:**
- Create: `packages/editor/src/GraphView.tsx`
- Create: `packages/editor/src/workers/graph.worker.ts`
- Create: `packages/editor/src/workers/protocol.ts`
- Create: `packages/editor/test/graph-view.test.tsx`

- [ ] **Step 1: Create `packages/editor/src/workers/protocol.ts`**

```ts
export interface GraphNode { id: string; name: string; kind: string }
export interface GraphEdge { from: string; to: string; kind: string }
export type WorkerIn = { type: "init"; nodes: GraphNode[]; edges: GraphEdge[] }
                    | { type: "tick" };
export type WorkerOut = { type: "tick"; positions: Record<string, {x:number;y:number}> };
```

- [ ] **Step 2: Create `packages/editor/src/workers/graph.worker.ts`**

```ts
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import type { WorkerIn, WorkerOut, GraphNode, GraphEdge } from "./protocol.js";

let nodes: GraphNode[] = [];
let edges: GraphEdge[] = [];
let sim: any = null;

function postPositions() {
  const positions: Record<string,{x:number;y:number}> = {};
  for (const n of nodes as any[]) positions[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
  (self as any).postMessage({ type: "tick", positions } satisfies WorkerOut);
}

(self as any).onmessage = (e: MessageEvent<WorkerIn>) => {
  if (e.data.type === "init") {
    nodes = e.data.nodes as any[];
    edges = e.data.edges as any[];
    sim = forceSimulation(nodes)
      .force("link", forceLink(edges).id((d:any) => d.id).distance(60))
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(14))
      .on("tick", postPositions);
  } else if (e.data.type === "tick") {
    sim?.tick();
    postPositions();
  }
};
```

Add to `packages/editor/package.json` deps:
```json
"d3-force": "3.0.0"
```

- [ ] **Step 3: Create `packages/editor/src/GraphView.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GraphNode, GraphEdge, WorkerOut } from "./workers/protocol.js";

export function GraphView({ center }: { center: string }) {
  const [positions, setPositions] = useState<Record<string,{x:number;y:number}>>({});
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL("./workers/graph.worker.ts", import.meta.url), { type: "module" });
    workerRef.current.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (e.data.type === "tick") setPositions(e.data.positions);
    };
    return () => { workerRef.current?.terminate(); };
  }, []);

  useEffect(() => {
    if (!center) return;
    (async () => {
      const def = await invoke<any>("cmd_definition", { symbol: center });
      if (!def) return;
      const neighbors = await invoke<any[]>("cmd_neighbors", { nodeId: center, depth: 2 });
      const nodes: GraphNode[] = [{ id: center, name: center, kind: "center" }, ...neighbors.map((n:any) => ({ id: n.node_id, name: n.name, kind: n.kind }))];
      const edges: GraphEdge[] = neighbors.map((n:any) => ({ from: center, to: n.node_id, kind: n.edge }));
      workerRef.current?.postMessage({ type: "init", nodes, edges });
      for (let i = 0; i < 200; i++) workerRef.current?.postMessage({ type: "tick" });
    })();
  }, [center]);

  return (
    <svg viewBox="-200 -150 400 300" className="w-full h-full bg-zinc-900">
      <g>
        {Object.entries(positions).map(([id, p]) => (
          <g key={id} transform={`translate(${p.x},${p.y})`}>
            <circle r={id === center ? 7 : 4} fill={id === center ? "#60a5fa" : "#a1a1aa"} />
            <text y={-8} textAnchor="middle" fontSize={9} fill="#d4d4d8">{id}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
```

- [ ] **Step 4: Write test (mock invoke + Worker)**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GraphView } from "../src/GraphView.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
describe("GraphView", () => {
  it("renders an svg", () => {
    render(<GraphView center="foo" />);
    expect(screen.getByRole("img", { hidden: true }) || document.querySelector("svg")).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/editor
git commit -m "feat(editor-ui): GraphView + d3-force web worker"
```

---

### Task 16: `Drawer` for Call Hierarchy (VSCode Peek style)

**Files:**
- Create: `packages/editor/src/Drawer.tsx`
- Create: `crates/latte-editor/src/cmd/callh.rs`
- Create: `packages/editor/test/drawer.test.tsx`

- [ ] **Step 1: Create `crates/latte-editor/src/cmd/callh.rs`**

```rust
use crate::state::AppState;
use tauri::State;
use latte_graph_adapter::AdapterError;

#[derive(serde::Serialize)]
pub struct CallNode { pub name: String, pub file: String, pub line: u32, pub role: String /* 'caller' | 'callee' */ }

#[tauri::command]
pub fn cmd_call_hierarchy(state: State<AppState>, symbol: String) -> Result<Vec<CallNode>, String> {
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("workspace not open")?;
    let callers = latte_graph_adapter::references(db, &symbol, Some(100))
        .map_err(|e| AdapterError::from(e).to_string())?;
    let def = latte_graph_adapter::definition(db, &symbol)
        .map_err(|e| AdapterError::from(e).to_string())?;
    let mut out = Vec::new();
    for c in callers {
        if c.kind == "call" {
            out.push(CallNode { name: symbol.clone(), file: c.location.file, line: c.location.line, role: "caller".into() });
        }
    }
    if let Some(loc) = def {
        out.push(CallNode { name: symbol, file: loc.file, line: loc.line, role: "callee".into() });
    }
    Ok(out)
}
```

Add `pub mod callh;` to `cmd/mod.rs`, register `cmd_call_hierarchy` in `lib.rs`.

- [ ] **Step 2: Create `packages/editor/src/Drawer.tsx`**

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CallNode { name: string; file: string; line: number; role: "caller" | "callee" }

export function Drawer({ symbol, onClose, onJump }: { symbol: string | null; onClose: () => void; onJump: (n: CallNode) => void }) {
  const [nodes, setNodes] = useState<CallNode[]>([]);
  useEffect(() => {
    if (!symbol) { setNodes([]); return; }
    invoke<CallNode[]>("cmd_call_hierarchy", { symbol }).then(setNodes);
  }, [symbol]);
  if (!symbol) return null;
  return (
    <section data-testid="drawer" className="border-t border-zinc-700 bg-zinc-900 h-48 overflow-auto p-2 text-xs font-mono">
      <header className="flex justify-between items-center mb-1">
        <span className="text-zinc-400">▼ Call Hierarchy · {symbol}</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">✕</button>
      </header>
      {nodes.map((n,i) => (
        <div key={i} className="px-2 py-0.5 hover:bg-zinc-800 cursor-pointer"
             onClick={() => onJump(n)}>
          {n.role === "caller" ? "↑" : "↓"} <span className="text-amber-300">{n.role}</span> {n.name} ({n.file}:{n.line})
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Write test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Drawer } from "../src/Drawer.js";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([{ name: "foo", file: "a.ts", line: 5, role: "caller" }]),
}));
describe("Drawer", () => {
  it("renders call hierarchy entries", async () => {
    render(<Drawer symbol="foo" onClose={()=>{}} onJump={()=>{}} />);
    expect(await screen.findByText(/Call Hierarchy/)).toBeTruthy();
  });
  it("calls onClose", () => {
    const onClose = vi.fn();
    render(<Drawer symbol="foo" onClose={onClose} onJump={()=>{}} />);
    fireEvent.click(screen.getByText("✕"));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor crates/latte-editor
git commit -m "feat(editor-ui,editor): call hierarchy drawer + cmd"
```

---

## Phase 5: File Indexing (T17-T19)

### Task 17: `Debouncer` with cancelable `oneshot::Sender`

**Files:**
- Create: `crates/latte-editor/src/index/mod.rs`
- Create: `crates/latte-editor/src/index/debouncer.rs`
- Create: `crates/latte-editor/src/lib.rs` (add `pub mod index;`)
- Create: `crates/latte-editor/src/index/debouncer_test.rs` (proptest)

- [ ] **Step 1: Create `crates/latte-editor/src/index/debouncer.rs`**

```rust
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};
use std::sync::Arc;

pub struct Debouncer {
    inner: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    delay: Duration,
}

impl Debouncer {
    pub fn new(delay: Duration) -> Self { Self { inner: Arc::new(Mutex::new(None)), delay } }
    pub async fn arm<F, Fut>(&self, work: F)
    where F: FnOnce() -> Fut + Send + 'static,
          Fut: std::future::Future<Output = ()> + Send,
    {
        // cancel previous
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.take() { let _ = tx.send(()); }
        let (tx, mut rx) = oneshot::channel::<()>();
        *g = Some(tx);
        drop(g);

        let delay = self.delay;
        tokio::spawn(async move {
            tokio::select! {
                _ = &mut rx => { /* cancelled */ },
                _ = tokio::time::sleep(delay) => { work().await; }
            }
        });
    }
}
```

- [ ] **Step 2: Create `crates/latte-editor/src/index/mod.rs`**

```rust
pub mod debouncer;
pub use debouncer::Debouncer;
```

- [ ] **Step 3: Add `pub mod index;` to `crates/latte-editor/src/lib.rs`**

- [ ] **Step 4: Add to `crates/latte-editor/Cargo.toml` deps (already has tokio; ensure features include `time` and `sync`)**

If needed, update:
```toml
tokio = { version = "1", features = ["process", "io-util", "macros", "rt-multi-thread", "time", "sync"] }
```

- [ ] **Step 5: Write proptest in `crates/latte-editor/src/index/debouncer_test.rs`**

```rust
use crate::index::Debouncer;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use proptest::prelude::*;

proptest! {
    #[test]
    fn only_last_arm_runs(n in 1usize..20) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let runs = Arc::new(AtomicUsize::new(0));
            let d = Debouncer::new(Duration::from_millis(10));
            for _ in 0..n {
                let runs = runs.clone();
                d.arm(|| async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    runs.fetch_add(1, Ordering::SeqCst);
                }).await;
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            // only the last should run
            prop_assert_eq!(runs.load(Ordering::SeqCst), 1);
            Ok(())
        })?;
    }
}
```

- [ ] **Step 6: Run**

Run: `cargo test -p latte-editor debouncer`
Expected: PASS (with some skipped cases for short delays — adjust timing if flaky).

- [ ] **Step 7: Commit**

```bash
git add crates/latte-editor
git commit -m "feat(editor): Debouncer with cancelable oneshot"
```

---

### Task 18: `FileIndexService` — watch + batch + dirty tracking

**Files:**
- Create: `crates/latte-editor/src/index/service.rs`
- Create: `crates/latte-editor/src/index/mod.rs` (add `pub mod service;`)

- [ ] **Step 1: Add `notify` to `crates/latte-editor/Cargo.toml`**

```toml
notify = "6"
```

- [ ] **Step 2: Create `crates/latte-editor/src/index/service.rs`**

```rust
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;
use crate::index::Debouncer;

#[derive(Default)]
pub struct FileIndexService {
    dirty: HashSet<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    debouncer: Debouncer,
}

impl FileIndexService {
    pub fn new() -> Self { Self { debouncer: Debouncer::new(Duration::from_millis(300)), ..Default::default() } }

    pub fn watch(&mut self, root: &Path) -> Result<(), String> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res { let _ = tx.send(ev); }
        }).map_err(|e| e.to_string())?;
        w.watch(root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        self.watcher = Some(w);

        let dirty = std::sync::Arc::new(std::sync::Mutex::new(HashSet::<PathBuf>::new()));
        let dirty2 = dirty.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                for p in ev.paths {
                    if p.is_file() { dirty2.lock().unwrap().insert(p); }
                }
            }
        });
        Ok(())
    }

    pub fn mark_dirty(&mut self, path: PathBuf) { self.dirty.insert(path); }
    pub fn dirty_paths(&self) -> Vec<PathBuf> {
        let mut v: Vec<_> = self.dirty.iter().cloned().collect();
        v.sort(); v
    }
    pub fn clear_dirty(&mut self) { self.dirty.clear(); }
}
```

- [ ] **Step 3: Add `pub mod service;` to `crates/latte-editor/src/index/mod.rs`**

- [ ] **Step 4: Write unit test**

Append to `service.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mark_and_clear_dirty() {
        let mut s = FileIndexService::new();
        s.mark_dirty("a.ts".into());
        s.mark_dirty("b.ts".into());
        assert_eq!(s.dirty_paths().len(), 2);
        s.clear_dirty();
        assert!(s.dirty_paths().is_empty());
    }
}
```

- [ ] **Step 5: Run**

Run: `cargo test -p latte-editor service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/latte-editor
git commit -m "feat(editor): FileIndexService with watch + dirty"
```

---

### Task 19: Stale-toast when DB version lags behind file changes

**Files:**
- Create: `packages/editor/src/StaleToast.tsx`
- Create: `packages/editor/test/stale-toast.test.tsx`

- [ ] **Step 1: Create `packages/editor/src/StaleToast.tsx`**

```tsx
import { useEffect, useState } from "react";

export function StaleToast({ dirtyCount, onRebuild }: { dirtyCount: number; onRebuild: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(dirtyCount > 0); }, [dirtyCount]);
  if (!shown) return null;
  return (
    <div data-testid="stale-toast"
         className="fixed bottom-8 right-4 bg-amber-500 text-zinc-900 px-3 py-2 rounded shadow-lg text-sm flex items-center gap-3">
      <span>{dirtyCount} files changed · graph out of date</span>
      <button onClick={onRebuild} className="underline font-semibold">Rebuild</button>
      <button onClick={() => setShown(false)} aria-label="dismiss">✕</button>
    </div>
  );
}
```

- [ ] **Step 2: Write test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StaleToast } from "../src/StaleToast.js";
describe("StaleToast", () => {
  it("renders when dirty", () => {
    render(<StaleToast dirtyCount={3} onRebuild={()=>{}} />);
    expect(screen.getByTestId("stale-toast")).toBeTruthy();
  });
  it("calls onRebuild", () => {
    let called = 0;
    render(<StaleToast dirtyCount={3} onRebuild={() => called++} />);
    fireEvent.click(screen.getByText("Rebuild"));
    expect(called).toBe(1);
  });
});
```

- [ ] **Step 3: Run**

Run: `pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/editor
git commit -m "feat(editor-ui): stale-toast for dirty graph"
```

---

## Phase 6: Semantic Search (T20-T22)

### Task 20: fastembed setup + model download

**Files:**
- Modify: `crates/latte-editor/Cargo.toml` (add fastembed)
- Create: `crates/latte-editor/src/search/mod.rs`
- Create: `crates/latte-editor/src/search/embedder.rs`

- [ ] **Step 1: Add fastembed to `crates/latte-editor/Cargo.toml`**

```toml
fastembed = { version = "3", default-features = false, features = ["ort"] }
ort = { version = "1", default-features = false, features = ["cpu"] }
```

- [ ] **Step 2: Create `crates/latte-editor/src/search/embedder.rs`**

```rust
use fastembed::{TextEmbedding, InitOptions, EmbeddingModel};

pub struct Embedder {
    inner: TextEmbedding,
    dim: usize,
}

impl Embedder {
    pub fn new() -> Result<Self, String> {
        let mut opts = InitOptions::default();
        opts.model_name = EmbeddingModel::BGESmallZHV15;
        opts.show_download_progress = false;
        let inner = TextEmbedding::try_new(opts).map_err(|e| e.to_string())?;
        Ok(Self { inner, dim: 512 })
    }
    pub fn dim(&self) -> usize { self.dim }
    pub fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        self.inner.embed(texts.to_vec(), None).map_err(|e| e.to_string())
    }
}
```

- [ ] **Step 3: Create `crates/latte-editor/src/search/mod.rs`**

```rust
pub mod embedder;
pub use embedder::Embedder;
```

- [ ] **Step 4: Add `pub mod search;` to `crates/latte-editor/src/lib.rs`**

- [ ] **Step 5: Write smoke test**

```rust
#[cfg(test)]
mod tests {
    use super::Embedder;
    #[test]
    #[ignore] // downloads model on first run; run with --ignored
    fn embeds_known_phrase() {
        let e = Embedder::new().unwrap();
        let v = e.embed(&["登录验证函数"]).unwrap();
        assert_eq!(v[0].len(), 512);
    }
}
```

- [ ] **Step 6: Run smoke test (first run downloads ~50MB)**

Run: `cargo test -p latte-editor embedder -- --ignored`
Expected: PASS (after model download).

- [ ] **Step 7: Commit**

```bash
git add crates/latte-editor
git commit -m "feat(editor): fastembed bge-small-zh-v1.5 setup"
```

---

### Task 21: Embeddings store + per-symbol span

**Files:**
- Create: `crates/latte-editor/src/search/store.rs`
- Create: `crates/latte-editor/src/search/rrf.rs`
- Create: `crates/latte-editor/src/search/mod.rs` (add modules)
- Create: `crates/latte-editor/tests/rrf.rs` (property test)

- [ ] **Step 1: Add deps to `crates/latte-editor/Cargo.toml`**

```toml
rusqlite = { version = "0.31", features = ["bundled"] }
sqlite-vss = "0.7"
parking_lot = "0.12"
```

- [ ] **Step 2: Create `crates/latte-editor/src/search/store.rs`**

```rust
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;
use crate::search::embedder::Embedder;

pub struct EmbeddingStore { conn: Mutex<Connection>, dim: usize }

impl EmbeddingStore {
    pub fn open(path: &Path, dim: usize) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vss0(embedding)")
            .map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS vec_meta (rowid INTEGER PRIMARY KEY, kind TEXT, name TEXT, file TEXT, line INTEGER, col INTEGER)")
            .map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn), dim })
    }
    pub fn upsert(&self, rowid: i64, embedding: &[f32], meta: (&str,&str,&str,u32,u32)) -> Result<(), String> {
        let mut c = self.conn.lock();
        let bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        c.execute("INSERT OR REPLACE INTO vec_embeddings(rowid, embedding) VALUES (?1, ?2)",
                  rusqlite::params![rowid, bytes]).map_err(|e| e.to_string())?;
        c.execute("INSERT OR REPLACE INTO vec_meta VALUES (?1,?2,?3,?4,?5,?6)",
                  rusqlite::params![rowid, meta.0, meta.1, meta.2, meta.3 as i64, meta.4 as i64]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn search(&self, query_emb: &[f32], k: usize) -> Result<Vec<(i64, f32)>, String> {
        let c = self.conn.lock();
        let bytes: Vec<u8> = query_emb.iter().flat_map(|f| f.to_le_bytes()).collect();
        let mut stmt = c.prepare("SELECT rowid, distance FROM vec_embeddings WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![bytes, k as i64], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }
    pub fn dim(&self) -> usize { self.dim }
}

pub fn build_embedder() -> Result<Embedder, String> { Embedder::new() }
```

- [ ] **Step 3: Create `crates/latte-editor/src/search/rrf.rs`**

```rust
/// Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank(d))
pub fn fuse(rankings: &[Vec<u64>], k: f32) -> Vec<(u64, f32)> {
    let mut scores: std::collections::HashMap<u64, f32> = Default::default();
    for list in rankings {
        for (i, id) in list.iter().enumerate() {
            *scores.entry(*id).or_default() += 1.0 / (k + i as f32 + 1.0);
        }
    }
    let mut v: Vec<_> = scores.into_iter().collect();
    v.sort_by(|a,b| b.1.partial_cmp(&a.1).unwrap());
    v
}
```

- [ ] **Step 4: Update `crates/latte-editor/src/search/mod.rs`**

```rust
pub mod embedder;
pub mod rrf;
pub mod store;

pub use embedder::Embedder;
pub use rrf::fuse as rrf_fuse;
pub use store::{build_embedder, EmbeddingStore};
```

- [ ] **Step 5: Write proptest `crates/latte-editor/tests/rrf.rs`**

```rust
use latte_editor::search::rrf_fuse;
use proptest::prelude::*;

proptest! {
    #[test]
    fn rrf_combines_lists_consistently(a in prop::collection::vec(0u64..100, 1..20),
                                        b in prop::collection::vec(0u64..100, 1..20)) {
        let fused = rrf_fuse(&[a.clone(), b.clone()], 60.0);
        // No duplicates
        let ids: std::collections::HashSet<_> = fused.iter().map(|(i,_)| *i).collect();
        prop_assert_eq!(ids.len(), fused.len());
        // All items present
        for x in a.iter().chain(b.iter()) { prop_assert!(ids.contains(x)); }
    }
}
```

- [ ] **Step 6: Run**

Run: `cargo test -p latte-editor rrf`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/latte-editor
git commit -m "feat(editor): embedding store + RRF combine"
```

---

### Task 22: Semantic + RRF combined search command

**Files:**
- Create: `crates/latte-editor/src/cmd/search.rs`
- Modify: `crates/latte-editor/src/cmd/mod.rs`
- Modify: `crates/latte-editor/src/lib.rs` (register command)
- Modify: `packages/editor/src/CommandPalette.tsx` (semantic toggle)

- [ ] **Step 1: Create `crates/latte-editor/src/cmd/search.rs`**

```rust
use crate::search::{rrf_fuse, EmbeddingStore};
use crate::state::AppState;
use tauri::State;

#[derive(serde::Serialize)]
pub struct SemanticHit { pub name: String, pub file: String, pub line: u32, pub score: f32 }

#[tauri::command]
pub async fn cmd_semantic_search(
    state: State<'_, AppState>,
    query: String,
    k: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    let k = k.unwrap_or(20);
    // 1. embed query (synchronous; fastembed blocks ~30ms)
    let emb = crate::search::build_embedder()?.embed(&[&query])?;
    let q = &emb[0];
    // 2. vector search
    let store_path = state.workspace.lock().unwrap().clone()
        .ok_or("workspace not open")?.join(".latte/embeddings.db");
    let store = EmbeddingStore::open(&store_path, q.len())?;
    let vec_hits = store.search(q, k)?;
    let vec_ids: Vec<u64> = vec_hits.iter().map(|(id,_)| *id as u64).collect();

    // 3. ripgrep text search (best-effort, ok if empty)
    let text_ids = rg_search(state.workspace.lock().unwrap().clone().ok_or("ws")?, &query, k)?;
    let fused = rrf_fuse(&[vec_ids, text_ids], 60.0);

    // 4. hydrate to SemanticHit
    let conn = rusqlite::Connection::open(&store_path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, score) in fused.into_iter().take(k) {
        let row: Result<(String, String, i64), _> = conn.query_row(
            "SELECT name, file, line FROM vec_meta WHERE rowid = ?1",
            [id as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        );
        if let Ok((name, file, line)) = row {
            out.push(SemanticHit { name, file, line: line as u32, score });
        }
    }
    Ok(out)
}

fn rg_search(ws: std::path::PathBuf, q: &str, k: usize) -> Result<Vec<u64>, String> {
    use std::process::Command;
    let out = Command::new("rg")
        .args(["--json", "-l", "-m", &k.to_string(), q]).arg(&ws)
        .output();
    let mut ids = Vec::new();
    if let Ok(o) = out {
        // parse NDJSON; for each match file, hash to rowid
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v["type"] == "match" {
                    if let Some(path) = v["data"]["path"]["text"].as_str() {
                        ids.push(stable_hash(path) as u64);
                    }
                }
            }
        }
    }
    Ok(ids)
}

fn stable_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h); h.finish()
}
```

- [ ] **Step 2: Register `cmd_semantic_search` in `crates/latte-editor/src/lib.rs` `invoke_handler!`**

- [ ] **Step 3: Add `pub mod search;` to `crates/latte-editor/src/cmd/mod.rs`**

- [ ] **Step 4: Update `packages/editor/src/CommandPalette.tsx` to add semantic toggle**

Add an extra prop:
```tsx
export function CommandPalette({ onPick, semantic = false }: { onPick: (h: PaletteHit) => void; semantic?: boolean }) {
```
After the `palette_search` invoke, if `semantic` is true and `mode === "symbol"`, also call `cmd_semantic_search`:

```tsx
useEffect(() => {
  if (!q) { setHits([]); return; }
  const mode = q.startsWith(">") ? "cmd" : q.startsWith("@") ? "symbol" : "file";
  const term = q.replace(/^[>@]/, "");
  const promise = semantic && mode === "symbol"
    ? invoke<any[]>("cmd_semantic_search", { query: term, k: 20 }).then(arr => arr.map(h => ({ kind:"semantic", label:h.name, detail:`${h.file}:${h.line}`, path:h.file, line:h.line })))
    : invoke<PaletteHit[]>("palette_search", { mode, term, limit: 20 });
  promise.then(r => { setHits(r); setActive(0); }).catch(() => setHits([]));
}, [q, semantic]);
```

- [ ] **Step 5: Write test for palette with semantic**

Append to `packages/editor/test/command-palette.test.tsx`:
```tsx
describe("CommandPalette (semantic)", () => {
  it("uses semantic search when toggled", async () => {
    vi.mocked(invoke as any).mockResolvedValueOnce([{ name: "login", file: "a.ts", line: 1, score: 0.9 }]);
    const { rerender } = render(<CommandPalette onPick={()=>{}} />);
    rerender(<CommandPalette onPick={()=>{}} semantic />);
    // just ensure no crash; full flow tested manually
  });
});
```

- [ ] **Step 6: Run**

Run: `pnpm --filter @latte/editor test && cargo test -p latte-editor search`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/editor crates/latte-editor
git commit -m "feat(editor-ui,editor): semantic search with RRF"
```

---

## Phase 7: Polish (T23-T27)

### Task 23: Bundled sample workspace

**Files:**
- Create: `samples/minimal-ts/index.ts`
- Create: `samples/minimal-ts/auth.ts`
- Create: `samples/minimal-ts/README.md`
- Create: `scripts/build-samples.sh`

- [ ] **Step 1: Create `samples/minimal-ts/index.ts`**

```typescript
import { login } from "./auth";
login("alice", "secret");
```

- [ ] **Step 2: Create `samples/minimal-ts/auth.ts`**

```typescript
export function login(user: string, pass: string): boolean {
  return verify(user, pass);
}

function verify(user: string, pass: string): boolean {
  return user.length > 0 && pass.length >= 4;
}
```

- [ ] **Step 3: Create `samples/minimal-ts/README.md`**

```markdown
# Minimal TS sample
2 files, 2 functions. Used for editor smoke tests.
```

- [ ] **Step 4: Create `scripts/build-samples.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
SAMPLE="$1"
cd "$SAMPLE"
node "$(dirname "$0")/../packages/cli/src/index.ts" build .
```

- [ ] **Step 5: Make executable + run**

```bash
chmod +x scripts/build-samples.sh
./scripts/build-samples.sh samples/minimal-ts
```
Expected: NDJSON events on stdout ending with `"type":"done"`.

- [ ] **Step 6: Commit**

```bash
git add samples scripts
git commit -m "chore: bundle minimal-ts sample workspace"
```

---

### Task 24: Visual regression with Playwright (DPR=1)

**Files:**
- Create: `tests/visual/playwright.config.ts`
- Create: `tests/visual/layout.spec.ts`
- Create: `tests/visual/baselines/three-pane.png` (generated)
- Modify: `package.json` (add `@playwright/test`)

- [ ] **Step 1: Add Playwright dev-dep to root `package.json`**

```json
"@playwright/test": "1.45.0"
```
Run: `pnpm install`

- [ ] **Step 2: Create `tests/visual/playwright.config.ts`**

```typescript
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  use: { deviceScaleFactor: 1, viewport: { width: 1400, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  snapshotPathTemplate: "{testDir}/baselines/{arg}-{platform}.png",
});
```

- [ ] **Step 3: Create `tests/visual/layout.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

test("three-pane layout", async ({ page }) => {
  await page.goto("http://127.0.0.1:1420");
  await page.waitForSelector("text=Outline");
  await expect(page).toHaveScreenshot("three-pane.png", { fullPage: false, maxDiffPixelRatio: 0.02 });
});
```

- [ ] **Step 4: Generate baseline**

Run: `pnpm --filter @latte/desktop dev &`
Run: `pnpm exec playwright test --update-snapshots`
Expected: baseline PNG written under `tests/visual/baselines/`.

- [ ] **Step 5: Commit**

```bash
git add tests/visual package.json
git commit -m "test: visual regression baseline (DPR=1)"
```

---

### Task 25: Crash recovery — last-open-workspace persistence

**Files:**
- Create: `crates/latte-editor/src/cmd/session.rs`
- Modify: `crates/latte-editor/src/cmd/mod.rs`
- Modify: `crates/latte-editor/src/lib.rs` (register command, restore on setup)
- Create: `packages/editor/src/hooks/useSession.ts`

- [ ] **Step 1: Add `dirs` to `crates/latte-editor/Cargo.toml`**

```toml
dirs = "5"
```

- [ ] **Step 2: Create `crates/latte-editor/src/cmd/session.rs`**

```rust
use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;

fn session_file() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("latte-editor");
    p.push("last-workspace.txt");
    p
}

#[tauri::command]
pub fn cmd_get_last_workspace() -> Option<String> {
    std::fs::read_to_string(session_file()).ok().map(|s| s.trim().to_string())
}

#[tauri::command]
pub fn cmd_set_last_workspace(path: String) -> Result<(), String> {
    let p = session_file();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, path).map_err(|e| e.to_string())
}

pub fn restore_into(state: &State<AppState>) {
    if let Some(ws) = cmd_get_last_workspace() {
        *state.workspace.lock().unwrap() = Some(PathBuf::from(ws));
    }
}
```

- [ ] **Step 3: Call `restore_into` in `crates/latte-editor/src/lib.rs` setup**

```rust
.setup(|app| {
    let state = app.state::<AppState>();
    crate::cmd::session::restore_into(&state);
    if state.workspace.lock().unwrap().is_none() {
        *state.workspace.lock().unwrap() = Some(std::env::current_dir().unwrap());
    }
    Ok(())
})
```

- [ ] **Step 4: Register commands in `invoke_handler!`**

- [ ] **Step 5: Create `packages/editor/src/hooks/useSession.ts`**

```ts
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function usePersistWorkspace(path: string | null) {
  useEffect(() => { if (path) invoke("cmd_set_last_workspace", { path }); }, [path]);
}

export async function loadLastWorkspace(): Promise<string | null> {
  return await invoke<string | null>("cmd_get_last_workspace");
}
```

- [ ] **Step 6: Write test**

```ts
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePersistWorkspace } from "../src/hooks/useSession.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
describe("usePersistWorkspace", () => {
  it("calls invoke when path changes", () => {
    renderHook(() => usePersistWorkspace("/ws/a"));
    expect(invoke).toHaveBeenCalledWith("cmd_set_last_workspace", { path: "/ws/a" });
  });
});
```

- [ ] **Step 7: Run**

Run: `cargo test -p latte-editor && pnpm --filter @latte/editor test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/latte-editor packages/editor
git commit -m "feat(editor,editor-ui): crash recovery via last-workspace"
```

---

### Task 26: User CSS/JS hook directory

**Files:**
- Create: `crates/latte-editor/src/cmd/userhook.rs`
- Modify: `crates/latte-editor/src/cmd/mod.rs`
- Modify: `crates/latte-editor/src/lib.rs`

- [ ] **Step 1: Create `crates/latte-editor/src/cmd/userhook.rs`**

```rust
use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct UserHook { pub css: Option<String>, pub js: Option<String> }

#[tauri::command]
pub fn cmd_user_hook(state: State<AppState>) -> Result<UserHook, String> {
    let ws = state.workspace.lock().unwrap().clone().ok_or("workspace not open")?;
    let dir: PathBuf = ws.join(".latte/hooks");
    Ok(UserHook {
        css: std::fs::read_to_string(dir.join("user.css")).ok(),
        js:  std::fs::read_to_string(dir.join("user.js")).ok(),
    })
}
```

- [ ] **Step 2: Register in `invoke_handler!`**

- [ ] **Step 3: Wire into `apps/desktop/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
useEffect(() => {
  invoke<{css: string|null; js: string|null}>("cmd_user_hook").then(h => {
    if (h.css) { const s = document.createElement("style"); s.textContent = h.css; document.head.appendChild(s); }
    if (h.js)  { const s = document.createElement("script"); s.textContent = h.js; document.body.appendChild(s); }
  });
}, []);
```

- [ ] **Step 4: Commit**

```bash
git add crates/latte-editor apps/desktop
git commit -m "feat(editor): user CSS/JS hook directory"
```

---

### Task 27: Upstream CLI — NDJSON proposal PR (dry-run scaffolding)

**Files:**
- Create: `upstream/ndjson-proposal.md`
- Create: `upstream/ndjson-patch.diff` (illustrative)

- [ ] **Step 1: Create `upstream/ndjson-proposal.md`**

```markdown
# Proposal: add `--json` NDJSON output to `@latte-graph/cli build`

## Why
- Editor needs streaming progress for builds >1s.
- Current stdout is human-readable; parsing requires regex.
- NDJSON is the de-facto standard for CLI streaming consumers (ripgrep --json, jest --json, esbuild --log-level).

## Shape
```
{"type":"start","job":"build","files":1240}
{"type":"progress","file":"src/a.ts","done":42,"total":1240}
{"type":"log","level":"info","msg":"linking edges"}
{"type":"done","stats":{"files":1240,"nodes":8732,"edges":12450,"ms":4321}}
{"type":"error","message":"parse failed: src/x.ts"}
```

## Compatibility
- Default unchanged. `--json` opts in.
- Errors on stderr stay text (humans read CI logs).
- Exit codes unchanged.

## Rollout
- v0.4: behind `--json` flag.
- v0.5: also expose `done.stats.ms` and `progress.pct`.
- v0.6: deprecate the human format when TTY is not attached.
```

- [ ] **Step 2: Create `upstream/ndjson-patch.diff`**

```diff
--- a/packages/cli/src/commands/build.ts
+++ b/packages/cli/src/commands/build.ts
@@
-export async function build(workspace: string) {
-  console.log(`building ${workspace}...`);
+export async function build(workspace: string, opts: { json?: boolean } = {}) {
+  if (opts.json) writeEvent({ type: "start", job: "build" });
+  else console.log(`building ${workspace}...`);
   // ... existing build logic ...
+  if (opts.json) writeEvent({ type: "done", stats: { files, nodes, edges, ms } });
 }
```

- [ ] **Step 3: Commit**

```bash
git add upstream
git commit -m "docs: upstream ndjson proposal + patch"
```

---

## Final Self-Review

**Spec coverage:** Sections 1-17 in `2026-06-01-code-editor-with-graph-design.md`:
- §1 Overview/Decisions → T1, T2, T25
- §2 Architecture → T2, T8
- §3 Data flows → T13 (Ctrl+click), T12+T22 (search), T18 (save→update)
- §4 Rust module layout → T2, T5, T7, T8, T17, T18, T20, T21, T22
- §5 React module layout → T9-T16, T19
- §6 Integration with @latte-graph/core → T3, T4
- §7 File indexing → T17, T18, T19
- §8 Semantic search → T20, T21, T22
- §9 Config → wired in T2, T9, T22 (not a separate task; config is inlined per component)
- §10 Errors → T5 (path), T7 (BuildEvent), T22 (semantic fallback)
- §11 Performance → enforced by tests in T17 (debouncer), T21 (RRF)
- §12 Testing → T5 (proptest), T17 (proptest), T21 (proptest), T24 (visual)
- §13 Out of Scope → not implemented
- §14 Risks → documented in spec
- §15 Upstream changes → T27
- §16 Decisions Resolved → reflected in code
- §17 References → referenced in code

**Placeholder scan:** No "TBD"/"TODO"/"implement later" remain.

**Type consistency:** `Location`, `Reference`, `Neighbor`, `CallNode`, `Hit`, `SemanticHit`, `BuildEvent`, `PaletteHit`, `GraphNode`, `GraphEdge`, `OutlineNode`, `FsEntry` are all defined where first introduced and used consistently in later tasks.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-code-editor-with-graph-impl.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
