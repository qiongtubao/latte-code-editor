---
title: Latte Code Editor with Graph Integration
date: 2026-06-01
status: draft
author: brainstorming session
scope: medium-tier code editor (MVP, ~1-2 months)
companion_project: /Users/zhouguodong/Documents/latte/latte-code-review-graph
related: docs/superpowers/specs (this directory will hold future specs)
---

# Latte Code Editor — Design Spec

## 1. Overview & Goals

### 1.1 One-paragraph summary
A Tauri 2 + React 18 desktop code editor that uses the existing `latte-code-review-graph` monorepo (specifically `@latte-graph/core` and `@latte-graph/cli`) as its "code graph" backend. The editor replaces LSP for navigation (go-to-definition, find-references, call hierarchy) and adds graph-aware features (local force-directed graph, impact radius, semantic search) that traditional editors do not have.

### 1.2 Goals
- Open a folder as a workspace, render file tree, multi-tab Monaco editor.
- Navigate code by graph index: Ctrl+click go-to-definition, find references, call hierarchy.
- Display a right-panel local graph (2-3 hop) for the symbol at cursor, with edge-type filter.
- Watch files smartly (default manual mode) and trigger `latte-graph update` to keep the graph fresh.
- Provide semantic search ("处理登录的函数" → `login_handler`) using a local embedding model.
- Command palette (Raycast-style) for fast access to all commands and workspace search.

### 1.3 Non-goals (v1)
- Git integration, debuggers, run configurations, extension marketplace, multi-project in one window, collaborative editing, full LSP coverage, WASM build, Windows ARM64 (best effort), Linux ARM (best effort).

### 1.4 Decisions already made (this brainstorming session)
| Decision | Choice | Reason |
|---|---|---|
| Editor scope | Medium tier (1-2 month MVP) | User selection |
| Project relation | Independent repo, pnpm workspace peer with `latte-code-review-graph` | Local edits to `core` live-reload; no release coupling |
| Frontend | React 18 + Vite + Tailwind | Match `packages/desktop` baseline |
| Editor kernel | Monaco | User selection; has tabs, minimap, syntax highlighting |
| Languages (v1) | C/C++, TS/JS, Go, Python, Java, Rust, Shell | User selection |
| Window layout | 3-pane + bottom drawer (file tree / editor / right panel; drawer for call hierarchy) | User selection B |
| Right panel | Immersive graph with floating edge-type pills, Outline toggle top-left | User selection B |
| Command palette | Raycast-style (left list + right preview) | User selection B |
| Semantic search backend | `fastembed-rs` + `sqlite-vss` (Rust, in-process) | User selection |
| Graph integration | Rust reads `graph.db` directly via `rusqlite`; spawns `latte-graph` CLI for build/update only | User selection A |
| Schema sync | `build.rs` hash check + `sqlx` compile-time SQL validation + runtime version check | User confirmation |
| File watching | Default **manual** (`Cmd+Shift+I` to index); `filtered_auto` opt-in | User selection (refined after perf analysis) |
| Error handling | `thiserror` in library crates, `anyhow` only in `commands/` boundary | User selection |
| Build runner | NDJSON stream parsed into typed `BuildEvent`, emitted to renderer | User selection |
| Extension points (no plugin runtime) | `LanguageAdapter` trait, `VectorStore` trait, custom CSS/JS | User selection |
| Path handling | `path-clean` + `dunce` canonicalize + `ignore` crate Gitignore matcher | User selection |
| Concurrency | `tokio::select!` + `oneshot` for cancelable debouncer | User selection |
| Testing | Pyramid (unit 70% / integration 25% / E2E 5%) + `proptest`/`fast-check` + Playwright visual regression | User selection |
| Localization | Default `bge-small-zh-v1.5` embedding model (zh-CN friendly) | User selection |

---

## 2. Architecture & Components

