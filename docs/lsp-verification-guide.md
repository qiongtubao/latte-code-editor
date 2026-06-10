# LSP 功能验证指南

## 如何检查 LSP 是否有效果

### 1. 准备测试环境

#### 1.1 安装 LSP 服务器

首先需要确保系统中安装了对应语言的 LSP 服务器：

```bash
# TypeScript/JavaScript LSP
npm install -g typescript-language-server typescript

# Rust LSP
rustup component add rust-analyzer

# Python LSP
pip install python-lsp-server

# Go LSP
go install golang.org/x/tools/gopls@latest

# C/C++ LSP
# Linux: sudo apt install clangd
# macOS: brew install llvm
# Windows: 从 LLVM 官网下载
```

#### 1.2 验证 LSP 服务器安装

```bash
# 检查 TypeScript LSP
typescript-language-server --version

# 检查 Rust Analyzer
rust-analyzer --version

# 检查 Python LSP
pylsp --version
```

### 2. 启动编辑器并检查 LSP 状态

#### 2.1 启动编辑器

```bash
# 开发模式启动
env -u CI cargo tauri dev
```

#### 2.2 检查 LSP 状态

在编辑器中：
1. 打开一个项目文件夹（例如：`Ctrl+O` 打开文件夹）
2. 打开一个源代码文件（例如：`.ts`, `.rs`, `.py`）
3. 查看状态栏或使用以下方式检查 LSP 状态：

**通过前端调用检查**：
```typescript
// 在浏览器 DevTools Console 中执行
import { getLspStatus } from './src/api/lspCommands';

getLspStatus().then(status => {
  console.log('LSP Status:', status);
});
```

### 3. 功能测试清单

#### 3.1 基础进程启动测试

**测试步骤**：
1. 打开 TypeScript 文件（例如 `test.ts`）
2. 观察编辑器启动行为
3. 检查进程是否启动：

```bash
# Linux/macOS
ps aux | grep typescript-language-server
ps aux | grep rust-analyzer

# Windows
tasklist | findstr typescript-language-server
tasklist | findstr rust-analyzer
```

**预期结果**：
- LSP 服务器进程应该在后台运行
- 进程状态应该是 "running"

#### 3.2 补全功能测试（当前为占位实现）

**测试步骤**：
1. 打开一个 TypeScript 文件
2. 输入一些代码，例如：
   ```typescript
   function greet(name: string) {
     // 在这里尝试触发补全
   }
   ```
3. 观察是否有补全提示

**当前状态**：⚠️ **占位实现**
- 补全功能框架已就位，但需要实现完整的 LSP 通信协议
- 目前返回空列表，不会显示补全提示

**如何验证框架**：
```bash
# 检查 Tauri 命令是否注册成功
cd src-tauri
cargo build
# 如果编译成功，说明命令已注册
```

#### 3.3 悬停信息测试（当前为占位实现）

**测试步骤**：
1. 打开代码文件
2. 将鼠标悬停在变量/函数上
3. 观察是否显示类型信息

**当前状态**：⚠️ **占位实现**
- 返回 null，不会显示悬停信息

#### 3.4 跳转到定义测试（当前为占位实现）

**测试步骤**：
1. 打开代码文件
2. Ctrl+Click 点击函数调用
3. 观察是否跳转到定义

**当前状态**：⚠️ **占位实现**
- 返回 null，不会跳转

### 4. 进程状态验证

#### 4.1 检查 Rust 日志

```bash
# 启动编辑器并查看日志
env -u CI cargo tauri dev
```

观察控制台输出：
```
[setup] restore workspaces failed: ...  # 正常的初始化日志
# 其他启动日志
```

#### 4.2 检查 LSP 进程状态

通过前端 API 检查：
```typescript
// 在 DevTools Console
getLspStatus().then(console.log);
```

预期输出：
```javascript
[
  {
    language: "TypeScript",
    state: "running", // 或 "stopped", "initializing"
    project_root: "/path/to/project",
    supports_hibernation: true
  }
]
```

### 5. 当前实现状态说明

#### ✅ 已完成的基础架构

1. **进程管理**：
   - ✅ LSP 进程启动逻辑
   - ✅ 进程生命周期管理
   - ✅ 休眠/唤醒框架

2. **语言检测**：
   - ✅ 自动检测文件语言
   - ✅ 配置 LSP 服务器命令
   - ✅ 支持 TS/JS/Rust/Python/Go/C++

