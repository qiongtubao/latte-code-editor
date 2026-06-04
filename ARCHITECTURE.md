# Latte Code Editor — 架构设计文档

> 基于 Tauri 2.0 的跨平台轻量编辑器，集成代码图谱 + 文档图谱 + AI 调试。
> 核心目标：在保留完整编辑能力的前提下，将内存基线从 Electron 的 300-500MB 降至 100-150MB。
>
> **关键认知**：LSP 服务器（rust-analyzer / tsserver 等）是独立的外部进程，每个吃掉 100-200MB。本设计不做假预算——LSP 计入总内存。2026 年的策略不是"杀掉 LSP"，而是"压缩 LSP 到休眠态"（Swap not Kill）。

---

## 一、设计目标

### 1.1 核心指标

| 指标 | 轻量模式 | 完整 LSP 模式 | VSCode 对比 |
|------|---------|-------------|-------------|
| 空闲内存 | ≤60MB（无 LSP 进程） | ≤150MB（含 1 个休眠态 LSP） | ~350MB |
| 启动时间 | ≤0.5s | ≤1s（界面先出现，LSP 后台启动） | ~3-5s |
| LSP 唤醒延迟 | N/A | **毫秒级**（休眠态进程，不清杀） | 正常 LSP 延迟 |
| 编辑器能力 | 语法高亮 + Tree-sitter 补全 | 完整 LSP：补全/诊断/悬停/重构 | 对标 |
| 图谱能力 | 代码图 + 文档图 + 语义搜索 | 同左 | N/A |
| AI 能力 | 补全 + Chat + MCP + **Doc RAG** | 同左 | GitHub Copilot |
| 跨平台 | Linux / macOS / Windows | 同左 | 同左 |

### 1.2 省内存的三个杠杆

1. **系统 WebView 替代 Embedded Chromium** — 省约 300MB
2. **CodeMirror 6 替代 Monaco Editor** — 省约 40MB 堆内存
3. **Rust 后端做重型计算** — 替代 Node.js 进程，省约 60-100MB

### 1.3 2026 年基线调整

WebView 本身在 2026 年也变重了（Safari/WebView2 的功能膨胀），基础预算从 30-50MB 调整为 **40-70MB**。但相对 Electron 的 300-500MB 仍是巨大的胜利。

---

## 二、总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri 2.0 Shell                          │
│                                                             │
│  ┌──────────────────────┐   ┌────────────────────────────┐  │
│  │    WebView 前端       │   │     Rust 后端              │  │
│  │   (系统 WebView)      │   │                            │  │
│  │                       │   │  ┌──────────────────────┐  │  │
│  │  ┌─────────────────┐  │   │  │  Editor Engine       │  │  │
│  │  │ CodeMirror 6    │──┼───┼─▶│  • Buffer管理        │  │  │
│  │  │ (编辑器核心)     │  │   │  │  • LSP Client        │  │  │
│  │  └─────────────────┘  │   │  │  • 休眠/唤醒管理      │  │  │
│  │                       │   │  └──────────────────────┘  │  │
│  │  ┌─────────────────┐  │   │                             │  │
│  │  │ GraphCanvas     │  │   │  ┌──────────────────────┐  │  │
│  │  │ (WebGPU 渲染)   │──┼───┼─▶│  Graph Engine         │  │  │
│  │  │ Web Worker 力   │  │   │  │  • CodeGraph 查询     │  │  │
│  │  │ 布局计算        │  │   │  │  • DocGraph 查询      │  │  │
│  │  └─────────────────┘  │   │  │  • 语义搜索 RPC       │  │  │
│  │                       │   │  └──────────────────────┘  │  │
│  │  ┌─────────────────┐  │   │                             │  │
│  │  │ AI Chat /        │  │   │  ┌──────────────────────┐  │  │
│  │  │ 补全界面        │──┼───┼─▶│  AI Engine             │  │  │
│  │  └─────────────────┘  │   │  │  • LLM 推理            │  │  │
│  │                       │   │  │  • MCP Server          │  │  │
│  │  ┌─────────────────┐  │   │  │  • Doc RAG (先查文档)  │  │  │
│  │  │ Sidebar/Search  │  │   │  └──────────────────────┘  │  │
│  │  │ 状态栏          │──┼───┼─▶                           │  │
│  │  └─────────────────┘  │   │  ┌──────────────────────┐  │  │
│  │                       │   │  │  Graph Build         │  │  │
│  │  ┌─────────────────┐  │   │  │  (后台异步:           │  │  │
│  │  │ Native 大文件    │──┤   │  │  tree-sitter 解析    │  │  │
│  │  │ 模式 (<pre>)    │  │   │  │  → 图入库)           │  │  │
│  │  └─────────────────┘  │   │  └──────────────────────┘  │  │
│  └──────────────────────┘   └──────────┬─────────────────┘  │
│                                         │                    │
└─────────────────────────────────────────┼────────────────────┘
                                          │
          ┌────────────────────────────────┼────────────────────┐
          ▼                                ▼                    ▼
   ┌──────────────┐                ┌────────────────┐    ┌──────────────┐
   │ LSP Server   │                │ 存储层          │    │ Python       │
   │ (外部进程)    │                │                │    │ Sidecar      │
   │              │                │ SQLite (WAL)   │    │ (semble)     │
   │ 休眠态:      │                │ + DuckDB (分析)│    │ 语义搜索     │
   │ 30-50MB      │                │ + JSON (状态)  │    │              │
   │ 活跃态:      │                │ .codegraph/    │    │ 向量持久化   │
   │ 80-150MB     │                │ .docgraph/     │    │              │
   └──────────────┘                └────────────────┘    └──────────────┘