### 2.1 System diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Tauri 2.0 Desktop App                         │
│                                                                      │
│  ┌───────────────────────────┐    ┌────────────────────────────┐    │
│  │   React 18 Renderer       │    │  Rust Backend (lib.rs)     │    │
│  │   (WebView)               │    │                            │    │
│  │                           │    │  ┌──────────────────────┐  │    │
│  │  • AppShell (3-pane)      │    │  │  Commands (#[tauri]) │  │    │
│  │  • FileTree               │    │  │  • get_callers       │  │    │
│  │  • Editor (Monaco)        │◄──►│  │  • get_callees       │  │    │
│  │  • Tabs                   │    │  │  • get_node          │  │    │
│  │  • RightPanel (Graph)     │    │  │  • get_node_by_pos   │  │    │
│  │  • BottomDrawer (CallH)   │    │  │  • get_nodes_in_file │  │    │
│  │  • CommandPalette         │    │  │  • search            │  │    │
│  │  • Breadcrumb             │    │  │  • semantic_search   │  │    │
│  │  • ExplosionRadiusOverlay │    │  │  • build_graph       │  │    │
│  │  • StatusBar              │    │  │  • update_graph      │  │    │
│  │                           │    │  │  • read/write_file   │  │    │
│  │  State: Zustand stores    │    │  │  • list_dir / open   │  │    │
│  │  Cache: ipcCache LRU      │    │  │  • watch_files       │  │    │
│  │  Workers: graph-layout    │    │  │  • get_impact_radius │  │    │
│  └───────────────────────────┘    │  └──────────────────────┘  │    │
│                                   │             │              │    │
│                                   │             ▼              │    │
│                                   │  ┌──────────────────────┐  │    │
│                                   │  │  Service Layer       │  │    │
│                                   │  │  graph_query.rs      │  │    │
│                                   │  │  semantic_search.rs  │  │    │
│                                   │  │  file_index.rs       │  │    │
│                                   │  │  build_runner.rs     │  │    │
│                                   │  │  schema_sync.rs      │  │    │
│                                   │  │  debouncer.rs        │  │    │
│                                   │  └──────────────────────┘  │    │
│                                   └────────┬───────────────────┘    │
└────────────────────────────────────────┼───────────────────────────┘
                                         │
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                            ▼
   ┌─────────────────┐         ┌──────────────────┐         ┌──────────────────┐
   │  Graph SQLite   │         │  Node CLI        │         │  Embedding model │
   │  graph.db       │         │  (pnpm latte-    │         │  (fastembed,     │
   │  + vectors      │         │  graph build/    │         │  ONNX Runtime,   │
   │  (sqlite-vss)   │         │  update/clean)   │         │  ~80MB cached)   │
   │  in workspace   │         │  spawned 1-shot  │         │                  │
   │  .latte-code-   │         │  for build tasks │         │                  │
   │  review-graph/  │         │                  │         │                  │
   └─────────────────┘         └──────────────────┘         └──────────────────┘
```

### 2.2 Component boundaries

| Component | Purpose | Inputs | Outputs |
|---|---|---|---|
| `AppShell` | 3-pane + drawer layout, persists panel sizes | store state | render |
| `FileTree` | Real file tree (read disk), shows dirty dot | `list_dir`, `dirty_set` events | `open_file` invoke |
| `Editor` (Monaco) | Multi-tab editing, breadcrumb, decorations | `read_file`, `write_file`, decorations API | reveal/decorations |
| `Tabs` | Tab list with drag-sort and close | store state | `close_tab`, `set_active` |
| `RightPanel` | Immersive graph + Outline toggle, edge-type pills | `get_node_by_position`, `get_callers`, `get_callees` | focus node id, focus radius |
| `BottomDrawer` | Call hierarchy tree (called by / calls) | `get_callers`, `get_callees` | focus node id |
| `CommandPalette` | Raycast-style overlay, registers 50+ commands | all stores + all IPC | dispatch command |
| `ExplosionRadiusOverlay` | Monaco line-number ⚠ decoration on hover | cursor pos, file mtime | `get_impact_radius` |
| `StatusBar` | Build progress, cursor info, dirty count | `build://event`, cursor pos | none |
| `graph_query.rs` | Read-only SQL over `graph.db` with safety | sqlx prepared statements | `NodeRef`, `CallerHit`, `CalleeHit` |
| `semantic_search.rs` | Embed query, query `sqlite-vss`, return hits with `ContextSpan` | query string, k | `Vec<SemanticHit>` |
| `file_index.rs` | File tree + dirty set + `notify` watcher (when enabled) + debouncer | FS events | dirty_set, watcher events |
| `build_runner.rs` | Spawn `pnpm latte-graph <cmd>`, parse NDJSON, emit `BuildEvent` | cli invocation | `BuildEvent` stream + final stats |
| `schema_sync.rs` | Compare `metadata.schema_version`, trigger full rebuild if drift | db read | rebuild decision |
| `debouncer.rs` | Cancelable debounce with `tokio::select!` | schedule(work, delay) | (cancellable) work execution |
| `embeddings/model.rs` | `OnceCell<EmbedModel>`, lazy load | model id | embedder |
| `embeddings/store.rs` | sqlite-vss insert/search | vec, id | hits |
| `embeddings/span.rs` | Per-chunk embedding of a function | function source | `Vec<(span, vec)>` |

### 2.3 Critical invariants

- Renderer ↔ Backend: only through `#[tauri::command]` IPC with `specta`-generated TS types. No localhost HTTP.
- Backend ↔ Graph DB: only `rusqlite` prepared statements; all SQL strings live in `db/prepared.rs`.
- Backend ↔ Node CLI: only `build_runner.rs` may `Command::new`. Enforced by `grep` in CI.
- Path safety: every user-supplied path is canonicalized via `dunce::canonicalize` and checked against `safe_path`; never resolved to a parent of project root.
- Error layering: `thiserror` in services, `anyhow` only in `commands/`. Renderer-facing errors carry `kind` + `message` for typed recovery.

---

## 3. Data Flow (4 main flows)

### 3.1 Project open + startup

```
User          FileTree         AppShell        Rust                        Graph DB
 │                │               │              │                              │
 │ pick folder    │               │              │                              │
 ├───────────────►│               │              │                              │
 │                │ openProject() │              │                              │
 │                ├──────────────►│              │                              │
 │                │               │ open_project │                              │
 │                │               ├─────────────►│                              │
 │                │               │              │ 1. schema_sync: read version │
 │                │               │              │    metadata.schema_version?  │
 │                │               │              │    if miss → spawn build     │
 │                │               │              │ 2. list_dir(root) recursive  │
 │                │               │              │ 3. return FileTree           │
 │                │               │◄─────────────┤                              │
 │                │               │ render tree  │                              │
 │                │◄──────────────┤              │                              │
 │                │               │              │ 4. file_index::start_watch   │
 │                │               │              │    (mode=manual by default;  │
 │                │               │              │     no notify spawned)       │
```

`lib::run()` setup sequence (synchronous, on startup):
1. Read `~/.latte-editor/config.toml`. Validate schema. Apply defaults.
2. `db::init(graph_db_path)` → open SQLite pool at `<project>/.latte-code-review-graph/graph.db`, run our migrations (`0001_embeddings.sql`, `0002_meta.sql`).
3. `schema_sync::check_and_migrate()` → read `metadata.schema_version`; if mismatch, schedule background `build_runner::run("build", ["--full"])` and emit `build://event` stream.
4. `embeddings::model::init()` background task (does not block first paint).
5. Register all `#[tauri::command]` handlers and `manage(state)`.

### 3.2 Ctrl+click go-to-definition

```
User         Monaco          Commands     graph_query.rs              Graph DB
 │            (token)         (invoke)
 │ Cmd+click   │                │                │
 ├───────────►│                │                │
 │ onClick    │ Monaco built-in│                │
 │            │ word + pos     │                │
 │            │ ─────────────► │                │
 │            │                │ get_node_by_   │
 │            │                │ position(file, │
 │            │                │ line, col)     │
 │            │                ├───────────────►│
 │            │                │                │ SELECT * FROM nodes
 │            │                │                │ WHERE file_path=?
 │            │                │                │ AND start_line<=?
 │            │                │                │ AND end_line>=?
 │            │                │                │ AND valid=1
 │            │                │                ├──────────────────►│
 │            │                │                │◄─────────────────┤
 │            │                │                │ return Node
 │            │                │◄───────────────┤
 │            │                │ reveal_in_editor│
 │            │◄───────────────┤                │
 │ jump +     │                │                │
 │ highlight  │                │                │
```

`get_node_by_position` query relies on existing `idx_nodes_file_path` index (`packages/core/src/persistence/schema.sql`). Returns the **smallest** enclosing node when multiple match (e.g., a method inside a class → method wins).

### 3.3 Search (keyword + semantic) via Command Palette

```
User     Palette       Rust              ripgrep                fastembed + sqlite-vss
 │       (overlay)    (search.rs)
 │ Cmd+P  │              │                   │
 ├───────►│              │                   │
 │ "auth" │              │                   │
 │        │ debounce     │                   │
 │        │ 150ms        │                   │
 │        ├─────────────►│                   │
 │        │              │ spawn rg --json   │
 │        │              ├──────────────────►│
 │        │              │◄─────────────────┤
 │        │              │ parse JSONL hits  │
 │        │              │                   │
 │        │              │ if semantic on:   │
 │        │              │   embed(query)    │
 │        │              ├───────────────────┼──────────► fastembed
 │        │              │◄──────────────────┼──────────┤
 │        │              │ vec               │
 │        │              │ SELECT id,        │
 │        │              │   vec_distance(   │
 │        │              │     node_vec, ?)  │
 │        │              │ FROM embeddings   │
 │        │              │ ORDER BY dist     │
 │        │              │ LIMIT 20          │
 │        │              ├──────────────────►│
 │        │              │◄─────────────────┤
 │        │              │                   │
 │        │              │ merge keyword+    │
 │        │              │ semantic (RRF),   │
 │        │              │ return {kw, sem}  │
 │        │◄─────────────┤                   │
 │ left   │              │                   │
 │ list + │              │                   │
 │ right  │              │                   │
 │ preview│              │                   │
```

Two queries run in parallel (`tokio::join!`). Results merged by Reciprocal Rank Fusion (RRF, k=60) — standard technique for hybrid retrieval. Preview panel highlights either literal matches (keyword) or `ContextSpan` (semantic, with similarity score badge).

### 3.4 File save → incremental graph update

```
User    Monaco        Tauri fs    file_index.rs    build_runner.rs   Node CLI
 │      save Ctrl+S   write_file   (notify+set)     (spawn)           (pnpm)
 │         │            │            │                   │
 ├────────►│            │            │                   │
 │         │ write_file │            │                   │
 │         ├───────────►│            │                   │
 │         │            │ on save:   │                   │
 │         │            │ push path  │                   │
 │         │            │ to dirty_  │                   │
 │         │            │ set        │                   │
 │         │            ├───────────►│                   │
 │         │            │            │ debouncer.arm(    │
 │         │            │            │   500ms,          │
 │         │            │            │   trigger_update) │
 │         │            │            │                   │
 │         │            │            │ (if watch_mode    │
 │         │            │            │  = filtered_auto) │
 │         │            │            │ notify also       │
 │         │            │            │ Create/Remove →   │
 │         │            │            │ dirty_set         │
 │         │            │            │                   │
 │         │            │            │ 500ms elapsed     │
 │         │            │            │ OR len>=50        │
 │         │            │            │ ─────────────►    │
 │         │            │            │   spawn:          │
 │         │            │            │   pnpm latte-graph update
 │         │            │            │     --paths <list>│
 │         │            │            │     --format ndjson│
 │         │            │            ├──────────────────►│
 │         │            │            │                   │  parses, updates DB
 │         │            │            │   NDJSON events:  │  ~2s for 2900 files
 │         │            │            │   FileProcessed,  │
 │         │            │            │   Progress, Done  │
 │         │            │            │◄──────────────────┤
 │         │            │            │ emit "build://event"
 │         │            │            │ window-side:
 │         │            │            │ invalidate impact │
 │         │            │            │ cache by mtime    │
```

`write_file` command ALWAYS pushes to `dirty_set`, regardless of `index_mode`. This means even in manual mode, saves accumulate and a single `Cmd+Shift+I` rebuilds them all.

---

## 4. Backend (Rust) Module Layout

### 4.1 Crate structure

```
crates/latte-editor/
├── Cargo.toml                # tauri 2, sqlx, rusqlite, fastembed, notify, tokio, specta, serde, thiserror, anyhow, dunce, path-clean, ignore
├── tauri.conf.json           # 1400x900, single window, identifier: "art.latte.editor"
├── build.rs                  # 校验上游 schema.sql 存在 + 计算 hash 写入 CARGO_MANIFEST_DIR/.schema_hash; 触发 cargo:rerun-if-changed
├── migrations/
│   ├── 0001_embeddings.sql   # CREATE VIRTUAL TABLE embeddings USING vss0(...)
│   └── 0002_meta.sql         # CREATE TABLE editor_meta(key PRIMARY KEY, value)
├── src/
│   ├── main.rs               # 5 行, 调 lib::run
│   ├── lib.rs                # tauri::Builder, register commands, manage state
│   ├── state.rs              # AppState
│   ├── error.rs              # DbError, GraphError, EmbedError, BuildError, AppError
│   ├── config.rs             # 读 ~/.latte-editor/config.toml, 应用 defaults
│   ├── ipc_types.rs          # 所有跨边界 struct
│   │
│   ├── commands/             # 纯转发层,每文件 < 80 行,每函数 < 20 行
│   │   ├── mod.rs
│   │   ├── graph.rs          # get_node / get_callers / get_callees /
│   │   │                     # get_node_by_position / get_nodes_in_file / search / get_stats
│   │   ├── semantic.rs       # semantic_search
│   │   ├── editor_ops.rs     # read_file / write_file / reveal_in_editor
│   │   ├── build.rs          # build_graph / update_graph / clean / cancel_build
│   │   ├── file_ops.rs       # list_dir / open_project / watch_files
│   │   └── impact.rs         # get_impact_radius / invalidate_impact_cache
│   │
│   ├── db/
│   │   ├── mod.rs            # SqlitePool init, apply migrations, path resolve
│   │   ├── prepared.rs       # 所有 sqlx::query! 宏集中,顶部 const SCHEMA_VERSION
│   │   └── impact_cache.rs   # LRU<nodeId, (fileMtime, ImpactRadius)>
│   │
│   ├── services/
│   │   ├── mod.rs
│   │   ├── graph_query.rs    # 只读 SQL 业务逻辑,深度/数量限制,path safety
│   │   ├── semantic_search.rs# embed query + sqlite-vss + ContextSpan 排序
│   │   ├── file_index.rs     # file tree + notify watcher + dirty_set + debouncer
│   │   ├── build_runner.rs   # spawn pnpm + NDJSON 解析 + BuildEvent 流
│   │   ├── schema_sync.rs    # 启动 schema_version 比对
│   │   └── debouncer.rs      # tokio::select! 取消式 debounce
│   │
│   ├── language/             # 扩展点(只挖坑不填坑)
│   │   ├── mod.rs            # pub trait LanguageAdapter
│   │   ├── python.rs
│   │   ├── ts.rs
│   │   └── ... (7 adapters)
│   │
│   ├── embeddings/
│   │   ├── mod.rs            # pub trait VectorStore
│   │   ├── model.rs          # OnceCell<EmbedModel>, init() async
│   │   ├── span.rs           # 函数分块 + per-chunk embedding
│   │   ├── store_sqlite.rs   # sqlite-vss 实现
│   │   └── store_qdrant.rs   # 占位(#[cfg] gate 或 stub)
│   │
│   ├── utils/
│   │   ├── path.rs           # safe_path + canonicalize + case-insensitive probe
│   │   └── ignore_match.rs   # Gitignore 风格匹配器(基于 ignore crate)
│   │
│   └── tests/
│       ├── graph_query.rs    # tempfile + 真 graph.db fixture
│       ├── semantic.rs       # mock embedder
│       ├── file_index.rs     # notify + stress
│       ├── build_runner.rs   # mock pnpm
│       ├── schema_sync.rs
│       ├── debouncer.rs      # 1k 次压力测内存稳定
│       ├── property/         # proptest 用例
│       │   ├── graph.rs      # 随机 graph 不 panic / 不死循环
│       │   ├── path.rs       # 特殊字符不爆
│       │   └── should_watch.rs
│       └── perf/             # 性能冒烟,仅 nightly 跑
```

### 4.2 Key type signatures

```rust
// ipc_types.rs
#[derive(Serialize, Deserialize, Type)]
pub struct NodeRef {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub file_path: PathBuf,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub docstring: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct CallerHit { pub node: NodeRef, pub depth: u32, pub via_edge: String }

#[derive(Serialize, Deserialize, Type)]
pub struct ContextSpan {
    pub line: u32,
    pub text: String,
    pub similarity: f32,
}

#[derive(Serialize, Deserialize, Type)]
pub struct SemanticHit {
    pub node: NodeRef,
    pub score: f32,
    pub context: Vec<ContextSpan>,   // top-K most similar chunks
}

#[derive(Serialize, Deserialize, Type)]
pub struct ImpactRadius {
    pub node_id: String,
    pub depth: u32,
    pub affected_files: u32,
    pub affected_functions: u32,
    pub sample_paths: Vec<PathBuf>,  // 最多 10 个示例
}

#[derive(Serialize, Deserialize, Type)]
pub struct GraphStaleness {
    pub stale: bool,
    pub dirty_count: u32,
    pub last_built_at: i64,           // unix ms
    pub now: i64,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "data")]
pub enum BuildEvent {
    Started    { backend: String, total_files: u32 },
    FileProcessed { path: PathBuf, processed: u32, total: u32 },
    Progress   { phase: String, current: u32, total: u32 },
    Error      { message: String, recoverable: bool },
    Done       { elapsed_ms: u64, stats: GraphStats },
    Cancelled,
}

// error.rs
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("schema version mismatch: expected {expected}, got {actual}")]
    SchemaMismatch { expected: i32, actual: i32 },
    #[error("migration {name} failed: {source}")]
    MigrationFailed { name: String, #[source] source: sqlx::Error },
    #[error("query failed: {0}")]           Query(#[from] sqlx::Error),
    #[error("connection failed: {0}")]      Pool(#[from] sqlx::PoolError),
}

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("node {0} not found")]         NodeNotFound(String),
    #[error("file {0} not indexed")]       FileNotIndexed(PathBuf),
    #[error("depth {0} exceeds max {1}")]  DepthExceeded(u32, u32),
    #[error("unsafe path: {0}")]           UnsafePath(String),
    #[error("db: {0}")]                    Db(#[from] DbError),
}

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("model not loaded")]           NotReady,
    #[error("encode failed: {0}")]         Encode(String),
    #[error("dim mismatch: model={model} db={db}")] DimMismatch { model: usize, db: usize },
    #[error("store: {0}")]                 Store(String),
}

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("spawn pnpm failed: {0}")]     Spawn(#[from] std::io::Error),
    #[error("cli exited {code}: {stderr}")] CliFailed { code: i32, stderr: String },
    #[error("json parse: {0}")]            Parse(#[from] serde_json::Error),
    #[error("cancelled")]                  Cancelled,
}

// commands/ layer uses anyhow
pub type CmdResult<T> = std::result::Result<T, AppError>;
```

### 4.3 `services/file_index.rs` core design

```rust
pub enum IndexMode { Manual, FilteredAuto, FullAuto }

pub struct FileIndexService {
    dirty_set: Arc<Mutex<HashSet<PathBuf>>>,
    mode: parking_lot::RwLock<IndexMode>,
    debouncer: Arc<Debouncer>,
    watcher: parking_lot::Mutex<Option<RecommendedWatcher>>,
    ignore_matcher: Gitignore,
    on_dirty_change: Box<dyn Fn(&Path) + Send + Sync>,
}

impl FileIndexService {
    /// write_file 调用后必须调
    pub async fn mark_dirty(&self, path: PathBuf);

    /// 用户按 Cmd+Shift+I 或命令面板 "> Rebuild Code Graph"
    pub async fn index_now(&self) -> Result<BuildStats, BuildError>;

    /// 启动时根据 config 决定是否 spawn notify
    pub fn start_watcher(&self, root: &Path) -> Result<(), NotifyError>;

    /// 路径过滤(扩展点:不直接 == 比 component,用 ignore crate)
    fn should_emit(&self, path: &Path) -> bool {
        if self.ignore_matcher.matched(path, path.is_dir()).is_ignore() {
            return false;
        }
        // 白名单扩展名
        matches!(path.extension().and_then(|e| e.to_str()),
            Some("py"|"ts"|"tsx"|"js"|"jsx"|"c"|"cc"|"cpp"|"h"|"hpp"
                 |"rs"|"go"|"java"|"sh"|"bash"))
    }

    /// 事件过滤:只关心 Create/Remove
    fn should_emit_event(event: &Event) -> bool {
        matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_))
        // Write 不入 dirty: write_file 自己入
    }
}
```

### 4.4 `services/debouncer.rs` cancelable debounce

```rust
pub struct Debouncer {
    cancel: tokio::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl Debouncer {
    pub async fn arm<F, Fut>(&self, delay: Duration, work: F)
    where F: FnOnce() -> Fut + Send + 'static,
          Fut: Future<Output = ()> + Send
    {
        // 取消上一轮
        if let Some(old) = self.cancel.lock().await.take() {
            let _ = old.send(());
        }
        let (tx, rx) = oneshot::channel();
        *self.cancel.lock().await = Some(tx);
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(delay) => work().await,
                _ = rx => { /* 被新一轮取代,无事可做 */ }
            }
        });
    }
}
```

Pressure test: `tests/stress/debouncer_mem.rs` arms 1000× within 500ms, asserts RSS delta < 2 MB.

### 4.5 `services/build_runner.rs` NDJSON streaming

```rust
pub fn run<F>(cli: CliInvocation, on_event: F) -> Result<BuildStats, BuildError>
// Caller-side constraint: the closure passed in must be `Fn(BuildEvent) + Send + 'static`
// because it is invoked from a sync reader thread and may be dropped into a
// `tauri::async_runtime::spawn_blocking` future. In practice callers wrap
// `window.emit("build://event", &evt)` directly, which is both Send and 'static.
where F: Fn(BuildEvent) + Send + 'static
{
    let mut child = Command::new("pnpm")
        .args(["--filter", "@latte-graph/cli", "start",
               &cli.cmd, "--format", "ndjson"])
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let raw: serde_json::Value = serde_json::from_str(&line?)?;
        on_event(map_cli_event(raw));
    }
    let status = child.wait()?;
    if !status.success() {
        let stderr = read_stderr(child.stderr.take().unwrap());
        return Err(BuildError::CliFailed { code: status.code().unwrap_or(-1), stderr });
    }
    // 最后一次 BuildEvent::Done
    Ok(/* last stats */)
}
```

`#[tauri::command] async fn build_graph(app: AppHandle, window: Window)` wraps it: spawn_blocking + `window.emit("build://event", &evt)`.

