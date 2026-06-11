# Debug 模式设计

> 解决"沟通无效乱改、全靠人操作、无法复现无法排查"的问题。
> 目标：**所有用户操作和系统状态变化可主动重放、可离线追踪、可事后回放**。

---

## 一、目标与现状

### 1.1 现状痛点

- 用户报告"切 Workspace 后图谱空白"——开发人员只能让用户再次手动复现，无法自己验证。
- "LSP 补全不出来"——不知道是没触发、没启动、还是 JSON-RPC 失败。
- "保存后状态错乱"——不知道是 React 重渲染、Store 顺序、还是后端事件没到达。
- 日志只有 `eprintln!` / `console.log`，崩溃即丢，无结构、无索引。

### 1.2 目标

| 维度 | 目标 |
|-----|------|
| **可复现** | 用户报告问题时能附一份操作记录，开发可一键回放 |
| **可观测** | 所有用户操作、IPC 调用、状态变化、错误都有结构化日志 |
| **可主动触发** | 不用真实点击就能模拟任意用户操作 |
| **可离线排查** | 日志写入本地文件，崩溃/重启不丢 |
| **不污染正式用户** | 默认关闭，发布版本不包含 UI |

---

## 二、调试范围（全场景）

四类核心场景全部覆盖（互相交织，不留盲区）：

| 场景 | 涉及模块 | 关键事件 |
|-----|---------|---------|
| **A. Workspace 切换** | `WorkspaceRegistry`、`Persistence`、`useWorkspaceStore` | 创建/删除/激活/persist/restore |
| **B. 文件/编辑器** | `useEditorStore`、`EditorPanel`、文件系统 | open/save/close/change/switch tab |
| **C. 图谱构建** | `IncrementalHub`、`graph_commands`、`useGraphStore` | requestReload/rebuild/nodeClick |
| **D. LSP 通信** | `LspManager`、`lsp_commands`、`useLspStore` | start/stop/hibernate/didOpen/didChange/hover/completion |

---

## 三、开关机制

### 3.1 开启方式（双重，OR 关系）

| 方式 | 用途 |
|-----|------|
| **环境变量 `LATTE_DEBUG=1`** | CI/CD、给测试人员发特定包时使用；优先级最高 |
| **隐藏快捷键 `Ctrl/Cmd + Shift + D`** | 日常开发时随时切换；UI 仍保持简洁 |
| `localStorage["latte.debug"]` | 持久化用户的选择（与上述任一开启后写入 true） |

> **不**通过 Settings 面板开关：调试是突发需求，进面板繁琐。
> **不**在 Dev build 默认开启：有时需要在 Prod 包临时排查。

### 3.2 关闭

- 再按一次 `Ctrl/Cmd + Shift + D` → 关闭
- 设置 `LATTE_DEBUG=0` 重启 → 关闭
- **运行时安全**：关闭时 Debug 工具栏、事件注入面板、键盘拦截器全部卸载；日志写入器保留但只接受 `error` 级别（兜底）

### 3.3 状态可见性

- 关闭时：UI 与现状完全一致
- 开启时：右下角出现**最小化调试栏**（Debug Bar），半透明 1 行，hover 展开
  - 显示：`🛠 DEBUG | 模块:5 | 事件:127 | 日志:latte-debug.log | [≡]`

---

## 四、日志系统（统一格式 + 统一文件）

### 4.1 格式

JSON Lines（每行一条 JSON），字段：

```json
{
  "ts": "2026-06-11T10:23:45.123Z",
  "level": "debug|info|warn|error",
  "side": "front|back",
  "module": "lsp|graph|workspace|editor|ipc|store",
  "event": "lsp.start",
  "msg": "Starting rust-analyzer for Rust",
  "ctx": { "language": "rust", "workspace_id": "ws-abc" },
  "tid": 42,
  "sid": "sess-xyz"
}
```

- `tid`：前端的 tab id（多窗口可区分）
- `sid`：会话 id（每次启动生成一次）
- 同一事件前后端通过 `event` + `ctx` 中的 `trace_id` 串起来

### 4.2 写入策略

| 渠道 | 何时启用 | 写入器 |
|-----|---------|--------|
| `console.*` | 永远 | `console.debug/info/warn/error`（带 `latte:` 前缀） |
| **文件 `latte-debug.log`** | `LATTE_DEBUG=1` 或快捷键开启时 | 通过 Tauri `app_data_dir/debug/latte-debug.log` 追加 |
| 文件滚动 | 单一文件 > 5MB 或每天 0 点 | 滚动成 `latte-debug.YYYY-MM-DD-HH.log` |
| IPC 转发 | 前端 → 后端 | 单独的 `debug_log_from_front` Tauri command，前端把日志行原样转发给后端落盘 |