```

---

## 三、分层详解

### 3.1 前端层 (WebView)

**技术选型：**

| 模块 | 选型 | 理由 | 风险/备注 |
|------|------|------|-----------|
| 编辑器 | CodeMirror 6 | 200KB gzip，模块化，inline suggestion 生态成熟 | 插件需自研 |
| 图谱渲染 | **WebGPU** → WebGL2 → Canvas 2D 降级链 | GPU 粒子系统渲染 >10000 节点，见 §3.1.1 | Safari 17+ / Chrome 130+ / WebView2 均支持 |
| 力布局 | d3-force (Web Worker) | 算法复用，Worker 隔离不阻塞 UI | D3 仅用于算法，不碰 DOM |
| 大文件 | **原生 `<pre>` 模式** | 50MB+/10万行+ 文件零开销渲染 | 见 §3.1.2 |
| 状态管理 | Zustand | ~2KB，极简 API | |
| 构建 | Vite | HMR 快，打包小 | |
| 样式 | Tailwind CSS | 按需生成，无冗余 CSS | |
| IPC | Tauri Command + Event | 类型安全，双向通信 | |

#### 3.1.1 图谱渲染：WebGPU + GPU Particles

2026 年 WebGPU 已在 Safari 17+、Chrome 130+、WebView2 全面稳定。图谱渲染直接从 Canvas 2D 升级到 **WebGPU 计算管线 + GPU Particles**。

**架构：**

```
[Web Worker]                     [Main Thread]                    [GPU]
d3-force 布局计算                 │
  │                               │
  │  每帧: 节点位置/速度          │
  │  postMessage(pos, vel) ──────▶│
  │                               ├── upload to GPU storage buffer
  │                               │    (position + velocity as vec4)
  │                               │
  │                               │  WebGPU Render Pass
  │                               │    ├── Vertex Shader: 节点 (Instanced)
  │                               │    ├── Fragment Shader: 节点颜色/大小
  │                               │    ├── Line Shader: 边 (线条)
  │                               │    └── Compute Shader: 碰撞检测/弹簧力
  │                               │
  │                               │  鼠标交互 → IPC 查询代码
```

**为什么 WebGPU 赢 Canvas 2D：**

| 对比 | Canvas 2D | WebGPU |
|------|----------|--------|
| 500 节点 | 60fps 稳定 | 120fps+ |
| 2000 节点 | ~30fps（CPU 光栅化瓶颈） | 60fps（GPU 原生管线） |
| 10000 节点 | ~5fps（卡顿） | ~30fps（流畅交互） |
| 节点渲染 | CPU 逐帧绘制 | GPU Instanced，一次提交 |
| 边渲染 | CPU 逐条路径 | GPU Line Strip Batch |
| 物理计算 | CPU (Worker) | CPU + GPU Compute Shader 混用 |
| 动画 | RAF + Canvas clear + redraw | GPU Particle，零 clear 开销 |

**降级链：**

```
WebGPU ──不可用──▶ WebGL2 ──不可用──▶ Canvas 2D
  │                   │                  │
  │ Safari 17+        │ Safari 15+       │ 所有浏览器
  │ Chrome 130+       │ Chrome 60+       │
  │ WebView2 Win      │ WebView2 Win     │
  │ WKWebView macOS   │                  │
