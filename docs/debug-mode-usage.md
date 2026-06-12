# Debug Mode 使用手册

> 当用户报告"X 出问题了"时，开发人员可以在不打扰用户的前提下收集完整操作链，快速定位问题。

---

## 1. 开关

- **环境变量**：`LATTE_DEBUG=1` 启动后自动开启 Debug 模式
- **运行时快捷键**：`Ctrl/Cmd + Shift + D` 切换 Debug 栏显示
- **持久化**：开启状态写入 `localStorage["latte.debug"]`，下次启动自动恢复

## 2. 快捷键汇总

| 快捷键 | 功能 | 前提 |
|-------|------|------|
| `Ctrl/Cmd + Shift + D` | 开关 Debug 模式 | 任何时候 |
| `Ctrl/Cmd + Shift + R` | 重发上一次操作（L1 重放） | Debug 开启，250ms 节流 |
| `Ctrl/Cmd + Shift + S` | 全局状态快照 | Debug 开启，250ms 节流 |
| `Ctrl/Cmd + Shift + M` | 打开 LSP Manager | 任何时候 |

> 注：LSP Manager 快捷键已从 `Ctrl+Shift+L` 调整为 `Ctrl+Shift+M`，为日志查看器（未来扩展）让位。

## 3. Debug Bar UI

右下角弹出半透明抽屉：

- 顶部状态行：`🛠 DEBUG | sid: <sess-id> | locks: <N> (<key> <secs>s, ...)`
- 按钮：**📸 Snapshot**（= `Ctrl+Shift+S`）、**🐨 Inject**（打开事件注入面板）
- 模块区：LSP / Graph / Workspace 三个分组，每组有重放/重置按钮
- 关闭：右上角 `✕`

## 4. 事件注入（L4）

`Inject` 按钮打开模态：

1. 下拉选事件名（已注册的事件列表）
2. JSON 文本框填写 ctx
3. 危险事件（带 ⚠ 标记）会触发二次确认 modal（必须勾选"我了解此操作的后果"才能继续）
4. `Cmd/Ctrl+Enter` 触发

## 5. 日志位置

`app_data_dir/debug/latte-debug.log`（按天滚动）。

- **Windows**：`%APPDATA%\com.latte-code-editor\debug\`
- **macOS**：`~/Library/Application Support/com.latte-code-editor/debug/`
- **Linux**：`~/.local/share/com.latte-code-editor/debug/`

前端日志通过 `console.*` 暂留 TODO 转发到后端（Phase 2 stub），未来扩展时会一并写入同一文件。

## 6. 容量配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `LATTE_DEBUG_MAX_DIR_MB` | 500 | 文件夹总容量上限（MB），超过时按 mtime 删旧文件到 ≤ 250MB |
| `LATTE_DEBUG_MAX_AGE_DAYS` | 7 | 单文件最大存活天数 |
| `LATTE_DEBUG_MAX_FILES` | 50 | 同目录最多保留文件数 |

清理时机：
1. 应用启动时
2. 启动后每 6 小时一次（后台线程）
3. 手动：`Ctrl+Shift+L`（未来扩展）或 `invoke("debug_purge_now")`

## 7. 危险操作确认

事件名带 ⚠ 的会在注入时弹出二次确认。常用危险事件：

- `workspace.delete` — 删除 workspace 及其状态
- `graph.rebuild` — 清空图谱 SQLite 并重建
- `file.save` / `file.delete` — 覆盖或删除文件
- `lsp.stop` / `lsp.stop_all` — 终止 LSP 进程

会话级"跳过确认"开关（`useDebugStore.skipDangerousConfirm`）当前未在 UI 暴露；可通过控制台设置：
```js
useDebugStore.getState().skipDangerousConfirm = true  // 仅当前会话有效
```

## 8. 排查流程（开发人员）

1. 让用户用 `LATTE_DEBUG=1 pnpm tauri dev` 启动，或在出问题的机器上**运行时按 `Ctrl+Shift+D`**
2. 复现问题路径
3. 让用户发送 `latte-debug.log`（或用户截图 console 面板）
4. 解析 JSON Lines 格式，按 `event` 字段 grep：

```bash
# 用户进入 workspace-1 后没看到图谱
grep '"event":' latte-debug.log | grep workspace
grep '"event":' latte-debug.log | grep graph
```

5. 对比应用侧的行为期望 vs 实际事件

## 9. 隐私保护

- 日志中**不记录**文件内容（`content` 字段）
- ctx 字段名 `password` / `apiKey` / `token` / `secret` / `authorization` 自动 redact 为 `***`
- 7 天自动清理 + 500MB 容量上限
- Debug 关闭时仍然能调 `console.error`（不受 `isOn` 限制），便于发布版本记录致命错误

## 10. 已知限制 / 未来工作

- **日志查看器 UI**（`Ctrl+Shift+L`）尚未实现，目前需在控制台 `console.info` 实时查看或导出文件
- **前端 → 后端日志转发**（`debug_log_from_front` command）尚未接入，前端日志目前只在 console
- **AI 自动分析**（基于 lastAction 栈的异常检测）未实现
- **跨窗口/跨设备的 trace_id 串联** 未实现