### 4.6 Path utilities

```rust
// utils/path.rs
pub fn safe_path(raw: &Path) -> Result<PathBuf, GraphError> {
    let cleaned = path_clean::clean(raw);
    let canon = dunce::canonicalize(&cleaned)
        .map_err(|_| GraphError::UnsafePath(raw.display().to_string()))?;
    if canon.starts_with("/etc") || canon.starts_with("/sys") {
        return Err(GraphError::UnsafePath(canon.display().to_string()));
    }
    Ok(canon)
}

// utils/ignore_match.rs
use ignore::gitignore::{GitignoreBuilder, Gitignore};
pub fn build_matcher(root: &Path, patterns: &[String]) -> Result<Gitignore, ...> {
    let mut b = GitignoreBuilder::new(root);
    for p in patterns { b.add_line(None, p)?; }
    Ok(b.build()?)
}
```

Case sensitivity: `AppState.case_insensitive: AtomicBool`, set at startup by probing `temp_dir/CASE_test` vs `case_test` existence. All path matching uses `eq_ignore_ascii_case` when true.

### 4.7 Extension points (no plugin runtime)

```rust
// language/mod.rs
pub trait LanguageAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn file_extensions(&self) -> &'static [&'static str];
    fn monaco_language_id(&self) -> &'static str;
}

// state.rs
pub struct AppState {
    pub languages: HashMap<&'static str, Box<dyn LanguageAdapter>>,
    pub vector_store: Arc<dyn VectorStore>,
    // ...
}

// embeddings/mod.rs
#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn insert(&self, id: &str, vec: &[f32]) -> Result<(), EmbedError>;
    async fn search(&self, vec: &[f32], k: usize) -> Result<Vec<(String, f32)>, EmbedError>;
    async fn delete(&self, id: &str) -> Result<(), EmbedError>;
}
```

