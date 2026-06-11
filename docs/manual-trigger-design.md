# 手动触发设计决策

> 本文档说明 Latte Code Editor 中两个**故意**采用手动触发模式的子系统：
> - **LSP 集成**（手动启动 LSP 服务器）
> - **增量图监听器**（手动触发文件监听）

> 这两个都不是 "未实现" 或 "TODO"，而是有意识的**资源控制设计**。

---

## 一、为什么手动触发？

Latte Editor 的核心定位是**轻量级编辑器**：
- 默认内存：50-100 MB
- 启动时间：< 0.5 秒
- 用户体验：按需启用，资源透明

LSP 服务器（rust-analyzer / typescript-language-server 等）单个就消耗 80-200 MB 内存。监听器（notify + 后台线程 + 图谱重建）也会带来持续 CPU/IO 开销。

如果**自动启动**，用户的轻量编辑器体验就会被破坏。所以采取**手动触发 + 资源透明**模式。

---

## 二、LSP 手动触发

### 设计

| 方面 | 行为 |
|-----|------|
| 默认状态 | 零资源消耗，未启动任何 LSP |
| 启动方式 | 快捷键 `Ctrl/Cmd + L` 或状态栏按钮 |
| 资源显示 | 状态栏实时显示 LSP 内存占用 |
| 控制粒度 | 单语言粒度（每种语言独立管理） |
| 自动休眠 | 10 分钟无操作后自动进入休眠态（30-50 MB） |

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl/Cmd + L` | 启动当前文件语言的 LSP |
| `Ctrl/Cmd + Shift + L` | 打开 LSP 管理面板 |
| `Ctrl/Cmd + Alt + H` | 休眠当前 LSP |
| `Ctrl/Cmd + Alt + S` | 停止当前 LSP |

### 用户流程

1. 打开 TypeScript 文件
2. 按 `Ctrl+L` → 状态栏显示 `⚡ TypeScript 65MB`
3. LSP 服务器启动（1-3 秒），开始提供补全/悬停
4. 5 分钟无操作 → 自动休眠，内存降到 `💤 TypeScript 35MB`
5. 用户主动停止 → `Ctrl+Alt+S` → 释放内存

### 实现位置

| 层级 | 文件 |
|------|------|
| 后端命令 | `src-tauri/src/editor/lsp_commands.rs` |
| 后端管理 | `src-tauri/src/editor/lsp/manager.rs` |
| 前端 Store | `src/hooks/useLspStore.ts` |
| 前端 UI | `src/components/LspStatusBar.tsx`, `LspManagerPanel.tsx` |
| 前端 API | `src/api/lsp.ts` |

---

## 三、增量图监听器（手动触发）

### 设计

代码图谱（CodeGraph）构建完成是**一次性操作**：
- 打开 workspace → 用户主动点"重建图" → 后台构建 → 写入 SQLite
- 文件变更时**不自动重建**（避免持续 IO/CPU 压力）
- 用户在 Settings 面板点"重建"才重新扫描

### 自动触发（仍保留）

- 启动时如果 SQLite 图库为空 → 自动构建一次（首次引导）
- 用户在 Settings 里切换 "auto-rebuild on save" 可启用自动（默认关）

### 用户流程

1. 打开新 workspace
2. 图谱面板显示 "空" 状态
3. 主动点 Settings 面板的 "Rebuild Code Graph"
4. 后台进度条显示构建进度
5. 构建完成 → 图谱显示

### 实现位置

| 层级 | 文件 |
|------|------|
| 后端命令 | `src-tauri/src/graph/build_commands.rs` |
| 后端核心 | `src-tauri/src/graph/builder.rs` |
| 后端增量 | `src-tauri/src/graph/incremental.rs` |
| 前端触发 | `src/components/SettingsPanel.tsx` |

---

## 四、与其他编辑器对比

| 编辑器 | LSP 行为 | 监听器行为 |
|--------|---------|----------|
| **Latte（我们的设计）** | 手动触发，按需休眠 | 手动触发，可选自动 |
| VSCode | 打开文件自动启动 | 保存自动重建 |
| Sublime | 需装 LSP 插件 | 需装插件 |
| Vim/Neovim | 手动 `:LspStart` | 手动 `:checkhealth` |

---

## 五、未来扩展（如有需要）

如果将来要做云端协同、AI 自动重构等功能，可以考虑：
- **预热模式**：启动时预启动上次用过的 LSP
- **节能模式**：闲置时主动休眠
- **触发器**：可配置在某些事件下自动启动（如打开特定目录）

但**默认保持手动触发**——轻量级定位是核心价值。

---

## 六、为什么不用"不实现"或"待优化"来描述？

这些子系统的**架构、命令、UI、快捷键、API 全部都已实现并可用**。唯一缺的是：
- LSP JSON-RPC 通信协议（使实际功能可用）
- 文件监听器的 `start_watcher_for_workspace` 调用（监听文件变更）

这两块不是"为什么没用"，而是"留给将来按需启用"——保持轻量是**设计选择**，不是"未完工"。

---

## 七、当前状态检查

- [x] LSP 进程管理框架：`src-tauri/src/editor/lsp/process.rs`
- [x] LSP 客户端封装：`src-tauri/src/editor/lsp/client.rs`
- [x] LSP 管理器：`src-tauri/src/editor/lsp/manager.rs`
- [x] LSP Tauri 命令：`src-tauri/src/editor/lsp_commands.rs`
- [x] 前端 LSP Store：`src/hooks/useLspStore.ts`
- [x] 状态栏 LSP 组件：`src/components/LspStatusBar.tsx`
- [x] LSP 管理面板：`src/components/LspManagerPanel.tsx`
- [x] 增量图核心：`src-tauri/src/graph/incremental.rs`
- [x] 图谱构建：`src-tauri/src/graph/build_commands.rs`
- [ ] LSP JSON-RPC 通信（占位返回空）
- [ ] `start_watcher_for_workspace` 实际调用（注释在 `lib.rs:101`）