**统一文件**：`app_data_dir/debug/latte-debug.log`，前后端时间戳交错，但能用 `side` 字段区分。

**容量保护（防"日志把 C 盘写满"）：**

| 维度 | 阈值 | 行为 | 配置项 |
|-----|------|------|--------|
| 单文件大小 | 5 MB | 滚动到 `latte-debug.YYYY-MM-DD-HH.log` | 硬编码 |
| 文件夹总容量 | **500 MB** | 从最旧的文件开始删除，直到总容量 ≤ 400 MB | `LATTE_DEBUG_MAX_DIR_MB` 环境变量可覆盖 |
| 文件存活时间 | 7 天 | 启动时清理超过 7 天的滚动文件 | `LATTE_DEBUG_MAX_AGE_DAYS` |
| 同时存在文件数 | 50 个 | 超过则按 mtime 删除最旧 | 硬编码 |

清理时机：
1. 应用启动时执行一次（同步，不阻塞 setup 超过 200ms）
2. 每次滚动新文件后，立即检查总容量（异步）
3. 关闭应用时再执行一次（best-effort）

实现位置：`src-tauri/src/debug/storage.rs` 的 `purge_old_logs(dir)` 函数，纯文件系统操作，不依赖任何业务模块。

### 4.3 日志模块（必须埋点清单）

| 模块 | 必须记录的 event | 级别 |
|-----|----------------|------|
| **ipc** | `ipc.invoke`, `ipc.response`, `ipc.error` | info / warn |
| **workspace** | `ws.create`, `ws.delete`, `ws.activate`, `ws.persist`, `ws.restore` | info |
| **editor** | `file.open`, `file.save`, `file.close`, `tab.switch` | info |
| **graph** | `graph.requestReload`, `graph.rebuild.start/end`, `graph.nodeClick` | info |
| **lsp** | `lsp.start/stop/hibernate/wake`, `lsp.didOpen/didChange/didSave/didClose`, `lsp.hover`, `lsp.completion`, `lsp.error` | info / error |
| **store** | `store.set`（Zustand 关键 store，每次 state 变化打 patch） | debug |
| **boot** | `app.start`, `app.ready` | info |

> 实现：用 `createDebugLogger(module)` 工厂封装 `console.*` + IPC 转发，开发时一行 import 即可埋点。

### 4.4 性能保护

- **采样**：debug/info 级别在主循环密集路径（如 `graph.nodeClick` 拖拽期间）默认 1/10 采样
- **节流**：同一 `event + ctx.trace_id` 100ms 内只打第一条
- **不阻塞**：文件写入是 async append，IPC 转发走 fire-and-forget

### 4.5 调试自身的审计事件

Debug 自身行为必须可追溯，所有以下动作强制 `warn` 级别：

| event 名 | 触发时机 | 关键 ctx |
|---------|---------|---------|
| `debug.mode.on` / `debug.mode.off` | 开关切换 | `source: shortcut|env|localStorage` |
| `debug.replay.executed` | L1 重发成功 | `action`, `traceId` |
| `debug.replay.skipped` | L1 重发被锁拦截 | `action`, `reason: locked`, `lockHeldMs` |
| `debug.replay.lock_timeout` | 锁超时强制释放 | `action`, `forceReleased` |
| `debug.inject.executed` | L4 注入成功 | `event`, `ctx` 摘要 |
| `debug.inject.dangerous` | 危险事件触发（含已确认） | `event`, `confirmed: bool`, `skippedConfirm: bool`, `ctx` |
| `debug.inject.rejected` | 用户在二次确认中取消 | `event` |
| `debug.snapshot.taken` | L3 快照生成 | `storeCount`, `sizeBytes` |
| `debug.log.purged` | 清理旧日志 | `removedFiles`, `freedBytes` |

---

## 五、事件注入系统（手动触发）

### 5.1 粒度（四个层级并存）

| 粒度 | 形式 | 适用 |
|-----|------|------|
| **L1: 单快捷键重发** | `Ctrl/Cmd + Shift + R` | 重发"上一次"用户操作 |
| **L2: 模块级重放** | Debug Bar 菜单 | 一键重放某个模块的初始化序列 |
| **L3: 全局状态快照** | `Ctrl/Cmd + Shift + S` | dump 所有 Store 到控制台 + 文件 |
| **L4: 自定义事件注入** | Debug Bar → "事件注入" 面板 | 自由输入 JSON 触发任意内部事件 |