v1 registers **9 adapters across 7 user-facing language categories**: `python` (py), `typescript` (ts/tsx), `javascript` (js/jsx), `c` (c/h), `cpp` (cc/cpp/h/hpp), `go` (go), `rust` (rs), `java` (java), `shell` (sh/bash). C and C++ are distinct adapters despite sharing a category header, because their monaco language IDs (`c` vs `cpp`) and tree-sitter grammars differ. Vector store: `SqliteVssStore` (always), `QdrantStore` (stub for v1.1).

---

## 5. Frontend (React) Module Layout

### 5.1 Package structure

```
packages/editor/
├── package.json             # react 18, monaco-editor, zustand, @tauri-apps/api, tauri-plugin-shell
├── vite.config.ts           # 复用 graph 项目的 vite preset + alias
├── tailwind.config.js       # latte-50/100/.../900 主题
├── tsconfig.json            # 继承 graph tsconfig.base.json (strict + ES2022)
├── playwright.config.ts     # viewport 1400x900, deviceScaleFactor 1
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── ipc/
│   │   ├── bindings.ts      # specta 生成
│   │   └── client.ts        # 包装 invoke() + listen(): invokeGraph() / listenBuild()
│   ├── stores/
│   │   ├── workspace.ts     # project root, open tabs, active tab
│   │   ├── graph.ts         # current symbol, focused graph, edge-type filters
│   │   ├── build.ts         # BuildEvent stream, status, history
│   │   ├── search.ts        # current query, kw/sem results, selected hit
│   │   ├── impact.ts        # impact cache + cursor pos trigger
│   │   └── ui.ts            # panel sizes, right-panel mode, drawer state
│   ├── shell/
│   │   ├── AppShell.tsx
│   │   ├── TitleBar.tsx
│   │   ├── StatusBar.tsx
│   │   └── PanelResizer.tsx
│   ├── panes/
│   │   ├── FileTree/        # FileTreePane / FileNode / ContextMenu
│   │   ├── Editor/          # EditorPane / TabBar / TabItem / MonacoMount / Breadcrumb / languages/
│   │   ├── RightPanel/      # RightPanel / OutlineView / GraphView / EdgeTypePills / graph-layout.worker.ts
│   │   └── BottomDrawer/    # Drawer / CallHierarchyTree / TreeNode
│   ├── overlays/
│   │   ├── CommandPalette/  # Palette / PaletteList / PalettePreview / commands.ts
│   │   ├── ExplosionRadiusOverlay.tsx
│   │   └── SearchPalette.tsx
│   ├── hooks/
│   │   ├── useGraphQuery.ts        # 包装 invokeGetCallers, 自动 invalidate by fileMtime
│   │   ├── useBuildStatus.ts       # 订阅 build://event
│   │   ├── useImpactOnCursor.ts    # debounce 300ms 触发 get_impact_radius
│   │   ├── useSemanticSearch.ts    # debounce 150ms + abort
│   │   ├── useKeybinding.ts        # 全局快捷键
│   │   ├── useTheme.ts
│   │   └── useResponsive.ts        # breakpoint, 长按, 触控目标
│   ├── components/                  # Button / Pill / Tooltip / ContextMenu (原子)
│   ├── utils/
│   │   ├── path.ts                  # safe_path 镜像
│   │   ├── highlight.ts             # 字符 + ContextSpan 合并高亮
│   │   ├── ipcCache.ts              # LRU over invoke()
│   │   └── rrf.ts                   # Reciprocal Rank Fusion
│   └── styles/
│       ├── globals.css
│       └── tokens.css
└── tests/
    ├── unit/                        # vitest
    ├── component/                   # @testing-library/react
    └── e2e/                         # playwright + tauri webdriver
```