3. **IPC 接口**：
   - ✅ 10 个 Tauri 命令已注册
   - ✅ 前端 API 已实现
   - ✅ 状态管理已完成

4. **编译测试**：
   - ✅ Rust 编译成功
   - ✅ 前端测试通过
   - ✅ 单元测试通过

#### ⚠️ 待实现的核心功能

**重要说明**：当前实现是**框架占位版**，核心 LSP 通信功能需要后续完善：

1. **LSP 通信协议**：
   - ❌ 未实现完整的 JSON-RPC 2.0 协议
   - ❌ 未实现 stdio 双向通信
   - ❌ 未实现消息解析和响应处理

2. **补全功能**：
   - ❌ 当前返回空列表（占位实现）
   - ❌ 未实际调用 LSP 服务器

3. **悬停功能**：
   - ❌ 当前返回 null（占位实现）

4. **跳转功能**：
   - ❌ 当前返回 null（占位实现）

### 6. 如何验证当前架构有效性

#### 6.1 编译验证

```bash
# 验证 Rust 编译
cd src-tauri
cargo build
# 应该成功编译，只有警告

# 验证前端编译
pnpm build
# 应该成功编译
```

#### 6.2 测试验证

```bash
# 运行 Rust 测试
cargo test --lib
# 应该显示 72 passed

# 运行前端测试
pnpm test
# 应该显示 32 passed
```

#### 6.3 命令注册验证

检查 `src-tauri/src/lib.rs` 中是否包含 LSP 命令：
```rust
.invoke_handler(tauri::generate_handler![
    // lsp
    crate::editor::lsp_commands::lsp_completions,
    crate::editor::lsp_commands::lsp_hover,
    ...
])
```

#### 6.4 进程启动验证（简化版）

打开 TypeScript 文件后，检查日志：
```
# 如果看到进程启动错误，说明进程管理逻辑在工作
# 例如：Failed to start LSP server 'typescript-language-server': ...
```

### 7. 下一步实现建议

要实现完整的 LSP 功能，需要：

#### 7.1 实现完整的 LSP 通信

1. **JSON-RPC 消息格式**：
   ```rust
   // 需要实现的结构
   struct LspMessage {
       jsonrpc: "2.0",
       id: u64,
       method: String,
       params: Value,
   }
   ```

2. **stdio 通信**：
   ```rust
   // 需要实现的异步读写
   async fn send_request() {
       // 写入 stdin
       // 读取 stdout
       // 解析响应
   }
   ```

3. **消息处理循环**：
   ```rust
   // 需要实现后台消息处理
   async fn message_loop() {
       // 持续读取 LSP 响应和通知
       // 分发到对应的处理函数
   }
   ```

#### 7.2 实现补全功能

参考完整实现路径：
```rust
pub async fn completion(&self, ...) -> Result<Vec<CompletionItem>, String> {
    // 1. 确保 LSP 已启动
    self.wake().await?;
    
    // 2. 发送 textDocument/completion 请求
    let params = CompletionParams {
        text_document: TextDocumentIdentifier { uri: ... },
        position: Position { line, character },
        ...
    };
    
    // 3. 通过 stdio 发送请求
    self.process.send_request("textDocument/completion", params).await?;
    
    // 4. 等待并解析响应
    let response: CompletionList = self.process.read_response().await?;
    
    // 5. 返回补全项
    Ok(response.items)
}
```

#### 7.3 测试完整功能

实现后，测试步骤：
1. 打开 TypeScript 文件
2. 输入 `console.` 后等待补全
3. 应该看到 `.log`, `.error` 等补全选项

### 8. 总结

**当前状态**：
- ✅ 基础架构完成
- ✅ 进程管理框架就位
- ✅ IPC 接口已注册
- ⚠️ LSP 通信协议待实现
- ⚠️ 补全/悬停/跳转功能待实现

**验证方式**：
- ✅ 编译测试：验证架构正确性
- ✅ 单元测试：验证逻辑完整性
- ⚠️ 功能测试：需要实现完整协议后才能验证

**建议**：
如果要验证 LSP 是否真的在工作，建议优先实现：
1. JSON-RPC 通信协议
2. 补全功能（最容易验证）
3. 然后进行实际的功能测试

目前的实现已经为完整功能奠定了坚实基础，后续只需实现通信协议部分即可。