### 5.2 L1：单快捷键重发

- 内部维护一个 `lastAction` 栈（最多 20 条）
- 每次记录：操作名 + 入参 + 触发时间 + 截图（base64，仅前 5 条）
- `Ctrl+Shift+R` → 弹出"重发"小弹窗，显示最近 5 条，单击即重放

| 操作 | 重发动作 |
|-----|---------|
| `lsp.start(rust)` | 调 `lsp_start("rust")` |
| `graph.requestReload` | 调 `requestReload()` |
| `workspace.activate(ws-1)` | 调 registry.setActive + 通知前端 |
| `file.open(/x/y.ts)` | 调 `openFile` |
| `lsp.didOpen(file)` | 调 `lsp_did_open` |

**防抖与幂等保护（防"幽灵进程"与状态机错乱）：**

1. **每模块一把互斥锁 `ReplayLock`**：键 = `module:operation`（如 `lsp:start`），存于 `useDebugStore`。
2. **加锁时机**：调用 `debugEmit` / `replayLastAction` 入口处。
3. **锁内行为**：
   - 若锁已被持有 → 直接忽略本次重发请求，并在 Debug Bar 闪一次 toast：
     `⏳ lsp.start 正在执行中（已持有锁 1.2s）`；同时记录一条 `debug.replay.skipped` 警告日志。
   - 锁持有超过 **3 秒**视为异常，自动释放并打 `debug.replay.lock_timeout` error 日志（防止永久死锁）。
4. **`Ctrl+Shift+R` 物理按键防抖**：全局 250ms 节流，250ms 内多次按键只触发一次"重发弹窗"的打开。
5. **操作级幂等表**（白名单）：以下操作即使重发，底层也由后端 idempotency key 兜底，重复执行不会产生新进程：
   - `lsp.start` → 后端检查同名+同 root 进程已存在则直接返回
   - `workspace.activate` → 后端检查已激活则直接返回
   - `graph.requestReload` → 合并 500ms 内的多次请求
6. **状态可见**：Debug Bar 抽屉顶部加一行 `🔒 当前持有: lsp:start (1.2s)`，让用户看到锁状态。

**示例日志**：

```json
{"ts":"...","side":"front","module":"debug","event":"debug.replay.skipped","ctx":{"action":"lsp.start","reason":"locked","lockHeldMs":1234}}
{"ts":"...","side":"front","module":"debug","event":"debug.replay.lock_timeout","ctx":{"action":"lsp.start","forceReleased":true}}
```

### 5.3 L2：模块级重放

Debug Bar 展开后，按模块显示按钮：

```
[LSP    ]  ▶ 重放初始化  ⏹ 全部停止  💤 全部休眠
[图谱   ]  ▶ 重建图     🔄 重新加载
[Workspace] ▶ 重新持久化  ↻ 重新 hydrate
[编辑器 ]  ↻ 重新打开当前文件  💾 强制重存
```

- "重放初始化"：执行该模块在 `setup()` 里的步骤序列（如 LSP：依次 detect_language → spawn process → send initialize → send initialized → load workspace）
- 关键：所有重放动作都用 `trace_id` 串起来，可以在日志里看到完整链路

### 5.4 L3：全局状态快照

- `Ctrl+Shift+S` 或 Debug Bar 按钮
- 输出 JSON 到 console + 追加到 `latte-debug-snap-<sid>.json`：

```json
{
  "ts": "2026-06-11T10:23:45.123Z",
  "stores": {
    "editor": { "filePath": "...", "content": "...", "...": "..." },
    "workspace": { "activeId": "ws-1", "workspaces": [...] },
    "graph": { "nodes": 234, "edges": 567, "loading": false },
    "lsp": { "rust": "running", "ts": "stopped" }
  },
  "backend": {
    "lsp_managers": { "ws-1": { "rust": "running" } },
    "workspaces_in_registry": 3
  }
}
```

- 同时调后端 `debug_dump_backend_state` command 取后端视角

### 5.5 L4：自定义事件注入

Debug Bar → "事件注入" → 弹出面板：

- **下拉选事件名**（自动从代码中扫描出 `debug.register` 注册的事件名）
- **JSON 编辑器**（CodeMirror 实例）填写 `ctx`
- **"触发"按钮** → 调 `debugEmit(eventName, ctx)`
- **"复制 trace_id"** → 注入时生成 trace_id 并显示，方便去日志搜