### 5.2 Critical contracts

- **No component imports `@tauri-apps/api` directly** — only through `ipc/client.ts`. Specta-generated types make signature mismatches a compile error.
- **Stores do not import each other** — cross-store coordination in `hooks/`.
- **All interactive elements go through `components/Button`, `ContextMenu`, etc.** for keyboard accessibility and test hooks.
- **`MonacoMount` exposes a decoration API** to `ExplosionRadiusOverlay` (lines + hover tooltips).
- **All cross-IPC types** are in `ipc_types.rs` (Rust) ↔ `ipc/bindings.ts` (TS) — auto-synced.

### 5.3 State layering

- **Server state** (Zustand + `ipcCache` LRU): graph data, file contents, build status. Only `hooks/` and store setters call `invoke()`.
- **Client state** (Zustand): tabs, panel sizes, palette open, cursor pos.
- **Transient state** (`useState`): menu open/close, tooltip visibility.

### 5.4 Layout implementation

```
┌──────────────────────────────────────────────────────────────────────┐
│  TitleBar · · · · · · · · · · · · · · · · · · · · · · · · · ·  ◉    │
├────────────┬─────────────────────────────────────────┬───────────────┤
│            │  Tab1.ts  Tab2.py  Tab3.rs  +          │ ◀ Outline     │
│  FileTree  ├─────────────────────────────────────────┤ ───────────── │
│  · src/    │                                         │  [Graph view] │
│  · docs/   │           Monaco Editor                │               │
│  · index   │           (with ⚠ on lines)            │  call import  │
│            │                                         │  extend       │
│  ◉ dirty   │                                         │  (pills ▲)    │
├────────────┴─────────────────────────────────────────┴───────────────┤
│  ▼ Call Hierarchy                                       (drawer)     │
│  └ called by main (line 42)                                           │
│  └ calls → bar (line 2)                                               │
├──────────────────────────────────────────────────────────────────────┤
│  StatusBar: ● Indexing 1234/2900 · auth.py:14 · Ln 12, Col 8         │
└──────────────────────────────────────────────────────────────────────┘
```

Right panel is "immersive" — the only visible chrome is the top-left `◀ Outline` toggle and bottom-floating edge-type pills. Click `◀ Outline` swaps to `OutlineView` (file outline, sync scroll with editor). Bottom drawer auto-expands when `Cmd+\` (backslash, does not conflict with `Cmd+P` / `Cmd+Shift+P` / `Cmd+Shift+I`) is pressed or after `get_callers` returns; collapses on Escape. Default chord is configurable in `~/.latte-editor/config.toml` `[keybindings] call_hierarchy = "Cmd+\"`.

Responsive: viewport < 1024 px hides file tree by default with a hamburger in title bar; viewport < 600 px height makes palette a full-screen sheet to avoid virtual keyboard occlusion. Long-press (500ms pointer down) on file-tree node = context menu (substitutes mouse right-click on touch).

### 5.5 Graph panel rendering pipeline

```
┌──────────────────────────────────┐
│   Main thread (React)            │
│                                  │
│  useGraphQuery(id, depth)        │
│       │                          │
│       ▼                          │
│  invokes get_callers(id, depth)  │
│       │                          │
│       ▼                          │
│  receives {nodes, edges}         │
│       │                          │
│       ▼                          │
│  postMessage(worker,             │
│    {nodes, edges,                │
│     radius, edgeFilters})        │
│       │                          │
│       ▼                          │
│  worker returns {positions}      │
│       │                          │
│       ▼                          │
│  <svg> renders nodes + edges     │
│  (CSS transitions on focus)      │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│   graph-layout.worker.ts         │
│   (d3-force, runs off main)      │
│                                  │
│   - forceSimulation              │
│   - chargeStrength, linkDist     │
│   - alphaDecay 0.05              │
│   - emit positions when stable   │
└──────────────────────────────────┘
```

Force simulation: `d3-force` (pure JS, no DOM dependency, runs inside Web Worker without any shim) with `forceManyBody(-200)`, `forceLink(60)`, `forceCenter`. Worker posts positions when `simulation.alpha() < 0.01`. Main thread NEVER blocks on layout. Worker bundle is built via Vite's `?worker` import (`new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' })`).

### 5.6 Command palette commands (sample of registered 50+)

| Trigger | Command | Description |
|---|---|---|
| `> Open Graph` | Toggle right panel → Graph mode | Show focused graph |
| `> Open Outline` | Toggle right panel → Outline mode | Show file outline |
| `> Toggle Sidebar` | Show/hide file tree | |
| `> Toggle Drawer` | Show/hide call hierarchy drawer | |
| `> Rebuild Code Graph` | `index_now()` | Trigger manual index |
| `> Clean Graph DB` | `clean_graph()` | |
| `> Go to Definition` | `reveal_in_editor` | |
| `> Find References` | Open search palette, kind=references | |
| `> Show Impact Radius` | `get_impact_radius` on current symbol | |
| `> Open Settings` | Open config.toml in editor | |
| `> Reload Window` | Tauri `window.reload()` | |
| `> Toggle Theme` | light/dark/auto | |

### 5.7 Hooks in detail

```ts
// useGraphQuery.ts
export function useGraphQuery<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { fileMtime?: number }
): { data?: T; isLoading: boolean; error?: Error; stale?: GraphStaleness } {
  // 1. cache key = `${key}::${fileMtime ?? "na"}`
  // 2. LRU check; hit → return
  // 3. miss → call fn, store
  // 4. if response includes `stale: true`, expose for UI prompt
}

// useImpactOnCursor.ts
// "Cursor on function definition" detection:
//   We register a Monaco tokenization hook that marks any range whose
//   monaco-language token kind is Function/Method/Constructor with
//   a hidden marker. useImpactOnCursor reads monaco.editor.getModel()
//   .getValueInRange() around the cursor and asks the Rust backend
//   `get_node_by_position(file, line, col)` to confirm the enclosing
//   node is a function/class/method. Only then does the debounce arm.
//
//   Falling back to "any identifier" is allowed but produces ⚠ on
//   every variable reference, which is too noisy. v1 uses the strict
//   version.
export function useImpactOnCursor(nodeId: string | null, fileMtime: number) {
  useEffect(() => {
    if (!nodeId) return;
    const t = setTimeout(async () => {
      const r = await invoke<ImpactRadius>('get_impact_radius', { nodeId, depth: 1 });
      // call Monaco decoration API:
      // monaco.editor.getEditors()[0].createDecorationsCollection([{
      //   range: new monaco.Range(line,1,line,1),
      //   options: { glyphMarginClassName: 'impact-warning',
      //              glyphMarginHoverMessage: { value: formatImpactHover(r) } }
      // }])
    }, 300);
    return () => clearTimeout(t);
  }, [nodeId, fileMtime]);
}

