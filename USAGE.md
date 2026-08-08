# Latte Code Editor — 使用文档

> 基于 Tauri 2.0 的跨平台轻量编辑器，集成代码图谱 + 文档图谱。
> 核心定位：在保留完整编辑能力的前提下，将内存基线从 VSCode 的 350MB 降至 <70MB。

---

## 快速开始

### 安装

#### 从构建产物安装

```bash
# DEB (Ubuntu/Debian)
sudo dpkg -i src-tauri/target/release/bundle/deb/Latte\ Code\ Editor_0.1.0_amd64.deb

# RPM (Fedora/RHEL)
sudo rpm -i src-tauri/target/release/bundle/rpm/Latte\ Code\ Editor-0.1.0-1.x86_64.rpm

# AppImage (任何 Linux)
chmod +x src-tauri/target/release/bundle/appimage/Latte\ Code\ Editor_0.1.0_amd64.AppImage
./Latte\ Code\ Editor_0.1.0_amd64.AppImage
```

#### 从源码运行

```bash
git clone <repo>
cd latte-code-editor
pnpm install
env -u CI cargo tauri dev
```

---

### 基本用法

#### 打开文件

| 方式 | 操作 |
|------|------|
| 快捷键 | `Ctrl+O` (macOS: `Cmd+O`) |
| 按钮 | 点击欢迎屏的 "Open File" 按钮 |

支持的文件类型会自动启用语法高亮：

| 扩展名 | 语言 |
|--------|------|
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` | TypeScript / JavaScript |
| `.rs` | Rust |
| `.py` | Python |
| `.json`, `.jsonc` | JSON |
| `.md`, `.mdx` | Markdown |
| 其他 | 纯文本（无高亮） |

#### 保存文件

| 方式 | 操作 |
|------|------|
| 快捷键 | `Ctrl+S` (macOS: `Cmd+S`) |

未保存的修改会在状态栏显示 **● Modified** 指示器。

---

### 大文件模式

当文件超过 **50MB** 或 **10万行** 时，编辑器自动切换到原生大文件模式：

- 使用 `<pre>` 元素 + 虚拟滚动（仅渲染可见的 ~100 行）
- **无语法高亮、无 LSP、无补全**
- 内存增加 < 2MB
- 顶部黄色横幅提示 `⚠ Large File Mode`

> 大文件支持只读查看。如需编辑，请先拆分文件。

---

### 代码图谱

代码图谱从项目的 `.codegraph/codegraph.db` 读取。如果项目目录下还没有图数据库，需要先用图谱构建工具生成。

#### 准备图数据

```bash
# 使用 latte-code-review-graph 的 CLI 构建图谱
cd your-project
latte-graph build    # 生成 .codegraph/codegraph.db
```

如果图数据库已存在，编辑器会自动加载。

#### 面板布局

编辑器提供三种布局模式，通过顶部的标签栏切换：

```
┌──────┬───────┬───────┐
│Editor│ Graph │ Split │  ← 点击切换
├──────┴───────┴───────┤
│                      │
│  主内容区域            │
│                      │
└──────────────────────┘
```

| 模式 | 效果 |
|------|------|
| **Editor** | 全屏编辑器 |
| **Graph** | 全屏代码图谱 |
| **Split** | 左半编辑器 + 右半图谱（推荐） |

#### 图谱交互

| 操作 | 效果 |
|------|------|
| **拖拽背景** | 平移图谱视图 |
| **滚轮** | 缩放图谱 |
| **悬停节点** | 显示节点名称标签 |
| **点击节点** | **自动在编辑器侧打开对应文件并跳转到代码行** |
| **拖拽节点** | 拖动节点（力的模拟会自动调整布局） |

#### 节点颜色图例

| 颜色 | 节点类型 | 示例 |
|------|---------|------|
| 🟠 橙色 | File | 源文件 |
| 🟢 绿色 | Function / Method | `parseInput()` |
| 🔵 蓝色 | Class / Interface / Struct | `class Parser` |
| 🟣 紫色 | Type / TypeAlias / Enum | `type Result<T>` |
| 🟡 黄色 | Import / Export | `import { readFile }` |
| 🟤 青色 | Constant / Variable | `const MAX_SIZE` |
| 🔴 红色 | Test | `test("parse input")` |

#### 图谱底层架构

```
[.codegraph/codegraph.db] ──Rust IPC──▶ [GraphPanel]
                                              │
                                    [Web Worker: d3-force]
                                          │ 每帧 postMessage
                                          ▼
                                [Canvas2DRenderer (GraphRenderer 接口)]
                                              │ 点击节点
                                              ▼
                                     [Editor: 打开文件]