```

前端 3 行代码检测支持度，选择最高级渲染后端。降级到 Canvas 2D 时，自动限制可见节点数 ≤ 500。

**附加能力：**
- 力计算在 Web Worker 中跑 `d3-force`，Worker 间的 `postMessage` 只传 `Float32Array`（零 GC 压力）
- 5000+ 节点自动启用 Cluster View：GPU 做社区色块渲染，展开单个社区时才渲染节点级细节
- 节点选中/悬停效果走 GPU Compute Shader，CPU 不参与高亮计算

#### 3.1.2 编辑器核心：CM6 + 大文件原生降级

**CM6 vs Monaco 取舍表：**

| 对比维度 | CodeMirror 6 | Monaco Editor |
|----------|-------------|---------------|
| 打包大小 | ~200KB gzip | ~2MB+ gzip |
| JS 堆占用 | ~5MB | ~40MB |
| 大文件 (10万行) | DOM 渲染 + 虚拟滚动 | Canvas 层，原生支持 |
| 语言生态 | lezer + @codemirror/lang-* | 最全 |
| Inline Suggestion | 有标准接口 | 有标准接口 |
| 图谱跳转插件 | 需自研 | — |

**大文件策略（2026 版）：**

关键认识：用户希望在编辑器里**查看**大文件（日志、编译产物、包管理器生成的超大文件），不一定需要编辑。为此使用 **三级降级**，而不是引入 Monaco（Monaco 的 2MB+ JS 会炸掉内存预算）：

```
文件大小                   渲染模式                  内存开销
─────────                 ────────                  ──────
< 5000 行                 CM6 完整: 语法高亮+LSP    ~10MB
5000 - 10万行             CM6 精简: 仅语法高亮       ~5MB
> 10万行 或 > 50MB        原生 <pre> 模式             ~1-2MB
                            └── IndexedDB 缓存行号映射
                            └── 虚拟滚动窗口 (100行可见)
                            └── 无高亮，无 LSP，无补全
```

**原生 `<pre>` 模式细节：**
- 用 `<pre>` 元素直接渲染，零语法解析
- IndexedDB 缓存行号 → byte offset 映射（用于跳转到指定行）
- 虚拟滚动：DOM 中只渲染当前可见的 ~100 行
- 进入此模式时 UI 提示："大文件模式：仅查看，如需编辑请拆分文件"
- 打开 500MB 日志文件 < 100ms，内存增加 < 2MB

不启用 Monaco 切换。Monaco 的 2MB+ gzip 和 ~40MB 堆内存增量与整个编辑器设计哲学冲突。CM6 + 原生 `<pre>` 覆盖了 99% 的场景。

#### 3.1.3 语法高亮：前端 Tree-sitter (WASM) 方案

```
[前端 CM6]
  │
  ├── 语法高亮：@codemirror/lang-typescript (内置 WASM lezer parser)
  │   → 零 IPC，零 Rust 参与，最快路径
  │
  └── (Rust 端 tree-sitter 仅用于：代码图构建、结构分析、图谱索引)
      → 后台异步，不需要实时性
```

**核心原则：语法高亮不走 IPC，不走 Rust。** 前端用 CM6 自带的 lezer parser（WASM）直接渲染，这是唯一正确的路径。Rust 端的 tree-sitter 只负责**代码图构建**（提取函数/类/调用关系 → 写 SQLite），是后台任务，不阻塞 UI。

---

### 3.2 后端层 (Rust)

**Cargo 核心依赖：**

| Crate | 用途 | 备注 |
|-------|------|------|
| `tauri` 2.0 | 应用骨架、IPC、窗口管理 | |
| `tower-lsp` / `lsp-types` | LSP 客户端协议 | 管理外部 LSP 进程 |
| `rusqlite` | SQLite 绑定 | WAL 模式 |
| `duckdb` / `duckdb-rs` | 分析型查询引擎 | 聚合/社区分析查询 |
| `tree-sitter` | 语法解析（仅用于图构建） | 非实时，后台线程 |
| `llama-cpp-rs` / `candle` | 本地 LLM 推理 | 可选，按需加载 |
| `notify` | 文件系统监听 | 增量图更新 |
| `serde` / `serde_json` | 序列化 | |
| `tokio` | 异步运行时 | |

**模块划分：**

```rust
// src-tauri/src/
├── main.rs              // Tauri 入口，注册 command
├── editor/
│   ├── mod.rs
│   ├── buffer.rs        // 文本缓冲区 (内存映射文件)
│   ├── language.rs      // 语言注册表，LSP 休眠/唤醒策略
│   └── lsp.rs           // LSP 客户端 (§4.2 休眠管理)
├── graph/
│   ├── mod.rs
│   ├── codegraph.rs     // 代码图: tree-sitter AST → SQLite (后台线程)
│   ├── docgraph.rs      // 文档图: markdown 解析 → wiki links
│   ├── search.rs        // 语义搜索: prox 到 semble sidecar
│   └── query.rs         // DuckDB 聚合查询 (社区分析、影响半径)
├── ai/
│   ├── mod.rs
│   ├── llm.rs           // llama.cpp / 云端 API 统一接口
│   ├── mcp.rs           // MCP 协议 server (fastmcp)
│   ├── completion.rs    // 补全引擎
│   └── rag.rs           // Doc RAG: 先查文档图再调 LLM
└── project/
    ├── mod.rs
    └── watcher.rs       // 文件变更监听 → 增量图更新