// useBuildStatus.ts
export function useBuildStatus() {
  return useStore(buildStore, s => s.status);  // subscribes to build://event
}
```

### 5.8 Touch / responsive details

- `useLongPress(ref, 500)` → emits `onLongPress` (used by FileTree for context menu).
- All `Button` components enforce `min-h-[44px] min-w-[44px]` (Apple HIG).
- `useResponsive()` returns `{ width, height, isCompact, isMobile }`; `isCompact` swaps the right panel to bottom-sheet.
- `custom.css` and `custom.js` loaded on `document.idle` after main bundle; `custom.js` runs in isolated world with `unsafe-eval` CSP exception.

---

## 6. Integration with `@latte-graph/core`

### 6.1 Strategy

The Tauri Rust backend reads the `graph.db` SQLite file directly using `rusqlite`/`sqlx`, sharing the schema with `@latte-graph/core`. The CLI (`@latte-graph/cli`) is spawned as a one-shot process for build/update/clean operations.

This was chosen over alternatives:
- **Spawn Node child process for queries** (5-15ms IPC per call, ~150 MB RAM).
- **Full Rust rewrite of GraphClient** (duplicate maintenance, 2x engineering).

### 6.2 Schema synchronization

Three layers of protection against upstream schema drift:

1. **Build-time hash check** (`build.rs`): hashes `packages/core/src/persistence/schema.sql` (resolved via workspace path), writes hash to `CARGO_MANIFEST_DIR/.schema_hash`. Triggers `cargo:rerun-if-changed`. CI fails if hash mismatches expected.
2. **Compile-time SQL validation** (`sqlx::query!`): all SQL is wrapped in `sqlx::query!` macros. `cargo build` fails at compile time if SQL references non-existent columns/tables. CI runs `cargo sqlx prepare --check` to verify the offline cache.
3. **Runtime version check** (`schema_sync`): `metadata.schema_version` is read on startup. Mismatch triggers `build_runner::run("build", ["--full"])` and surfaces a `BuildEvent::SchemaMismatch` to the renderer.

### 6.3 Workspace setup (pnpm)

Root `pnpm-workspace.yaml` at `/Users/zhouguodong/Documents/latte/`:
```yaml
packages:
  - 'latte-code-editor/packages/*'
  - 'latte-code-review-graph/packages/*'
```

`latte-code-editor/packages/editor/package.json`:
```json
{
  "dependencies": {
    "@latte-graph/core": "workspace:*",
    "@latte-graph/cli": "workspace:*"
  }
}
```

Workspace edges flow upward: `editor` imports from `core` and `cli` only as build/dev tools, never as runtime deps in the Tauri production bundle (Tauri only ships its own Rust binary + the React bundle).

**Physical layout of `latte-code-editor/`** (the project root):
```
latte-code-editor/                     # this project
├── package.json                       # pnpm workspace root (also runs tauri)
├── pnpm-workspace.yaml                # points to packages/* (NOT crates/*)
├── tsconfig.base.json                 # extends graph project's tsconfig.base.json
├── crates/
│   └── latte-editor/                  # Rust backend (section 4) — standalone Cargo crate
├── packages/
│   └── editor/                        # React frontend (section 5)
├── samples/                           # Q1 bundled sample projects
│   ├── python-todo/
│   └── ts-express/
├── docs/superpowers/
│   ├── specs/   <-- this file
│   └── plans/                         # writing-plans output will land here
├── .latte-editor-config/              # gitignored user-specific state
└── tauri.conf.json                    # at the project root; references packages/editor
```

The Rust crate at `crates/latte-editor/` is **not** a pnpm workspace member (pnpm is for JS). It is a sibling Cargo crate. `latte-code-editor/package.json` provides `tauri:dev` / `tauri:build` scripts that wrap `cargo` invocations; Tauri 2 reads `tauri.conf.json` at the project root and uses `frontendDist: "../packages/editor/dist"`. Cargo `path = "../latte-code-review-graph/packages/core"` is used only in `build.rs` for hashing the upstream schema.

### 6.4 Sub-second read-only queries

The hot path (`get_callers`, `get_callees`, `get_node_by_position`, `search`) never crosses a process boundary. Latency on a warm SQLite cache: sub-millisecond for `get_node_by_position` with index, ~3-5 ms for `get_callers(depth=2)` on a 10k-edge subgraph.

---

## 7. File Indexing Strategy

### 7.1 Three modes

```toml
[performance]
index_mode = "manual"   # default. No notify watcher; saves accumulate in dirty_set.
                         # Cmd+Shift+I or "> Rebuild Code Graph" triggers index_now().

index_mode = "filtered_auto"
                         # notify watcher spawned; only Create/Remove events enter dirty_set.
                         # Writes are NOT auto-tracked (write_file itself does that).
                         # debounce 500ms or dirty_set >= 50 files triggers index_now().

index_mode = "full_auto"
                         # Debug only. All FS events enter dirty_set. Not recommended.
```

### 7.2 Path filtering (extension point, not hardcoded)

```rust
// utils/ignore_match.rs
pub fn build_matcher(root: &Path, patterns: &[String]) -> Result<Gitignore, Error> {
    let mut b = GitignoreBuilder::new(root);
    for p in patterns { b.add_line(None, p)?; }
    Ok(b.build()?)
}

// file_index.rs::should_emit
fn should_emit(&self, path: &Path) -> bool {
    if self.ignore_matcher.matched(path, path.is_dir()).is_ignore() { return false; }
    matches!(path.extension().and_then(|e| e.to_str()),
        Some("py"|"ts"|"tsx"|"js"|"jsx"|"c"|"cc"|"cpp"|"h"|"hpp"
             |"rs"|"go"|"java"|"sh"|"bash"))
}
```

Default ignore patterns: `.git`, `node_modules`, `dist`, `build`, `target`, `__pycache__`, `.venv`, `.omc`, `.superpowers`, `vendor`, `.next`. Configurable in `config.toml` `ignore_patterns` array.

### 7.3 Dirty set + on-demand invalidation

- `dirty_set: Arc<Mutex<HashSet<PathBuf>>>` — single source of truth.
- Populated by: `write_file` (always), `notify` events (mode-dependent), `open_project` reset.
- `index_now()` drains the set, runs `update_graph --paths <drained>`, on `BuildEvent::Done` clears the set.
- `get_impact_radius` cache is keyed on `(nodeId, fileMtime)`; `BuildEvent::Done` invalidates by current mtime.

### 7.4 Stale detection

`getCallers` and friends attach a `GraphStaleness` to the response if `dirty_set` is non-empty and `now - graph_built_at > stale_threshold_seconds` (default 60s). The renderer surfaces a non-blocking toast: "图谱有 N 个未索引变更  [立即更新]  [稍后]".

### 7.5 Debouncer

`Debouncer` struct (Section 4.4) wraps `tokio::select!` over `sleep` and `oneshot::Receiver`. Used by `file_index` for both the 500ms debounce and the 50-file batch threshold (whichever fires first).

Pressure test in `tests/stress/debouncer_mem.rs`: 1000 rapid `arm(500ms, noop)` calls assert RSS delta < 2 MB.

---

## 8. Semantic Search

### 8.1 Embedding model

Default: `bge-small-zh-v1.5` (512-dim, supports zh-CN + en, ~80 MB on disk after first download). Stored in `~/.latte-editor/models/`. Alternative: `all-MiniLM-L6-v2` (384-dim, English-only, smaller).

```toml
[embeddings]
model = "bge-small-zh-v1.5"
dimension = 512
device = "cpu"   # "cpu" | "cuda" | "coreML"
```

Model dimensions are persisted in the `embeddings` table; on first start after a model change, embeddings are rebuilt (background task with progress).

### 8.2 Indexing strategy

For each node (function / class / method), generate one or more embeddings:
- **Docstring embedding** (if present)
- **Signature embedding** (always)
- **Top-K body chunks** by length-weighted sampling (K up to 3)

`embeddings` schema:
```sql
CREATE VIRTUAL TABLE embeddings USING vss0(
  embedding FLOAT[512] distance_metric=cosine
);
CREATE TABLE embedding_meta(
  id TEXT PRIMARY KEY,           -- nodeId
  chunk_kind TEXT,                -- 'docstring' | 'signature' | 'body:N'
  start_line INT,
  end_line INT,
  text TEXT,                      -- for preview highlight
  model_id TEXT,
  indexed_at INT
);
```

### 8.3 Search protocol

```rust
pub struct SemanticHit {
    pub node: NodeRef,
    pub score: f32,                  // 1.0 - cosine distance
    pub context: Vec<ContextSpan>,   // top-K most-similar chunks (with line + text)
}