支持的内部事件（与 4.3 表格一致，但 emit 端）：
- `lsp.start`、`lsp.stop`、`graph.requestReload`、`workspace.activate` 等

后端也支持：`debug_emit_backend` command 接收 `{ event, ctx }`，由注册的事件分发器执行。

**危险操作二次确认（防误删数据）：**

1. **注册时声明**：`registerDebugEvent(name, handler, { dangerous: true })`，声明该事件会产生不可逆副作用。
2. **默认 `dangerous: true` 列表**（写死在 `debug/registry.ts`，避免漏标）：
   - `lsp.stop`、`lsp.stop_all`、`lsp.hibernate_all`
   - `workspace.delete`、`workspace.delete_all`
   - `graph.rebuild`（会清空 SQLite 重建）、`graph.clear`
   - `file.save`（覆盖原文件）、`file.delete`
   - `settings.reset_all`
3. **触发流程**：
   - 用户点"触发" → 若事件 `dangerous` → **先不执行**，弹二次确认 modal
   - Modal 内容：事件名 + 关键 ctx 摘要（如 `workspaceId: ws-1`）+ 红色警告文案 `此操作不可逆，确认要继续？`
   - 必须勾选 "我了解此操作的后果" 才能点"确认触发"
   - "取消" 直接关闭，不留副作用
4. **键盘快捷键的二次确认**：`Ctrl+Shift+E` 打开注入面板时，若用户在面板里直接回车，**不绕过**二次确认（防止 Enter 键误触）。
5. **会话级"信任"开关**（高级）：抽屉里有一个 `🛡 本次会话跳过危险确认` checkbox，勾上后本次 Debug 会话内所有 dangerous 事件都跳过 modal；切换 Workspace 或重启后会话失效。
6. **审计日志**：所有 dangerous 事件触发时，无论是否确认，都强制追加一条 `debug.inject.dangerous` 级别=warn 的日志，包含完整 ctx。

**确认 Modal 草图**：

```
┌────────────────────────────────────┐
│ ⚠ 危险操作确认                      │
├────────────────────────────────────┤
│ 事件: workspace.delete              │
│ 参数:                               │
│   workspaceId: "ws-1"               │
│   projectRoot: "/home/u/my-app"     │
│                                    │
│ ⚠ 此操作不可逆，会删除：             │
│   • Workspace 元数据               │
│   • 本地缓存的图谱 SQLite          │
│   • 关联的 LSP 进程                 │
│                                    │
│ [ ] 我了解此操作的后果              │
│                                    │
│        [取消]    [确认触发]         │
└────────────────────────────────────┘
```

---

## 六、Debug Bar UI

```
右下角最小化（48×24px 半透明）

🛠 DEBUG  模块:5  事件:127  日志:latte-debug.log  [≡]

点击 [≡] 展开抽屉（右下角滑出，360×400）：
┌──────────────────────────────────┐
│ 🛠 Debug Mode            [✕]    │
├──────────────────────────────────┤
│ 状态                             │
│  • 会话: sess-xyz (10:23:00)     │
│  • 日志: app_data_dir/debug/...  │
│  • [📋 复制路径]                  │
├──────────────────────────────────┤
│ 模块操作                         │
│  [LSP]      [▶重放] [⏹停] [💤休] │
│  [图谱]     [▶重建] [🔄重载]    │
│  [Workspace][▶持久] [↻hydrate]  │
│  [编辑器]   [↻重开] [💾强存]    │
├──────────────────────────────────┤
│ [📸 状态快照] [📨 事件注入]     │
│ [⏹ 关闭 Debug]                  │
└──────────────────────────────────┘
```

- 风格：沿用 `LspManagerPanel` 的 modal 风格，但改为常驻 drawer
- 事件注入面板：二级 modal，CodeMirror 写 JSON

---

## 七、键盘快捷键汇总

| 快捷键 | 功能 | 前提 |
|-------|------|------|
| `Ctrl/Cmd + Shift + D` | 开关 Debug 模式 | 任何时候 |
| `Ctrl/Cmd + Shift + R` | 重发上一次操作 | Debug 开启 |
| `Ctrl/Cmd + Shift + S` | 全局状态快照 | Debug 开启 |
| `Ctrl/Cmd + Shift + E` | 打开事件注入面板 | Debug 开启 |
| `Ctrl/Cmd + Shift + L` | 打开日志查看器（折线/过滤） | Debug 开启 |