```

**IPC Command 接口（新增 `lsp_hibernate` / `lsp_wake` 命令）：**

```rust
// === LSP 休眠管理 ===
#[tauri::command]
async fn lsp_hibernate(language: String) -> Result<()>;     // 请求 LSP 压缩缓存
#[tauri::command]
async fn lsp_wake(language: String) -> Result<()>;          // 唤醒休眠 LSP
#[tauri::command]
async fn lsp_status() -> Result<Vec<LspStatus>>;            // 各 LSP 状态/内存

// === 编辑器 ===
#[tauri::command]
async fn open_file(path: String) -> Result<FileContent, Error>;
#[tauri::command]
async fn save_file(path: String, content: String) -> Result<()>;
#[tauri::command]
async fn lsp_completions(path: String, line: u32, col: u32) -> Result<Vec<Completion>>;
#[tauri::command]
async fn lsp_goto_definition(path: String, line: u32, col: u32) -> Result<Location>;

// === 图谱 ===
#[tauri::command]
async fn graph_get_initial() -> Result<GraphData>;
#[tauri::command]
async fn graph_find_node(symbol: String, file: String) -> Result<Vec<Node>>;
#[tauri::command]
async fn graph_get_subgraph(node_id: String, depth: u32) -> Result<Subgraph>;
#[tauri::command]
async fn graph_search(query: String, options: SearchOptions) -> Result<Vec<SearchResult>>;

// === 文档图 ===
#[tauri::command]
async fn docgraph_get_initial() -> Result<DocGraphData>;
#[tauri::command]
async fn docgraph_find_refs(doc_path: String) -> Result<Vec<DocRef>>;

// === AI ===
#[tauri::command]
async fn ai_complete(context: CompletionContext) -> Result<CompletionResult>;
#[tauri::command]
async fn ai_chat(messages: Vec<ChatMessage>) -> Result<Stream<ChatDelta>>;
#[tauri::command]
async fn ai_mcp_call(tool: String, args: Value) -> Result<Value>;
```

---

### 3.3 图数据层

**核心数据结构（复用现有 `@latte-graph/core` 类型）：**

```rust
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub file_path: String,
    pub line_start: u32,
    pub line_end: u32,
    pub community_id: u32,
}

pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
}

pub enum NodeKind {
    Function,
    Class,
    File,
    Type,
    Test,
    Doc,          // 文档节点
    DocSection,   // 文档章节
}

