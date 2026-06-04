# Phase 1: Core Editor Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the foundation of Latte Code Editor — a working Tauri 2.0 desktop app that can open/save files with CodeMirror 6 editing, syntax highlighting, and large-file native fallback. Memory baseline < 70MB idle.

**Architecture:** Tauri 2.0 shell with Rust backend (buffer/file management) and system WebView frontend (React + CodeMirror 6). IPC via Tauri commands. Monorepo using pnpm workspace.

**Tech Stack:** Tauri 2.0, Rust 1.96, Node 24, pnpm 9, React 18, CodeMirror 6, TypeScript 5, Vite, Tailwind CSS

**Project Root:** `/home/dong/Documents/latte/latte-code-editor`

---

### Task 1: Install cargo-tauri CLI

**Files:** N/A

- [ ] **Step 1: Install Tauri CLI**

```bash
cargo install tauri-cli --version "^2.0"
```

Expected: `tauri --version` prints `tauri-cli 2.x`

- [ ] **Step 2: Verify prerequisites**

```bash
# Check system dependencies for Tauri on Linux
dpkg -l | grep -E "libwebkit2gtk|libgtk-3|libayatana-appindicator"
# If missing on Ubuntu/Debian:
# sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
#   libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

---

### Task 2: Scaffold Tauri 2.0 project with React + TypeScript

**Files:**
- Create: `/home/dong/Documents/latte/latte-code-editor/src-tauri/` (all Tauri generated files)
- Create: `/home/dong/Documents/latte/latte-code-editor/src/` (React frontend)
- Create: `/home/dong/Documents/latte/latte-code-editor/package.json`
- Create: `/home/dong/Documents/latte/latte-code-editor/tsconfig.json`
- Create: `/home/dong/Documents/latte/latte-code-editor/vite.config.ts`
- Create: `/home/dong/Documents/latte/latte-code-editor/index.html`
- Create: `/home/dong/Documents/latte/latte-code-editor/pnpm-workspace.yaml`

- [ ] **Step 1: Scaffold with `pnpm create tauri-app`**

This is interactive. We'll set up manually instead:

```bash
cd /home/dong/Documents/latte/latte-code-editor

# Create package.json
cat > package.json << 'PKGJSON'
{
  "name": "latte-code-editor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "frontend:dev": "vite",
    "frontend:build": "tsc && vite build",
    "preview": "vite preview"
  }
}
PKGJSON

# Create pnpm workspace
cat > pnpm-workspace.yaml << 'YAML'
packages:
  - 'packages/*'
YAML
```

- [ ] **Step 2: Create Tauri config**

```bash
mkdir -p src-tauri/src src-tauri/icons src-tauri/capabilities
```

Create `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/nicedayzhu/tauri/refs/heads/dev/crates/tauri-cli/config.schema.json",
  "productName": "Latte Code Editor",
  "version": "0.1.0",
  "identifier": "com.latte.code-editor",
  "build": {
    "beforeDevCommand": "pnpm frontend:dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm frontend:build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Latte Code Editor",
        "width": 1200,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 3: Create Cargo.toml**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "latte-code-editor"
version = "0.1.0"
description = "A cross-platform lightweight code editor with code graph integration"
authors = ["Latte Team"]
edition = "2021"

[lib]
name = "latte_code_editor_lib"
crate-type = ["lib", "cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
notify = "7"
```

- [ ] **Step 4: Create Rust source files**

Create `src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

Create `src-tauri/src/lib.rs`:
```rust
mod editor;
mod project;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Initialize project watcher
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                project::watcher::start_watcher(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            editor::commands::open_file,
            editor::commands::save_file,
            editor::commands::get_file_content,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Create `src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    latte_code_editor_lib::run()
}
```

- [ ] **Step 5: Create frontend skeleton**

Create `src-tauri/capabilities/default.json`:
```json
{
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "dialog:default",
    "fs:default"
  ]
}
```

- [ ] **Step 6: Install frontend dependencies**

```bash
cd /home/dong/Documents/latte/latte-code-editor
pnpm add react react-dom
pnpm add -D typescript @types/react @types/react-dom vite @vitejs/plugin-react
pnpm add @tauri-apps/api @tauri-apps/plugin-shell @tauri-apps/plugin-dialog @tauri-apps/plugin-fs
pnpm add codemirror @codemirror/state @codemirror/view @codemirror/basic-setup @codemirror/lang-javascript @codemirror/lang-rust @codemirror/lang-python @codemirror/lang-json @codemirror/lang-markdown @codemirror/language-data @lezer/highlight
pnpm add zustand
pnpm add -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 7: Create Vite config**