#[tauri::command]
async fn semantic_search(query: String, k: usize) -> Result<Vec<SemanticHit>, AppError>
```

`ContextSpan` lets the renderer highlight "why this hit matched" in the preview pane.

### 8.4 Hybrid ranking (keyword + semantic)

Reciprocal Rank Fusion (RRF, k=60):
```
score(item) = Σ 1 / (k + rank_in_list)
```
over both keyword and semantic lists. Outputs merged by descending RRF score, ties broken by recency.

### 8.5 Boundary / "hallucination" tests

- Empty query → empty result.
- Unrelated text ("今天天气真好") against pure code corpus → all scores < 0.3.
- NaN / Inf injection → never sorts NaN to top.
- zh-CN fixture: mixed Chinese / English variable names; "处理用户登录的函数" must match `获取用户信息()` (semantic) and `getUserInfo` (keyword).

### 8.6 Failure mode

If `fastembed` model load fails (no network on first run), `EmbedError::NotReady` is surfaced. UI degrades: palette shows only keyword results with a "语义模型未就绪" badge. Once loaded (background), UI re-enables semantic toggle without restart.

---

## 9. Configuration

### 9.1 Full `~/.latte-editor/config.toml` schema

```toml
[general]
project_root_override = ""        # "" = require selection on launch
log_level = "info"                # trace|debug|info|warn|error

[ui]
theme = "auto"                    # "auto" | "light" | "dark"
font_size = 14
font_family = "JetBrains Mono"
custom_css = ""                   # path or URL
custom_js = ""

[graph]
backend = "auto"                  # "auto" | "codegraph" | "codebase-memory-mcp"
graph_db_path = ""                # default: <project>/.latte-code-review-graph/graph.db

[performance]
index_mode = "manual"
ignore_patterns = [".git","node_modules","dist","build","target","__pycache__",".venv",".omc",".superpowers"]
stale_threshold_seconds = 60
debounce_ms = 500
batch_size = 50

[embeddings]
model = "bge-small-zh-v1.5"
dimension = 512
device = "cpu"

[vector_store]
backend = "sqlite-vss"            # "sqlite-vss" | "qdrant"
qdrant_url = ""

[search]
max_results = 50
semantic_default_on = false

[upstream]
notify_on_schema_drift = true
rebuild_on_drift = false          # true: auto --full rebuild on mismatch
```

### 9.2 Validation

`config.rs` deserializes via `serde` with defaults. Validation on load:
- `debounce_ms` ∈ [100, 5000]
- `batch_size` ∈ [1, 500]
- `dimension` matches selected model
- `backend` value is in known set

Invalid config → fallback to defaults + log warning (do not crash).

### 9.3 Live reload

`config.toml` is watched via `notify`; changes emit `config://changed` event to renderer. Renderer hot-applies non-destructive fields (theme, font size) and prompts user for destructive ones (model change, backend change).

---

## 10. Error Handling

### 10.1 Layering

- **Library crates** (`services/`, `db/`, `embeddings/`): `thiserror` enums with explicit variants.
- **Commands** (`commands/`): `anyhow` for ergonomic `?` propagation; converts to `AppError` at IPC boundary.
- **Renderer**: receives `{ kind: string, message: string }`; maps `kind` → user-facing message + recovery action.

### 10.2 `AppError` (the IPC boundary type)

```rust
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum AppError {
    #[error("graph node {0} not found")]              NodeNotFound(String),
    #[error("file {0} not indexed")]                  FileNotIndexed(PathBuf),
    #[error("schema version mismatch: expected {expected}, got {actual}")]
    SchemaMismatch { expected: i32, actual: i32 },
    #[error("graph build failed (exit {code})")]      BuildFailed { code: i32, stderr: String },
    #[error("embedding model not ready")]             EmbedNotReady,
    #[error("embedding dim mismatch")]                EmbedDimMismatch { model: u32, db: u32 },
    #[error("unsafe path: {0}")]                      UnsafePath(String),
    #[error("io: {0}")]                               Io(String),
    #[error("internal: {0}")]                         Internal(String),
}
```

### 10.3 User-facing recovery table

| Error kind | Renderer message | Recovery action |
|---|---|---|
| `NodeNotFound` | "未找到符号 `{id}`,可能图谱未更新" | Button: "立即重建" → `index_now()` |
| `FileNotIndexed` | "`{p}` 未建立索引(在 ignore 列表?)" | Button: "加入白名单" |
| `SchemaMismatch` | "图谱 schema 与编辑器不匹配" | Auto-trigger full rebuild; show progress |
| `BuildFailed` | "图谱构建失败 (exit {code})" | Open Output panel with stderr |
| `EmbedNotReady` | "语义模型正在加载" | Disable semantic toggle until ready |
| `EmbedDimMismatch` | "模型 dimension 与数据库不匹配" | Button: "清空 embeddings 重建" |
| `UnsafePath` | "拒绝访问该路径" | Log only, no recovery |
| `Io` | system default | Output panel |
| `Internal` | "内部错误,已记录" | Open log file location |

### 10.4 Logging

`tracing` crate; `log_level` from config controls verbosity. Logs written to `~/.latte-editor/logs/{date}.log` AND emitted to `tauri://log` event for DevTools console. PII redaction: file paths are absolute but never include environment variable values.

---

## 11. Performance Budgets

| Operation | Target P95 | Measurement |
|---|---|---|
| Cold start → first interactive paint | < 1.5s | Tauri `tauri://ready` to React `useEffect` done |
| `get_callers(depth=2)` | < 5ms | sqlx timing |
| `get_node_by_position` | < 3ms | sqlx timing |
| `search` (ripgrep, 1k files) | < 100ms | `time` wrapping spawn |
| `semantic_search` (model loaded) | < 50ms | fastembed + sqlite-vss |
| Graph layout (200 nodes) | < 50ms | worker `performance.now()` |
| Full build (2900 TS files) | < 5s | wall clock |
| Incremental update | < 2s | wall clock (matches upstream benchmark) |
| Debouncer stress (1000× arm) | RSS delta < 2 MB | `tests/stress/debouncer_mem.rs` |
| Main thread long task (graph render) | < 50ms | Chrome DevTools / Lighthouse |

CI runs `tests/perf/` nightly. Threshold breach = fail.

---

## 12. Testing Strategy

### 12.1 Pyramid

```
        ┌──────────┐
        │  E2E 5%  │  Playwright + Tauri webdriver: 3-5 happy paths
        ├──────────┤
        │ 集成 25%  │  Rust: tempfile + real graph.db fixture
        │          │  React: @testing-library/react + stores
        ├──────────┤
        │ 单元 70%  │  vitest / cargo test: function-level
        │ Property │  proptest / fast-check for fuzzy cases
        └──────────┘
```

### 12.2 Rust unit + property tests

| Module | Cases |
|---|---|
| `graph_query::get_callers` | proptest: random graph (disconnected, cyclic, long ids) → no panic, no infinite loop; depth=2 result count bounded by 1000 |
| `path::safe_path` | proptest: any string → either `Err(UnsafePath)` or canonical; never returns path with `..` |
| `should_emit` | proptest: any path + Gitignore → deterministic |
| `file_index::debouncer` | 1k rapid arm → RSS delta < 2 MB |
| `build_runner` | mock pnpm script emits NDJSON → `BuildEvent` mapping correct; kill → `Cancelled` |
| `schema_sync` | 3 metadata versions → expected action each |
| `db/prepared` | sqlx compile-time check + `cargo sqlx prepare --check` in CI |
| `db/impact_cache` | LRU capacity, hit, eviction; mtime change → invalidation |
| `error` | every variant has `Display` coverage; `From` impls compile |
| `semantic_search` | empty query → empty; unrelated text below 0.3 threshold; NaN handling |
| `embeddings/span` | function chunking boundary correctness |

### 12.3 React unit + component tests

| Module | Cases |
|---|---|
| `stores/*.ts` | reducers: tab open/close/active/dirty; Zustand selectors |
| `panes/Editor/MonacoMount` | mock `@monaco-editor/react`, assert `Ctrl+click` triggers one `invoke('get_node_by_position', ...)` |
| `panes/RightPanel/GraphView` | postMessage to worker; SVG node count matches fixture |
| `panes/BottomDrawer/CallHierarchyTree` | mock `get_callers` → tree render + click callback |
| `overlays/CommandPalette/Palette` | debounce 150ms; ↑↓ selection; Enter dispatch; `ContextSpan` highlight |
| `overlays/ExplosionRadiusOverlay` | cursor enters function → debounce 300ms → invoke; exits → no call; mtime change → cache invalidation |
| `hooks/useBuildStatus` | mock `listen("build://event")` 5 events → progress + done state |
| `hooks/useSemanticSearch` | debounce; abort previous; error fallback |
| `utils/highlight` | keyword + ContextSpan merge; empty query; Unicode preservation |
| `utils/rrf` | Reciprocal Rank Fusion correctness |
| `utils/ipcCache` | LRU eviction; fileMtime key → miss on change |
| `hooks/useResponsive` | breakpoint, long-press, hit target |