pub enum EdgeKind {
    Calls,
    Imports,
    Contains,
    Tests,
    References,   // 文档→代码引用
    Links,        // 文档间链接
}
```

**持久化策略：**

| 数据 | 存储 | 引擎 | 并发策略 |
|------|------|------|---------|
| 代码图节点/边 | `.codegraph/` | SQLite WAL | 单写入者 + 多读取者 |
| 文档图节点/边 | `.docgraph/` | SQLite WAL | 同上 |
| 图分析查询（社区、影响半径） | `.codegraph/` | **DuckDB** (embedded) | 分析查询专用，不干扰写入 |
| 语义向量 | Sidecar 内存 | 持久化到 `.semble/` 索引 | N/A |
| 编辑状态 | `.editor/state.json` | JSON + 原子写入 | `write(tmp) → rename`，无锁 |
| 用户配置 | `.editor/config.json` | JSON | 手动保存 |

---

## 四、内存管理策略

### 4.1 分层内存预算（诚实版）

```
┌─────────────────────────────────────┬──────────┬──────────────┐
│ 层                                  │ 轻量模式  │ 完整 LSP 模式│
├─────────────────────────────────────┼──────────┼──────────────┤
│ 系统 WebView (基础)                 │ ~40-70MB │ ~40-70MB     │
│ 前端 JS (React+CM6+Zustand)        │ ~10-15MB │ ~10-15MB     │
│ Rust 后端 (编辑+图引擎+AI)         │ ~15-20MB │ ~15-20MB     │
│ 图数据缓存 (LRU)                    │ ~5-10MB  │ ~5-10MB      │
│ LSP 进程 (休眠态/活跃态)            │ 0MB      │ 30-150MB     │
├─────────────────────────────────────┼──────────┼──────────────┤
│ 合计 (无 LSP)                       │ ~70-115MB│ —            │
│ 合计 (1 个 LSP 休眠)               │ —        │ ~100-145MB   │
│ 合计 (1 个 LSP 活跃)               │ —        │ ~150-265MB   │
│ AI 模型 (本地 LLM, 可选)           │ 0-500MB  │ 0-500MB      │
└─────────────────────────────────────┴──────────┴──────────────┘
```

**对比 VSCode**：~350MB（含 Chrome + Monaco + 多个 LSP + 扩展进程）

### 4.2 LSP 生命周期管理：「Swap not Kill」

2026 年，用户对"冷启动"零容忍。3-5 秒等待打开一个 Rust 文件是不可接受的。设计原则是 **不 kill LSP 进程，而是将其压缩到休眠态**。

#### LSP 状态机

```
                    ┌──────────────┐
                    │  未启动       │
                    │  0MB         │
                    └──────┬───────┘
                           │ 用户打开对应语言文件
                           ▼
                    ┌──────────────┐
               ┌───▶│  活跃态       │
               │    │  80-150MB    │
               │    │  完整 LSP    │
               │    └──────┬───────┘
               │           │ 空闲 > 5min
               │           ▼
               │    ┌──────────────┐
               │    │  休眠缩紧     │
               │    │  LSP 释放缓存 │
               │    │  → 30-50MB   │
               │    └──────┬───────┘
               │           │ 用户再次编辑该语言文件
               └───────────┘
                    毫秒级唤醒