```

图谱默认使用 **Canvas 2D** 渲染。如果项目超过 3000-5000 节点出现卡顿，可以无缝切换为 **WebGPU** 渲染器（待实现），无需改动任何业务代码。

切换方式（未来）：

```typescript
// 在 GraphPanel.tsx 中
<CanvasGraph renderer={new WebGPURenderer()} ... />
```

---

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存文件 |
| `Ctrl+Tab` | 切换标签页（待实现） |

---

### 状态栏

底部状态栏显示：

```
[语言类型] [● Modified]              [⚠ Large File] [N lines]
```

| 指示器 | 含义 |
|--------|------|
| `TypeScript` | 当前语言 |
| `● Modified` | 文件已被修改未保存 |
| `⚠ Large File` | 大文件模式启用 |
| `571 lines` | 文件行数（图谱模式下显示节点/边数） |

---

### 配置

设置通过图形化设置面板修改（工具栏 Settings），持久化在 localStorage `latte-settings`：

| 设置项 | 说明 |
|--------|------|
| Skin | 皮肤（VS Code Dark / Monokai / Dracula / GitHub Light / Solarized Light），作用于整个界面、联动切换代码主题、嵌入的 chat 面板同步跟随；定义见 `src/skins.ts` |
| Theme | CodeMirror 代码区主题（选皮肤时会联动切换，可再单独改） |
| Font Size / Tab Size | 编辑器字号 / 缩进宽度 |
| Line Numbers / Word Wrap / Auto Save | 行号 / 自动换行 / 自动保存 |
| Graph Renderer | 图谱渲染器（Auto / WebGPU / Canvas 2D） |
| Docs Input/Output Dir | 文档图谱的输入目录与分析输出目录（相对项目根） |

字体栈固定为 `JetBrains Mono`, `Fira Code`, `Cascadia Code`, monospace。

---

### 常见问题

#### Q: 图谱面板显示 "No graph data"

图数据库不存在。请在项目根目录运行图谱构建工具：

```bash
cd your-project
latte-graph build
# 或按照 latte-code-review-graph 的说明构建图谱
```

#### Q: 编辑器很慢 / 内存高

- 检查是否打开了 >10万行的大文件（会触发大文件模式，但仍占用 I/O）
- 检查是否有其他图谱工具在占用 `.codegraph/codegraph.db`（SQLite 锁）
- 目前 LSP 集成尚未完成，不会出现 LSP 进程占用内存的情况

#### Q: 能在无桌面环境的服务器上运行吗？

不能。编辑器需要系统 WebView（WebKitGTK / WebView2 / WKWebView）。服务器环境下请使用 CLI 版本的图谱工具。

#### Q: 支持哪些操作系统？

| 系统 | 状态 |
|------|------|
| Linux (WebKitGTK) | ✅ 已测试 |
| macOS (WKWebView) | ✅ 构建支持 |
| Windows (WebView2) | ✅ 构建支持（需 Windows 10+） |

---

### 开发调试

#### 开发者模式

```bash
# 启动带 DevTools 的开发模式
env -u CI cargo tauri dev
```

在开发模式下，前端 HMR（热重载）自动启用，修改 `src/` 下的文件后立即生效。

#### Rust 后端调试

```bash
# 编译并检查警告
cargo build --manifest-path src-tauri/Cargo.toml

# 运行测试
cargo test --manifest-path src-tauri/Cargo.toml
```

#### 前端调试

```bash
# 仅构建前端（不启动 Tauri）
pnpm frontend:build

# 仅检查类型
npx tsc --noEmit
```

---

### 文件结构

```
latte-code-editor/
├── src/                          # 前端
│   ├── components/
│   │   ├── EditorPanel.tsx       编辑器面板
│   │   ├── CodeMirrorEditor.tsx  CM6 编辑器
│   │   ├── EmptyState.tsx        欢迎屏
│   │   ├── StatusBar.tsx         状态栏
│   │   ├── LargeFileViewer.tsx   大文件查看器
│   │   ├── GraphPanel.tsx        图谱面板
│   │   ├── CanvasGraph.tsx       图谱 Canvas 组件
│   │   ├── Canvas2DRenderer.tsx  Canvas 2D 渲染器
│   │   ├── graphRenderer.ts     渲染器接口定义
│   │   ├── forceLayout.worker.ts Web Worker 力布局
│   │   └── languageExtensions.ts 语言高亮注册
│   ├── api/
│   │   ├── commands.ts          编辑器 IPC 调用
│   │   └── graphCommands.ts     图谱 IPC 调用
│   ├── hooks/
│   │   ├── useEditorStore.ts    编辑器状态
│   │   ├── useGraphStore.ts     图谱状态
│   │   └── graphTypes.ts        图谱类型定义
│   └── App.tsx                  主布局
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── editor/buffer.rs     文件缓冲区管理
│   │   ├── editor/commands.rs   编辑器 IPC
│   │   ├── graph/codegraph.rs   图谱 SQLite 读取
│   │   ├── graph/commands.rs    图谱 IPC
│   │   ├── project/watcher.rs   文件监听
│   │   └── lib.rs               Tauri 入口
│   └── Cargo.toml
├── ARCHITECTURE.md              完整架构文档
└── package.json
```