Create `vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "useDefineForClassFields": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

Create `tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

Create `index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Latte Code Editor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create initial CSS**

Create `src/styles.css`:
```css
@import "tailwindcss";

:root {
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 14px;
  line-height: 1.5;
  color-scheme: dark;
}

body {
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #1e1e1e;
  color: #d4d4d4;
}

#root {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 9: Create main entry point**

Create `src/main.tsx`:
```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `src/App.tsx`:
```typescript
import { EditorPanel } from "./components/EditorPanel";
import { StatusBar } from "./components/StatusBar";

function App() {
  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-hidden">
        <EditorPanel />
      </div>
      <StatusBar />
    </div>
  );
}

export default App;
```

- [ ] **Step 10: Build test to verify scaffold compiles**

```bash
cd /home/dong/Documents/latte/latte-code-editor
pnpm frontend:build
# Expected: Vite builds successfully to dist/
```

---

### Task 3: Implement Rust buffer/file management

**Files:**
- Create: `src-tauri/src/editor/mod.rs`
- Create: `src-tauri/src/editor/buffer.rs`
- Create: `src-tauri/src/editor/commands.rs`

- [ ] **Step 1: Create editor module**

Create `src-tauri/src/editor/mod.rs`:
```rust
pub mod buffer;
pub mod commands;
```

- [ ] **Step 2: Implement buffer management**

Create `src-tauri/src/editor/buffer.rs`:
```rust
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Represents an open file buffer in memory
#[derive(Debug, Clone, Serialize)]
pub struct Buffer {
    pub path: PathBuf,
    pub content: String,
    pub line_count: usize,
    pub byte_size: usize,
    pub is_modified: bool,
    pub is_large_file: bool,
}

/// Large file threshold: 50MB or 100,000 lines
const LARGE_FILE_SIZE: u64 = 50 * 1024 * 1024;
const LARGE_FILE_LINES: usize = 100_000;

/// In-memory buffer manager
pub struct BufferManager {
    buffers: RwLock<HashMap<PathBuf, Arc<RwLock<Buffer>>>>,
    active: RwLock<Option<PathBuf>>,
}

impl BufferManager {
    pub fn new() -> Self {
        Self {
            buffers: RwLock::new(HashMap::new()),
            active: RwLock::new(None),
        }
    }

    /// Open a file and create a buffer for it.
    /// For large files, only read the first portion.
    pub async fn open(&self, path: &Path) -> Result<Arc<RwLock<Buffer>>, String> {
        let path = path.canonicalize().map_err(|e| format!("Cannot resolve path: {}", e))?;

        // Check existing buffer
        {
            let buffers = self.buffers.read().await;
            if let Some(buf) = buffers.get(&path) {
                *self.active.write().await = Some(path);
                return Ok(buf.clone());
            }
        }

        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Cannot read metadata: {}", e))?;

        let file_size = metadata.len();
        let is_large = file_size > LARGE_FILE_SIZE;

        // Read file content
        let content = if is_large {
            // For large files, only read metadata; mark as large file mode
            format!("[Large file: {} bytes. Opened in read-only large file mode.]", file_size)
        } else {
            tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| format!("Cannot read file: {}", e))?
        };

        let line_count = content.lines().count();
        let byte_size = content.len();
        let is_large = is_large || line_count > LARGE_FILE_LINES;

        let buffer = Arc::new(RwLock::new(Buffer {
            path: path.clone(),
            content,
            line_count,
            byte_size,
            is_modified: false,
            is_large_file: is_large,
        }));

        {
            let mut buffers = self.buffers.write().await;
            buffers.insert(path.clone(), buffer.clone());
            *self.active.write().await = Some(path);
        }