```

#### 休眠策略（详细）

| 阶段 | 时间 | 动作 | 内存效果 |
|------|------|------|---------|
| 活跃 | 0-5min | 正常 LSP 服务 | 80-150MB |
| 轻度空闲 | 5-10min | 发出 `$/cancelRequest` 取消所有 pending 请求 | 降 10-20MB |
| 深度休眠 | 10min+ | 发送 `workspace/semanticTokens/refresh` 释放语义缓存；Rust 端调用 LSP 的 `shutdown` 但不 kill 进程 | 30-50MB |
| 唤醒 | 用户操作 | 进程句柄存活，发送 `initialize` 重建上下文 | 毫秒级（无需 fork） |

**不 kill 的原因**：操作系统的内存压缩机制（Linux zswap / zram、macOS compressed memory、Windows Modern Standby）会在 LSP 休眠后自动将其内存页压缩到物理 RAM 之外。保留进程句柄使得下次激活只需重建上下文，而非重新 fork + load 整个 binary。

**状态栏展示**：

```
[biome LSP • 激活 45MB]    — TS/JS 项目，biome 运行中
[r-a LSP • 休眠 32MB]      — Rust 文件 10 分钟未编辑
[r-a LSP • 活跃 142MB]     — 正在编辑 Rust 文件
```

#### 默认 LSP 选型

2026 年，对 JS/TS 项目**默认使用 biome**，不对用户暴露选择。biome 是 Rust 编写的 LSP，内存占用 ~30-50MB（tsserver 的 1/3），且无 Node.js 依赖。

| 语言 | 默认 LSP | 内存 (休眠/活跃) | 理由 |
|------|---------|-----------------|------|
| JavaScript/TypeScript | **biome** | 15/45MB | Rust 原生，无 Node 依赖 |
| Rust | rust-analyzer | 30/150MB | 无替代 |
| Python | pyright | 20/80MB | 最成熟的 Python LSP |
| Go | gopls | 20/60MB | 官方 LSP |
| CSS/JSON/HTML | 内置 tree-sitter | 0MB | 不需要 LSP，lezer 足够 |

---

## 五、AI 调试能力

### 5.1 AI 架构

```
┌──────────────┐    ┌──────────────────────┐    ┌──────────────┐
│ 编辑器前端    │    │ Rust AI Engine       │    │ LLM Provider │
│              │    │                      │    │              │
│ 补全插件 ────┼───▶│ Completion Ctx       │───▶│ 本地: llama  │
│  Chat 面板 ──┼───▶│    + MCP Tools       │    │ 云端: API    │
│  MCP 客户端──┼───▶│    + Doc RAG         │    │  🤖 Agent    │
│              │    │                      │    │              │
│              │    │  • 代码缓冲区         │    │              │
│              │    │  • 图查询             │    │              │
│              │    │  • 文档图优先检索     │    │              │
│              │    │  • LSP 信息           │    │              │
│              │    │  • 项目上下文         │    │              │
└──────────────┘    └──────────────────────┘    └──────────────┘
```

### 5.2 MCP 工具集

Rust 后端内嵌 MCP Server（复用 `fastmcp`），暴露以下工具给 AI：

| MCP 工具 | 功能 |
|----------|------|
| `read_file(path)` | 读取文件内容 |
| `edit_file(path, diff)` | 应用代码修改 |
| `graph_query(symbol)` | 查询符号在图谱中的关系 |
| `graph_neighbors(node_id)` | 获取节点的邻接子图 |
| `lsp_hover(path, line, col)` | LSP 悬停类型信息 |
| `lsp_completions(path, line, col)` | LSP 补全候选 |
| `search_code(query)` | 语义搜索 |
| **`doc_graph_query(topic)`** | **查询文档图谱（优先于 LLM）** |
| `run_command(cmd)` | 在项目终端中执行命令 |
| `diagnose(path)` | 获取文件诊断错误 |

### 5.3 Doc RAG：先文档，后 LLM（新增）

**问题**：用户问"这个 API 怎么用"，很多时候答案在 `docs/` 目录的 Markdown 里。不需要调 LLM 推理，不花钱，零延迟。

**流程**：

```
用户提问: "parseInput 怎么用？"
    │
    ▼
[Doc RAG Engine]
    │
    ├── docgraph_query("parseInput")
    │   → 查文档图中是否有 "parseInput" 的文档引用
    │   → 命中: 返回 docs/api/parser.md 第 42-60 行
    │   → 直接在 Chat 中展示，不调 LLM
    │
    ├── 未命中: 退回到 LLM
    │   → 调用 MCP 工具链
    │   → graph_query + read_file + lsp_hover
    │   → LLM 综合推理给出答案
    │
    └── 结果缓存: TTL 5min，相同问题直接返回
```

**优势**：
- 80% 的"怎么用"类问题可以直接从文档图回答，零 LLM 开销
- 文档图检索 < 10ms（SQLite 索引定位），vs LLM 推理 1-10s
- 结果 100% 准确（文档原文），没有 LLM 幻觉
- 用户编辑文档后，下一次检索立即感知（增量更新）

AI 调试流程示例（复杂场景才走 LLM）：

```
用户: "这个 bug 在哪里？"
   │
   ▼
[AI Chat → 理解问题 → 调用工具链]
   │
   ├── doc_graph_query("error message") → 未命中，继续
   ├── search_code("error message")     → 定位相关代码
   ├── graph_query("parseInput")        → 看谁调用了这个函数
   ├── read_file("src/parser.ts")       → 查看实现
   ├── lsp_hover(...)                   → 查看类型信息
   └── LLM 综合推理后给出答案
```

---

## 六、文档图谱 (Doc Graph)

### 6.1 文档节点类型

| 节点 | 来源 | 举例 |
|------|------|------|
| `Doc` | Markdown 文件 | `docs/architecture.md` |
| `DocSection` | Markdown 标题 (H1-H3) | `## Architecture` |
| `CodeRef` | 文档中 `` `code` `` 引用 | `src/main.ts` |
| `WikiLink` | `[[link]]` 双向链接 | `[[architecture]]` |
| `DocComment` | 源码中的文档注释 | JSDoc `/** */` |

### 6.2 文档 → 代码跳转

```
文档中的 `src/parser.ts` 或 `parseInput()` 引用
    │
    ▼
Rust DocGraph Engine 解析 Markdown
    → 提取代码文件引用 (`` `path/to/file` ``)
    → 提取符号引用 (`` `functionName` ``)
    → 写入 doc_edges 表 (references 边)
    │
    ▼
前端展示：
    - 选中文档中的代码引用 → 跳转到编辑器并打开文件
    - 在图谱中显示代码节点 ↔ 文档节点的连线
```