### 12.4 E2E (Playwright + Tauri webdriver)

3-5 happy paths only:
1. **Open fixture project** → file tree → open `main.py` → screenshot.
2. **Ctrl+click jump** → new tab opens target file → cursor at line → highlight.
3. **Cmd+Shift+I** → status bar shows "Indexing..." → on Done, dirty dot disappears.
4. **Cmd+P search "auth"** → list hits → Enter opens first.
5. **Right-click rename in FileTree** → file tree updates → dirty dot appears.

### 12.5 Visual regression

```ts
// playwright.config.ts
export default {
  use: {
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,    // 强制 1x,无视宿主 DPR(避免 Retina 与 CI 不一致)
    reducedMotion: 'reduce',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001 } },
}
```

CI Linux runner (DPR=1) snapshots. Local developers produce `__screenshots__/-darwin@2x/` for their own device. Diff tooling (Chromatic or simple image-diff script) compares.

### 12.6 Fixtures

`tests/fixtures/`:
- `py-only/` (3-5 files, intentional call/import relations)
- `ts-only/`
- `c-only/`
- `zh-cn/` (mixed CJK + English variable names)
- `edge-cases/` (`file with spaces.ts`, `emoji 🚀.py`, null byte `\0.py`)
- `large-perf/` (2900 files, nightly only)

### 12.7 What we explicitly do NOT test

- Monaco internals (trust Microsoft).
- `notify` cross-platform quirks (only macOS + Linux; Windows best-effort).
- Real `fastembed` model download (mock embedder in unit tests; CI pre-caches the model on Linux runner).
- 3rd-party Tauri plugins (use their own test suites).

---

## 13. Out of Scope (v1)

- Git integration (diff, blame, stage, commit UI)
- Debugger / run configurations
- Full LSP server coverage
- WASM build (Tauri web is beta in 2026)
- Multi-project in one window
- Multi-user collaboration / real-time sync
- Plugin marketplace (extension points are wired, no loader)
- Linux ARM64 or Windows ARM64 (best effort)
- iOS / Android native (Tauri mobile is alpha; v1 desktop only)
- Themes beyond `auto / light / dark` (custom CSS only)

---

## 14. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Upstream `latte-code-review-graph` schema drift | Medium | High | `build.rs` hash check + `sqlx` compile-time validation + CI block |
| `fastembed` first-run download fails (no network) | Medium | Medium | Detect at startup, fall back to keyword-only, surface "语义未就绪" badge |
| Monaco bundle size bloat | Low | Medium | Lazy-load language workers by extension |
| `notify` Windows behavior divergence | Medium | Medium | Manual mode is default + fully tested; auto mode labeled "experimental" on Windows |
| `sqlite-vss` slow beyond 1M vectors | Low | Medium | `VectorStore` trait already allows Qdrant swap (deferred to v1.1) |
| Unicode / CJK path edge cases on some OS | Low | High | `path-clean` + `dunce` canonicalize + `proptest` coverage |
| Chinese-only embedding model weak on English code | Low | Medium | Default `bge-small-zh-v1.5` (bilingual); `all-MiniLM-L6-v2` available as config alt |
| Tauri 2 webview inconsistencies (macOS WKWebView vs Windows WebView2) | Medium | Medium | Layout uses standard CSS only; visual regression catches divergence |
| IPC contract drift between Rust and TS | Low | High | `specta` generates TS types from Rust; CI fails on mismatch |

---

## 15. Upstream Changes Required (in `latte-code-review-graph`)

### 15.1 P0 — blockers for v1 launch

1. **`@latte-graph/cli` NDJSON output mode**:
   - `packages/cli/src/commands/build.ts` and `update.ts` add `--format ndjson` flag.
   - On this flag, emit one JSON object per line: `{type: "FileProcessed", path, processed, total}` and `{type: "Progress", phase, current, total}` etc.
   - Color/chalk output suppressed in `ndjson` mode.
   - Reasonable exit codes: 0 on success, 1 on partial failure, 2 on schema validation error.

2. **`@latte-graph/cli` `update --paths` flag**:
   - Accepts repeated `--paths <relpath>` args (or a single `--paths-file <list>`).
   - Restricts incremental update to the given paths; falls back to full rebuild if dependency graph invalidates.

3. **`@latte-graph/cli` clean command integration** (already implemented in current `cc-dev` branch; just needs review and merge to main).

### 15.2 P1 — recommended for v1.1

1. **`@latte-graph/core` `getNodeByPosition(file, line, col)`** method: today only `getNodesInFile` exists; reducing SQL duplication on Rust side.
2. **`@latte-graph/core` `EmbeddingSearch` interface fully implemented** in non-semble backends: enables `backend=auto` to imply semantic search always-on.
3. **`@latte-graph/core` GraphClient singleton + IPC-friendly handle**: helps if we later add a Node sidecar fallback.

### 15.3 P2 — exploratory

1. **`@latte-graph/core` Cypher query builder for `codebase-memory-mcp` backend**: enables a "visual query" feature.
2. **`@latte-graph/core` time-travel graph (git base selection in query)**: enables "what would the graph look like at commit X" view.

---

## 16. Decisions Resolved During Brainstorming

| # | Topic | Decision |
|---|---|---|
| Q1 | First-launch experience | **Yes — bundle a `samples/python-todo` and `samples/ts-express` fixture and surface an "Open Sample" tile in the empty-state FileTree.** Tauri bundles fixtures via `tauri.conf.json` `bundle.resources`. Empty state shows three tiles: "Open Folder", "Open Sample (Python TODO)", "Open Sample (TS Express)". Selecting a sample copies it to a temp dir, runs `latte-graph build` once, and opens it. |
| Q2 | Multi-window | **Single process, multiple Tauri BrowserWindows allowed.** `Cmd+N` opens a new window with a fresh project picker; the same project can be opened in two windows but edits are file-mediated (no live sync). Tauri `WebviewWindowBuilder` is the primitive. |
| Q3 | Crash recovery | **Yes — default on.** `editor_meta` table stores `last_project_path` and `last_open_tabs` (JSON array). On startup, if both are present and the path still exists, restore tabs (best-effort: skip files that no longer exist). Persisted on `Cmd+S` debounced 2s, and on `before-quit` event. |
| Q4 | `semble` sidecar | **Deferred to v1.1.** `fastembed-rs` is the only v1 semantic backend. The `VectorStore` trait is the seam. |
| Q5 | Auto-update | **Deferred to v1.1.** v1 ships as manual download from GitHub Releases. `tauri-plugin-updater` is wired in `Cargo.toml` but the `updater.json` endpoint is not configured. |

---

## 17. References

- `latte-code-review-graph/packages/core/src/persistence/schema.sql` — DB schema source of truth.
- `latte-code-review-graph/packages/core/src/interface.ts` — `GraphProvider` contract.
- `latte-code-review-graph/packages/cli/src/commands/{build,search,update,stats,backends,ui,clean}.ts` — CLI surface.
- `latte-code-review-graph/packages/desktop/src-tauri/` — reference Tauri config (window, productName, Cargo deps).
- Tauri 2 docs: <https://tauri.app/v2/>
- Monaco API: <https://microsoft.github.io/monaco-editor/typedoc/index.html>
- `fastembed-rs`: <https://docs.rs/fastembed/>
- `sqlite-vss`: <https://github.com/asg017/sqlite-vss>
- `notify`: <https://docs.rs/notify/>
- `ignore` (ripignore): <https://docs.rs/ignore/>
- `proptest`: <https://proptest-rs.github.io/proptest/>
- `fast-check`: <https://fast-check.dev/>

---

**End of spec.** Next: self-review (placeholders / consistency / scope / ambiguity), then user review, then transition to `writing-plans` skill for implementation plan.