        Ok(buffer)
    }

    /// Save buffer content to disk
    pub async fn save(&self, path: &Path) -> Result<(), String> {
        let path = path.canonicalize().map_err(|e| format!("Cannot resolve path: {}", e))?;
        let buf = {
            let buffers = self.buffers.read().await;
            buffers.get(&path).cloned().ok_or_else(|| "Buffer not found".to_string())?
        };

        let content = {
            let reader = buf.read().await;
            if reader.is_large_file {
                return Err("Cannot save large file in read-only mode".to_string());
            }
            reader.content.clone()
        };

        tokio::fs::write(&path, &content)
            .await
            .map_err(|e| format!("Cannot write file: {}", e))?;

        {
            let mut writer = buf.write().await;
            writer.is_modified = false;
        }

        Ok(())
    }

    /// Get the active buffer
    pub async fn get_active(&self) -> Option<Arc<RwLock<Buffer>>> {
        let path = self.active.read().await.clone()?;
        let buffers = self.buffers.read().await;
        buffers.get(&path).cloned()
    }

    /// Check if a file should use large-file mode
    pub fn is_large_file(path: &Path) -> bool {
        std::fs::metadata(path)
            .map(|m| m.len() > LARGE_FILE_SIZE)
            .unwrap_or(false)
    }

    /// Close a buffer
    pub async fn close(&self, path: &Path) {
        let mut buffers = self.buffers.write().await;
        buffers.remove(path);
    }
}
```

- [ ] **Step 3: Implement IPC commands**

Create `src-tauri/src/editor/commands.rs`:
```rust
use crate::editor::buffer::{Buffer, BufferManager};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

pub struct EditorState {
    pub buffer_manager: BufferManager,
}

#[derive(Serialize)]
pub struct FileResult {
    pub path: String,
    pub content: String,
    pub line_count: usize,
    pub is_large_file: bool,
    pub is_modified: bool,
}