---

## 七、存储层：SQLite + DuckDB + JSON

### 7.1 存储选型

| 场景 | 引擎 | 理由 |
|------|------|------|
| 图数据事务写入 (节点/边) | SQLite WAL | 成熟的嵌入式 SQL，事务安全 |
| **图分析查询** (社区检测、影响半径、聚合统计) | **DuckDB** | OLAP 查询比 SQLite 快 10-100 倍，可接 Parquet |
| 编辑状态、配置 | JSON + 原子写入 | 低价值高频写入，避免 SQLite WAL 锁风险 |

### 7.2 SQLite WAL 模式

```
                    ┌──────────────────────┐
                    │  单写入者线程          │
                    │  (通过 tokio::mpsc)   │
                    │  批量 100ms 窗口提交   │
                    └────────┬─────────────┘
                             │ 顺序写入
                             ▼
                    ┌──────────────────────┐
                    │  SQLite WAL           │
                    │  .codegraph/cg.db     │
                    │  .docgraph/dg.db      │
                    │  .config/config.db    │
                    └────────┬─────────────┘
                             │
                    ┌────────┴──────────────┐
                    │  WAL ≠ 阻塞读取       │
                    │  写入 WAL 时仍可读取   │
                    └───────────────────────┘
```

**风险：网盘同步文件夹**

SQLite 的 WAL 模式会产生 `.db-wal` 和 `.db-shm` 文件。在 Dropbox / OneDrive / iCloud 等网盘同步目录下：
- 文件锁机制不稳定，极易 `database is locked`
- WAL + SHM 文件同步冲突 → 数据库损坏

**对策：**
- 检测项目路径是否包含 `Dropbox`/`OneDrive`/`iCloud`/`GoogleDrive` → 启动时弹提示
- 网盘路径下自动降级：不使用 WAL 模式，回退到 `DELETE` journal 模式（性能略降但数据安全）
- `.codegraph/` 和 `.docgraph/` 加入项目的 `.gitignore`（不应被同步）

### 7.3 DuckDB 分析查询

对于代码图的**分析型查询**（社区检测、影响半径计算、跨模块依赖统计），SQLite 的 OLTP 设计不是最优的。

引入 DuckDB 作为**嵌入式分析引擎**：

```sql
-- DuckDB 查询: 跨模块依赖热力图
SELECT
  source.community_id AS from_community,
  target.community_id AS to_community,
  COUNT(*) AS edge_count
FROM edges e
JOIN nodes source ON e.source = source.id
JOIN nodes target ON e.target = target.id
WHERE e.kind = 'calls'
GROUP BY from_community, to_community
ORDER BY edge_count DESC;
```

| 场景 | 引擎 | 数据源 |
|------|------|--------|
| 单节点查询/邻接查询 | SQLite (索引) | codegraph.db |
| 社区发现/聚合分析 | DuckDB (向量化) | codegraph.db 只读 → DuckDB |
| 图构建写入 | SQLite (事务) | codegraph.db |
| 语义搜索 | Sidecar (向量) | semble |

DuckDB 与 SQLite 共享同一个数据库文件（DuckDB 可以读 SQLite 文件），不需要数据迁移。仅在分析查询时启动 DuckDB 引擎，日常操作仍是 SQLite。

---

## 八、Tree-sitter 分层策略

### 8.1 双 Tree-sitter 不冲突

```
┌─────────────────────────────────────────┐
│ 前端 (WebView)                           │
│                                         │
│  CodeMirror 6                           │
│    └── @codemirror/lang-typescript       │
│         └── lezer WASM parser           │
│               │                         │
│               ▼ 语法高亮                 │
│         零 IPC，纯前端                   │
│         最快的渲染路径                   │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ 后端 (Rust)                              │
│                                         │
│  Graph Builder (后台线程)                │
│    └── tree-sitter (native .so/.dylib)  │
│         │                               │
│         ▼ AST 遍历                      │
│    提取函数定义、调用关系、导入声明       │
│    写入 SQLite 代码图                   │
│                                         │
│  **不参与语法高亮**                      │
│  **不参与实时补全**                      │
│  **仅用于非实时图构建**                  │
└─────────────────────────────────────────┘
```

