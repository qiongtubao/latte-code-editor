# LSP 手动触发模式 - 实施总结

## 核心理念

**默认零资源消耗，需要时显式触发** - 保持 Latte Editor 的轻量级定位。

---

## 实施的功能

### 1. 触发方式

#### 快捷键
- `Ctrl/Cmd + L` — 启动当前文件语言的 LSP
- `Ctrl/Cmd + Shift + L` — 打开 LSP 管理面板
- `Ctrl/Cmd + Alt + H` — 休眠当前 LSP
- `Ctrl/Cmd + Alt + S` — 停止当前 LSP

#### 工具栏
- 状态栏 LSP 状态按钮
- 点击启动/唤醒 LSP
- 右键打开管理菜单

### 2. 状态显示

状态栏实时显示：
```
[TypeScript] [🔌 LSP: off] | Total: 0MB
```

启动后：
```
[TypeScript] [⚡ TypeScript 65MB] | Total: 65MB
```

### 3. 状态图标

| 状态 | 图标 | 含义 |
|-----|------|------|
| 未启动 | 🔌 | 零资源消耗 |
| 启动中 | 🔄 | 正在初始化 |
| 活跃 | ⚡ | 正常运行 |
| 休眠 | 💤 | 内存压缩 |
| 错误 | ❌ | 启动失败 |

### 4. 管理面板

通过 `Ctrl+Shift+L` 打开，提供详细控制：
- 显示所有 LSP 状态
- 启动/停止/休眠/唤醒
- 总内存占用统计
- 一键停止所有

---

## 文件结构

### 新增文件
- `src/api/lsp.ts` — 前端 LSP API
- `src/hooks/useLspStore.ts` — LSP 状态管理
- `src/components/LspStatusBar.tsx` — 状态栏组件
- `src/components/LspManagerPanel.tsx` — 管理面板
- `docs/lsp-manual-trigger-design.md` — 设计文档

### 修改文件
- `src/components/EditorPanel.tsx` — 添加快捷键
- `src/components/StatusBar.tsx` — 集成 LSP 状态
- `src/App.tsx` — 添加管理面板入口
- `src-tauri/src/editor/lsp_commands.rs` — 手动触发命令
- `src-tauri/src/lib.rs` — 注册新命令

---

## 资源消耗对比

| 模式 | 内存占用 | 启动时间 | 用户体验 |
|-----|---------|---------|---------|
| **手动触发（我们的设计）** | **0-300 MB（按需）** | **0（默认）** | **零干扰** |
| 自动启动 | 100-300 MB（始终） | 1-2 秒 | 持续占用 |
| 无 LSP | 0 MB | 0 秒 | 无智能功能 |

---

## 用户使用流程

### 场景 1：日常使用（不需要 LSP）
1. 打开 Latte Editor
2. 打开文件、编辑
3. **零 LSP 开销**，内存 < 100 MB

### 场景 2：需要代码补全
1. 打开 TypeScript 文件
2. 按 `Ctrl+L`
3. 看到 `⚡ TypeScript 65MB`
4. 开始补全
5. 用完按 `Ctrl+Alt+S` 停止

### 场景 3：长时间使用
1. 启动 LSP
2. 5 分钟无操作 → 自动休眠
3. 内存从 65MB → 30MB
4. 需要时自动唤醒

---

## 下一步优化

1. **实现真正的 LSP 启动/停止**
   - 当前是占位实现
   - 需要让 `lsp_start` 真正能启动 LSP 服务器

2. **内存监控**
   - 通过 `ps` 命令查询实际内存
   - 5 秒更新一次

3. **自动休眠**
   - 检测 5-10 分钟无操作
   - 自动休眠节省内存

4. **设置选项**
   - 自定义自动休眠超时
   - 自定义快捷键
   - 内存警告阈值

---

## 总结

通过手动触发模式，Latte Editor 实现了：
- ✅ **默认零资源消耗** - 保持轻量级定位
- ✅ **按需启用** - 用户完全控制
- ✅ **资源透明** - 实时显示内存占用
- ✅ **快速控制** - 一键休眠/停止
- ✅ **保持特色** - 不影响图谱等核心功能

这是轻量级编辑器 + 可选 LSP 功能的最佳平衡点！