> 与现有快捷键（`Ctrl+B`、`Ctrl+P`、`Ctrl+Shift+F`、`Ctrl+Shift+L`）不冲突：
> - 现有 `Ctrl+Shift+L` 是打开 LSP Manager → 改名为 `Ctrl+Shift+M` (M=Manager)，
>   文档与 UI 同步更新。
> - 新 `Ctrl+Shift+L` 用于日志查看器，名称语义更准确（L=L）。

---

## 八、模块/文件改动清单

### 8.1 新增

| 路径 | 作用 |
|-----|------|
| `src/utils/debug/logger.ts` | 前端 `createDebugLogger(module)` 工厂 |
| `src/utils/debug/inject.ts` | `debugEmit`、`registerDebugEvent`（带 `dangerous` 标记）、`lastAction` 栈 |
| `src/utils/debug/store.ts` | `useDebugStore`（开关、`isOn`、会话 id、`replayLocks` Map） |
| `src/components/DebugBar.tsx` | 右下角调试栏 + 抽屉（含锁状态显示） |
| `src/components/DebugEventInjectModal.tsx` | 事件注入面板（含 JSON 编辑器） |
| `src/components/DebugDangerConfirmModal.tsx` | 危险操作二次确认弹窗 |
| `src/components/DebugLogViewer.tsx` | 日志查看器（流式读尾部 + 过滤） |
| `src-tauri/src/debug/mod.rs` | 后端 debug 模块（tracing subscriber + 文件写入） |
| `src-tauri/src/debug/storage.rs` | `purge_old_logs()` 文件清理（容量+年龄双阈值） |
| `src-tauri/src/debug/commands.rs` | `debug_log_from_front`、`debug_emit_backend`、`debug_dump_backend_state` |
| `src-tauri/src/debug/events.rs` | 后端事件注册表 + 分发器 |
| `docs/debug-mode-usage.md` | 用户/开发手册 |

### 8.2 改动

| 路径 | 改动 |
|-----|------|
| `src/App.tsx` | 加载 `useDebugStore`、渲染 `DebugBar`、处理 `Ctrl+Shift+D/R/S/E`、250ms 按键节流 |
| `src/hooks/useLspStore.ts` | 操作前/后调 `debugEmit`、记 `lastAction`；`lsp.start` 等加 ReplayLock |
| `src/hooks/useWorkspaceStore.ts` | 同上；`workspace.delete` 等注册为 `dangerous: true` |
| `src/hooks/useEditorStore.ts` | 同上；`file.save` / `file.delete` 注册为 `dangerous: true` |
| `src/hooks/useGraphStore.ts` | 同上；`graph.rebuild` 注册为 `dangerous: true` |
| `src/api/lsp.ts` | invoke 包装器自动记录 `ipc.*` |
| `src-tauri/src/lib.rs` | 初始化 debug 模块（读 `LATTE_DEBUG` env、启动清理任务） |
| `src-tauri/src/editor/lsp_commands.rs` | 所有 command 加 `tracing::info!`；幂等键处理重复 `lsp_start` |
| `src-tauri/src/editor/lsp/manager.rs` | 同上 |
| `src-tauri/src/editor/lsp/client.rs` | JSON-RPC 收发加 `tracing::debug!` |
| `src-tauri/src/graph/build_commands.rs` | 同上 |
| `src-tauri/src/workspace/*` | 同上；`workspace.delete` 后端加二次确认 token |
| `src-tauri/Cargo.toml` | 加 `tracing`、`tracing-subscriber`、`tracing-appender` |
| `src/components/LspManagerPanel.tsx` | 提示用户快捷键从 `Ctrl+Shift+L` 改为 `Ctrl+Shift+M` |

---

## 九、隐私与发布

### 9.1 默认与开关

- Debug 关闭时：不创建日志文件、不启动 tracing subscriber（除了 error 级别）
- 发布包：`LATTE_DEBUG` env 默认未设置；`Ctrl+Shift+D` 仍可开启（但提示"当前为发布版本"）

### 9.2 禁止记录的内容

- 文件内容（`content` 字段）
- 用户输入的密码、API key、token
- 自动检测：注册 logger 时若 ctx 包含 `password|apiKey|token|secret` 字段，自动 redact 为 `***`

### 9.3 磁盘保护（双维度）

| 维度 | 阈值 | 行为 |
|-----|------|------|
| 文件年龄 | 7 天 | 启动时清理 |
| 文件夹总容量 | 500 MB（默认） | 删除最旧文件直至 ≤ 400 MB |
| 同时文件数 | 50 个 | 超过按 mtime 删最旧 |