**为什么需要两套：**
- 前端的 lezer WASM 是为 CM6 优化的，不能直接用于 Rust 端 tree-sitter API 调用
- Rust 端的 tree-sitter 不能直接在前端 WASM 中使用（CM6 有自己的一套）
- 两者**互不冲突**：前端负责实时高亮，Rust 负责后台图构建

---

## 九、与现有项目的集成

### 9.1 复用 `@latte-graph/core`

```rust
// 方案 A: Rust 重实现 (推荐)
// Rust 版 codegraph engine，直接调用 tree-sitter 分析 AST
// 性能更好，内存更低，无跨语言开销

// 方案 B: FFI 调用 TS core
// 通过 sidecar 启动 Node.js 进程调用 @latte-graph/core
// 快速上市但引入 Node 进程开销

// 推荐方案 A，但 Phase 1 可用方案 B 快速验证
```

### 9.2 复用 `@latte-graph/web-ui`

| 组件 | 复用方式 | 修改 |
|------|---------|------|
| `GraphCanvas` (D3) | 算法复用 → Web Worker + WebGPU | D3 力计算放 Worker，渲染改 WebGPU |
| `CodePanel` | 适配为 CM6 只读模式 | IPC 改成 Tauri invoke |
| `SearchPanel` | 直接复用 | 无修改 |
| `useGraphData` | 改为调用 Tauri command 替代 HTTP | 接口对调 |

### 9.3 与 `latte-doc-wiki` 的关系

文档图谱的数据格式与 `latte-doc-wiki` 保持一致（共享 node/edge schema），
`latte-code-editor` 内置文档图谱渲染，同时可以将文档编辑写操作同步给 wiki。

---

## 十、分阶段实现路线

### Phase 1: 核心编辑器骨架

- Tauri 2.0 项目初始化
- 前端：CodeMirror 6 嵌入 + 基本编辑功能（打开/保存/语法高亮）
- 后端：文件管理、缓冲区管理
- 大文件模式：原生 `<pre>` 降级路径
- LSP 休眠框架：lsp.rs 基础进程管理
- 目标：能打开文件并编辑，空闲内存 < 70MB（不启动 LSP）

### Phase 2: 代码图谱集成

- Rust 端实现 CodeGraph engine（tree-sitter 解析 → SQLite WAL + DuckDB 分析）
- 前端：WebGPU 图渲染器 + Web Worker d3-force + WebGL2/Canvas2D 降级链
- 图谱↔编辑器双向跳转
- 复用现有 graph schema 和社区检测逻辑

### Phase 3: 文档图谱

- DocGraph engine：Markdown 解析 → 文档图构建
- 文档↔代码的双向引用和跳转
- Doc RAG 基础：文档图检索 → 直接回答

### Phase 4: LSP 完整集成

- `tower-lsp` 客户端实现
- "Swap not Kill" 休眠/唤醒管理
- 默认 biome（JS/TS）+ rust-analyzer + pyright + gopls
- 补全、诊断、悬停、跳转定义
- 状态栏显示 LSP 状态和内存占用

### Phase 5: AI 集成

- MCP Server 内嵌（复用 `fastmcp`）
- 本地 LLM (`llama-cpp-rs`) + 云端 API 双模式
- AI 补全 + Chat 面板
- Doc RAG 降级链：文档图 → LLM
- 图谱增强的 AI 调试

---

## 十一、关键风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **WebGPU 兼容性** | 部分旧硬件不支持 | □ WebGPU → WebGL2 → Canvas2D 三级降级；□ Canvas2D 自动限 500 节点 |
| **LSP 休眠协议不标准** | 有些 LSP 不支持内存压缩指示 | □ 对不支持的 LSP 才 kill（退化为旧方案）；□ biome/RA 均支持 |
| **SQLite 在网盘路径损坏** | OneDrive 用户数据库损坏 | □ 路径检测 + 警告；□ 自动降级到 DELETE journal |
| **DuckDB 额外进程开销** | 小项目不需要分析引擎 | □ 延迟初始化：只在首次分析查询时才加载 DuckDB；□ < 1000 节点直接用 SQLite |
| **WebView 2026 年基线上升** | 内存预算可能超预期 | □ 在 CI 中加入内存基准测试；□ 超过阈值时自动告警 |
| **Rust 树状模块复杂度** | 编辑器逻辑复杂，Rust 编译慢 | □ 分层编译：core/ai/graph 独立 crate；□ 充分利用 cargo 增量编译 |