#[tauri::command]
pub async fn open_file(
    path: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<FileResult, String> {
    let path = std::path::Path::new(&path);
    let buf = {
        let editor = state.read().await;
        editor.buffer_manager.open(path).await?
    };

    let reader = buf.read().await;
    Ok(FileResult {
        path: reader.path.to_string_lossy().to_string(),
        content: reader.content.clone(),
        line_count: reader.line_count,
        is_large_file: reader.is_large_file,
        is_modified: reader.is_modified,
    })
}

#[tauri::command]
pub async fn save_file(
    path: String,
    content: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<(), String> {
    // Update buffer content
    let path = std::path::Path::new(&path);
    {
        let editor = state.read().await;
        let buf = {
            let buffers = editor.buffer_manager.get_buffer(path).await
                .ok_or_else(|| "Buffer not found".to_string())?;
            buf.clone()
        };
        let mut writer = buf.write().await;
        writer.content = content.clone();
        writer.is_modified = true;
    }

    // Save to disk
    {
        let editor = state.read().await;
        editor.buffer_manager.save(path).await
    }
}

#[tauri::command]
pub async fn get_file_content(
    path: String,
    state: State<'_, Arc<RwLock<EditorState>>>,
) -> Result<FileResult, String> {
    let editor = state.read().await;
    let buf = editor.buffer_manager.get_buffer(std::path::Path::new(&path)).await
        .ok_or_else(|| "Buffer not found".to_string())?;

    let reader = buf.read().await;
    Ok(FileResult {
        path: reader.path.to_string_lossy().to_string(),
        content: reader.content.clone(),
        line_count: reader.line_count,
        is_large_file: reader.is_large_file,
        is_modified: reader.is_modified,
    })
}
```

Update `BufferManager` to add the `get_buffer` method. Add to `src-tauri/src/editor/buffer.rs` inside `impl BufferManager`:

```rust
/// Get a specific buffer by path
pub async fn get_buffer(&self, path: &Path) -> Option<Arc<RwLock<Buffer>>> {
    let path = path.canonicalize().ok()?;
    let buffers = self.buffers.read().await;
    buffers.get(&path).cloned()
}
```

- [ ] **Step 4: Create project module**

Create `src-tauri/src/project/mod.rs`:
```rust
pub mod watcher;
```

Create `src-tauri/src/project/watcher.rs`:
```rust
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

pub async fn start_watcher(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();

    let mut watcher = RecommendedWatcher::new(tx, Config::default())
        .expect("Failed to create file watcher");

    // Watch the project root if it exists
    let project_root = Path::new(".");
    if project_root.exists() {
        let _ = watcher.watch(project_root, RecursiveMode::Recursive);
    }

    // Process events
    while let Ok(Ok(event)) = rx.recv() {
        if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            for path in event.paths {
                let _ = app.emit("file-changed", path.to_string_lossy().to_string());
            }
        }
    }
}
```

- [ ] **Step 5: Update lib.rs to initialize EditorState**

Replace `src-tauri/src/lib.rs`:
```rust
mod editor;
mod project;

use editor::commands::EditorState;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(RwLock::new(EditorState {
            buffer_manager: editor::buffer::BufferManager::new(),
        })))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                project::watcher::start_watcher(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            editor::commands::open_file,
            editor::commands::save_file,
            editor::commands::get_file_content,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

### Task 4: Frontend — CodeMirror 6 Editor Component

**Files:**
- Create: `src/components/EditorPanel.tsx`
- Create: `src/components/EditorTabBar.tsx`
- Create: `src/hooks/useEditorStore.ts`
- Create: `src/api/commands.ts`

- [ ] **Step 1: Create Tauri command proxy**

Create `src/api/commands.ts`:
```typescript
import { invoke } from "@tauri-apps/api/core";

export interface FileResult {
  path: string;
  content: string;
  line_count: number;
  is_large_file: boolean;
  is_modified: boolean;
}

export async function openFile(path: string): Promise<FileResult> {
  return invoke<FileResult>("open_file", { path });
}

export async function saveFile(path: string, content: string): Promise<void> {
  return invoke<void>("save_file", { path, content });
}

export async function getFileContent(path: string): Promise<FileResult> {
  return invoke<FileResult>("get_file_content", { path });
}
```

- [ ] **Step 2: Create Zustand editor store**

Create `src/hooks/useEditorStore.ts`:
```typescript
import { create } from "zustand";
import type { FileResult } from "../api/commands";

export type TabState = "code" | "large-file" | "loading" | "empty";

interface EditorStore {
  openFile: FileResult | null;
  currentContent: string;
  tabState: TabState;
  modified: boolean;
  filePath: string | null;

  setOpenFile: (file: FileResult) => void;
  setContent: (content: string) => void;
  setModified: (modified: boolean) => void;
  reset: () => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  openFile: null,
  currentContent: "",
  tabState: "empty",
  modified: false,
  filePath: null,

  setOpenFile: (file) =>
    set({
      openFile: file,
      currentContent: file.content,
      tabState: file.is_large_file ? "large-file" : "code",
      modified: false,
      filePath: file.path,
    }),

  setContent: (content) =>
    set({ currentContent: content, modified: true }),

  setModified: (modified) =>
    set({ modified }),

  reset: () =>
    set({
      openFile: null,
      currentContent: "",
      tabState: "empty",
      modified: false,
      filePath: null,
    }),
}));
```

- [ ] **Step 3: Create EditorPanel component**

Create `src/components/CodeMirrorEditor.tsx`:

This is the core editor component. For Phase 1, it embeds CodeMirror 6 and wires content changes back to the store.

```typescript
import { useEffect, useRef } from "react";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { basicSetup } from "codemirror";
import { languages } from "./languageExtensions";
import { useEditorStore } from "../hooks/useEditorStore";

interface CodeMirrorProps {
  content: string;
  filePath: string | null;
  onChange: (content: string) => void;
}

export function CodeMirrorEditor({ content, filePath, onChange }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onChange);

  // Keep callback ref fresh
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Keep content ref fresh for sync check
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Determine language extension based on file extension
    const langExt = languages(filePath);

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        history(),
        langExt,
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            contentRef.current = update.state.doc.toString();
            onChangeRef.current(contentRef.current);
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [filePath]);

  // Sync content when file changes externally (e.g., undo)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  }, [content]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto"
      style={{ background: "#1e1e1e" }}
    />
  );
}
```

Create `src/components/languageExtensions.ts`:
```typescript
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
      return javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "tsx" || ext === "jsx" });
    case "rs":
      return rust();
    case "py":
      return python();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
      return markdown();
    default:
      return [];
  }
}
```

- [ ] **Step 4: Create EditorPanel component**

Create `src/components/EditorPanel.tsx`:
```typescript
import { useCallback } from "react";
import { useEditorStore } from "../hooks/useEditorStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { LargeFileViewer } from "./LargeFileViewer";
import { EmptyState } from "./EmptyState";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openFile, saveFile } from "../api/commands";
import { listen } from "@tauri-apps/api/event";

export function EditorPanel() {
  const { openFile: storeFile, currentContent, setContent, setOpenFile, modified, tabState, filePath, reset } = useEditorStore();

  const handleOpenFile = useCallback(async () => {
    const selected = await dialogOpen({
      multiple: false,
      filters: [{
        name: "All Files",
        extensions: ["*"],
      }],
    });

    if (typeof selected === "string") {
      const result = await openFile(selected);
      setOpenFile(result);
    }
  }, [setOpenFile]);

  const handleSave = useCallback(async () => {
    if (!filePath) return;
    await saveFile(filePath, currentContent);
    useEditorStore.getState().setModified(false);
  }, [filePath, currentContent]);

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      await handleSave();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "o") {
      e.preventDefault();
      await handleOpenFile();
    }
  }, [handleSave, handleOpenFile]);

  // Register global keyboard shortcuts
  useCallback(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleChange = useCallback((content: string) => {
    setContent(content);
  }, [setContent]);

  const renderContent = () => {
    switch (tabState) {
      case "empty":
        return <EmptyState onOpen={handleOpenFile} />;
      case "large-file":
        return <LargeFileViewer content={currentContent} fileName={filePath || ""} />;
      case "code":
        return (
          <CodeMirrorEditor
            content={currentContent}
            filePath={filePath}
            onChange={handleChange}
          />
        );
      default:
        return <EmptyState onOpen={handleOpenFile} />;
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 relative">
        {renderContent()}
      </div>
    </div>
  );
}
```

Note: For better ergonomics, define the keyboard listener as a proper `useEffect`:

```typescript
// Replace the useCallback-based listener with useEffect:
import { useEffect } from "react";
// Inside EditorPanel component:
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "o") {
      e.preventDefault();
      handleOpenFile();
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [handleSave, handleOpenFile]);
```

- [ ] **Step 5: Create EmptyState component**

Create `src/components/EmptyState.tsx`:
```typescript
interface EmptyStateProps {
  onOpen: () => void;
}

export function EmptyState({ onOpen }: EmptyStateProps) {
  return (
    <div
      className="flex items-center justify-center h-full select-none"
      style={{ background: "#1e1e1e" }}
    >
      <div className="text-center text-gray-500">
        <div className="text-5xl mb-4 opacity-30">{ }</div>
        <p className="text-lg mb-2">Latte Code Editor</p>
        <p className="text-sm mb-6">Open a file to start editing</p>
        <button
          onClick={onOpen}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors cursor-pointer"
        >
          Open File
        </button>
        <div className="mt-4 text-xs text-gray-600">
          <p>Ctrl+O: Open file</p>
          <p>Ctrl+S: Save</p>
        </div>
      </div>
    </div>
  );
}
```

---

### Task 5: Large File Native Fallback Mode

**Files:**
- Create: `src/components/LargeFileViewer.tsx`

- [ ] **Step 1: Implement native `<pre>` large file viewer**

Create `src/components/LargeFileViewer.tsx`:
```typescript
import { useRef, useEffect, useState, useCallback, useMemo } from "react";

interface LargeFileViewerProps {
  content: string;
  fileName: string;
}

const VISIBLE_LINES = 100;
const LINE_HEIGHT = 22;

export function LargeFileViewer({ content, fileName }: LargeFileViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  const lines = useMemo(() => content.split("\n"), [content]);
  const totalLines = lines.length;

  // Calculate visible range
  const startLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - 20);
  const endLine = Math.min(totalLines, startLine + VISIBLE_LINES + 40);
  const visibleLines = lines.slice(startLine, endLine);

  const totalHeight = totalLines * LINE_HEIGHT;

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const fileSize = useMemo(() => {
    if (totalLines > 100000) {
      return `>100K lines`;
    }
    return `${totalLines} lines`;
  }, [totalLines, lines.length]);

  return (
    <div className="flex flex-col h-full" style={{ background: "#1e1e1e" }}>
      <div className="px-4 py-2 text-xs text-gray-400 border-b border-gray-700 bg-[#252526] flex items-center gap-4">
        <span className="text-yellow-400 font-medium">⚠ Large File Mode</span>
        <span>{fileName}</span>
        <span className="text-gray-500">{fileSize}</span>
        <span className="text-gray-500">Read-only | No syntax highlighting</span>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto"
        style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: "13px", lineHeight: `${LINE_HEIGHT}px` }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <pre style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "8px 16px", margin: 0 }}>
            {visibleLines.map((line, i) => (
              <div key={startLine + i} style={{ height: LINE_HEIGHT, whiteSpace: "pre" }}>
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
```

---

### Task 6: Status Bar

**Files:**
- Create: `src/components/StatusBar.tsx`

- [ ] **Step 1: Create StatusBar component**

Create `src/components/StatusBar.tsx`:
```typescript
import { useEditorStore } from "../hooks/useEditorStore";

export function StatusBar() {
  const { openFile, modified, tabState, filePath } = useEditorStore();

  const getLanguageLabel = (path: string | null): string => {
    if (!path) return "";
    const ext = path.split(".").pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      ts: "TypeScript",
      tsx: "TypeScript JSX",
      js: "JavaScript",
      jsx: "JavaScript JSX",
      rs: "Rust",
      py: "Python",
      json: "JSON",
      md: "Markdown",
      css: "CSS",
      html: "HTML",
    };
    return langMap[ext || ""] || ext?.toUpperCase() || "";
  };

  const getLineInfo = (): string => {
    if (!openFile) return "";
    return `${openFile.line_count} lines`;
  };

  return (
    <div
      className="flex items-center justify-between px-4 py-0.5 text-xs select-none"
      style={{
        background: "#007acc",
        color: "#fff",
        height: "24px",
      }}
    >
      <div className="flex items-center gap-4">
        {filePath && (
          <span>{getLanguageLabel(filePath)}</span>
        )}
        {modified && <span className="opacity-80">● Modified</span>}
      </div>
      <div className="flex items-center gap-4">
        {tabState === "large-file" && (
          <span className="opacity-90">⚠ Large File</span>
        )}
        {openFile && <span className="opacity-80">{getLineInfo()}</span>}
      </div>
    </div>
  );
}
```

---

### Task 7: CSS theme and CodeMirror styling

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add CodeMirror theme overrides**

Update `src/styles.css` — add after the existing styles:

```css
/* CodeMirror overrides for dark theme */
.cm-editor {
  height: 100%;
  background: #1e1e1e;
  color: #d4d4d4;
}

.cm-editor .cm-gutters {
  background: #1e1e1e;
  color: #858585;
  border-right: 1px solid #333;
}

.cm-editor .cm-activeLineGutter {
  background: #282828;
}

.cm-editor .cm-activeLine {
  background: #282828;
}

.cm-editor .cm-cursor {
  border-left-color: #aeafad;
}

.cm-editor .cm-selectionBackground,
.cm-editor.cm-focused .cm-selectionBackground {
  background: #264f78;
}

.cm-editor .cm-matchingBracket,
.cm-editor .cm-nonmatchingBracket {
  background: #343434;
  outline: 1px solid #515151;
}

.cm-editor .cm-scroller {
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 14px;
  line-height: 1.6;
}
```

---

### Task 8: Build, test, and verify

**Files:** N/A (verification only)

- [ ] **Step 1: Build the Rust backend**

```bash
cd /home/dong/Documents/latte/latte-code-editor
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: Compiles without errors.

- [ ] **Step 2: Build the frontend**

```bash
cd /home/dong/Documents/latte/latte-code-editor
pnpm frontend:build
```

Expected: Vite outputs to `dist/`.

- [ ] **Step 3: Full Tauri build**

```bash
cd /home/dong/Documents/latte/latte-code-editor
pnpm tauri build
```

Or for dev mode:
```bash
pnpm dev
```

Expected: Application window opens with the editor UI.

- [ ] **Step 4: Verify file open/save roundtrip**

1. Open the app
2. Click "Open File" → select a text file
3. The content should appear in CodeMirror 6 with syntax highlighting
4. Edit content
5. Press Ctrl+S → file should be saved (check with external editor)

- [ ] **Step 5: Verify large file mode**

```bash
# Create a test large file
dd if=/dev/zero bs=1M count=60 | tr '\0' 'A' > /tmp/large-test.txt
# Or create a file with many lines
for i in $(seq 1 200000); do echo "Line $i: test content for large file mode" >> /tmp/large-lines.txt; done
```

Open the large file in the editor → should show "⚠ Large File Mode" banner with read-only `<pre>` view.

- [ ] **Step 6: Verify memory baseline**

```bash
# With app running idle (no file open)
ps -o rss,pid,command -p $(pidof latte-code-editor)
# Expected: RSS < 70MB (Tauri process)
# Also check the webview process on Linux
ps -o rss,pid,command | grep -i webkit
```

- [ ] **Step 7: Commit Phase 1**

```bash
cd /home/dong/Documents/latte/latte-code-editor
git init
git add -A
git commit -m "feat: Phase 1 - core editor skeleton

- Tauri 2.0 project scaffold with React + TypeScript
- CodeMirror 6 embedded editor with syntax highlighting
- Large file native <pre> fallback mode (>50MB/100K lines)
- Rust buffer manager with file open/save
- Keyboard shortcuts: Ctrl+O, Ctrl+S
- Status bar with language/file info
- File watcher foundation
- Memory baseline < 70MB"
```