可通过 `LATTE_DEBUG_MAX_DIR_MB` / `LATTE_DEBUG_MAX_AGE_DAYS` 调整。

### 9.4 危险操作审计与防滥用

- 所有 `dangerous: true` 事件触发时，强制 `warn` 级日志记录完整 ctx
- 二次确认 modal 必须勾选"我了解后果"才能继续；Enter 键不绕过
- 会话级"跳过确认"开关仅在当前 Debug 会话有效，关闭/重启/切换 workspace 自动失效
- 审计日志**不可关闭**（即使勾选"跳过确认"也会写）

---

## 十、测试与验收

### 10.1 自动化测试

- `logger.test.ts`：写一行 JSON 行可被解析；采样/节流生效；含 `password` 字段自动 redact
- `useDebugStore.test.ts`：开关切换、`LATTE_DEBUG=1` 自动开启；`replayLocks` 加锁/解锁/超时强制释放
- `inject.test.ts`：`debugEmit` 被注册的事件收到正确 ctx；`dangerous: true` 事件触发确认流；未勾选确认时不被执行
- `inject.test.ts`：会话级"跳过确认"开关启用后 dangerous 直接执行但仍写审计日志
- `replay.test.ts`：L1 重发期间 250ms 内连按只触发一次弹窗；锁定期间再发返回 `skipped`
- Rust：`debug_log_from_front` 写入 `app_data_dir/debug/latte-debug.log` 且追加不覆盖
- Rust：`purge_old_logs` 在 1GB mock 目录上只保留 ≤ 500MB，且优先删最旧；年龄 > 7 天的文件被删

### 10.2 手工验收（开发人员）

1. `pnpm tauri dev`，不开 Debug → 一切如旧，无日志文件
2. `LATTE_DEBUG=1 pnpm tauri dev` → 启动后 Debug Bar 自动出现
3. 按 `Ctrl+Shift+D` → Bar 出现/消失
4. 切换 Workspace → 日志中看到 `ws.activate` 完整链路
5. 打开 Rust 文件 → `lsp.start` → 状态变化在 `lsp.status` 实时可见
6. `Ctrl+Shift+R` → 重发刚才的 LSP 启动
7. `Ctrl+Shift+S` → 看到 `latte-debug-snap-*.json` 生成
8. 事件注入 → 手动 `lsp.start("rust")` → 状态变化
9. 关闭应用 → 重新打开 → 旧日志还在
10. 日志滚动：写满 5MB → 滚成 `.1.log`
11. **【新】** 重复按 `Ctrl+Shift+R` 5 次 → 只弹出一次重发窗口；LSP 启动中再按 → toast `⏳ lsp.start 正在执行`
12. **【新】** 事件注入 `workspace.delete` → 弹出二次确认 modal，未勾选时 Enter 也无效
13. **【新】** mock 写满 600MB 日志文件后启动 → 启动后总容量 ≤ 400MB
14. **【新】** 含 `password` 字段的 ctx 写入日志 → 显示为 `***`

---

## 十一、风险与缓解

| 风险 | 缓解 |
|-----|------|
| 日志写文件影响性能 | 异步追加 + 采样 + 节流；error 级别直通 |
| 快捷键冲突 | 重新规划 `Ctrl+Shift+L` (日志) 与 `Ctrl+Shift+M` (Manager) |
| 前端 IPC 转发增加负担 | 走 fire-and-forget，失败仅打 console |
| 日志泄漏敏感信息 | 显式黑名单 + content 字段永不记录 + ctx 字段名自动 redact |
| 事件注入误触真实破坏 | 注入事件走与正常路径相同的 API，不绕过安全检查 |
| 重发产生幽灵进程/状态机错乱 | ReplayLock 互斥 + 3s 超时强制释放 + 250ms 按键节流 + 后端 idempotency key 兜底 |
| 误删数据 | dangerous 事件二次确认 + 勾选"我了解后果"+ 审计日志不可关闭 |
| 日志把 C 盘写满 | 5MB 单文件滚动 + 7 天清理 + 500MB 总容量上限 + 50 文件数上限 |

---

## 十二、未来可扩展（不做，但留口）

- 日志远程上传（用户同意后）
- 录像回放（基于 lastAction 栈 + 状态快照 diff）
- AI 自动分析日志异常
- 跨窗口/跨设备的 trace_id 串联
