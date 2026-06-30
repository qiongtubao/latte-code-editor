# Chat Panel Configuration Design

## 问题
当前配置硬编码在 `latte-rs-agents/config/` 中：
- 路径不灵活
- 无法在 UI 中切换模型
- 与其他 latte 项目不共享配置

## 设计

### 1. 全局模型配置 `~/.latte/models.yaml`

所有 latte 系列项目共享的模型定义：

```yaml
# ~/.latte/models.yaml
# API 密钥支持环境变量引用

models:
  claude-sonnet-4:
    provider: anthropic
    api_key: ${ANTHROPIC_API_KEY}  # 或直接写密钥
    base_url: https://api.anthropic.com
    model: claude-sonnet-4-20250514
    max_tokens: 8192
    context_window: 200000
    
  deepseek-chat:
    provider: openai
    api_key: ${DEEPSEEK_API_KEY}
    base_url: https://api.deepseek.com
    model: deepseek-chat
    max_tokens: 8192
    
  gpt-4o:
    provider: openai
    api_key: ${OPENAI_API_KEY}
    base_url: https://api.openai.com
    model: gpt-4o
    max_tokens: 16384

# 默认模型
default_model: deepseek-chat
```

### 2. 编辑器角色配置 `~/.latte-code-editor/roles.yaml`

定义聊天面板的角色和使用的模型：

```yaml
# ~/.latte-code-editor/roles.yaml

# 默认模型（未指定时使用）
default_model: deepseek-chat

# 角色定义
roles:
  pm:
    name: Product Manager
    icon: 📋
    model: claude-sonnet-4  # 可覆盖默认
    prompt: |
      You are a Product Manager. Analyze requirements...
    
  architect:
    name: System Architect
    icon: 🏗️
    model: claude-sonnet-4  # 高质量角色用高级模型
    prompt: |
      You are a System Architect...
    
  programmer:
    name: Software Engineer
    icon: 💻
    model: deepseek-chat  # 代码任务用经济模型
    prompt: |
      You are a Software Engineer...
    
  tester:
    name: QA Engineer
    icon: 🧪
    model: deepseek-chat
    prompt: |
      You are a QA Engineer...

  # ... 更多角色
```

### 3. UI 运行时切换

聊天面板 UI：

```
┌─────────────────────────────────────┐
│ 💬 Chat          [Plan ▼] [⚙️]      │
├─────────────────────────────────────┤
│                                     │
│ [消息列表...]                        │
│                                     │
├─────────────────────────────────────┤
│ [输入框...]                         │
└─────────────────────────────────────┘
```

点击 ⚙️ 打开配置面板：

```
┌─────────────────────────────────────┐
│ Chat Configuration                  │
├─────────────────────────────────────┤
│ Default Model: [deepseek-chat ▼]    │
│                                     │
│ Roles:                              │
│   📋 PM         [claude-sonnet-4 ▼] │
│   🏗️ Architect  [claude-sonnet-4 ▼] │
│   💻 Programmer [deepseek-chat ▼]   │
│   🧪 Tester     [deepseek-chat ▼]   │
│   🔍 Reviewer   [claude-sonnet-4 ▼] │
│   ...                               │
│                                     │
│ [Open Config File] [Reset] [Save]   │
└─────────────────────────────────────┘
```

### 4. 配置优先级

1. **环境变量** - `LATTE_MODELS_PATH` 覆盖默认路径
2. **命令行参数** - `--models-path` 最高优先级
3. **全局配置** - `~/.latte/models.yaml`
4. **项目配置** - `.latte/models.yaml`（项目级别覆盖）
5. **内置默认** - 硬编码的最小配置

### 5. API

#### Tauri Commands

```rust
// 列出可用模型
#[tauri::command]
async fn chat_list_models() -> Result<Vec<ModelInfo>, String>;

// 获取角色配置
#[tauri::command]
async fn chat_get_role_config() -> Result<RoleConfig, String>;

// 设置角色模型
#[tauri::command]
async fn chat_set_role_model(role_id: String, model_id: String) -> Result<(), String>;

// 打开配置文件
#[tauri::command]
async fn chat_open_config() -> Result<(), String>;
```

#### Frontend Store

```typescript
interface ChatStore {
  // ... 现有字段
  
  // 新增
  availableModels: ModelInfo[];
  roleModels: Record<string, string>; // role_id -> model_id
  defaultModel: string;
  
  // 新增方法
  loadModels: () => Promise<void>;
  setRoleModel: (roleId: string, modelId: string) => Promise<void>;
  openConfig: () => Promise<void>;
}
```

## 实现计划

### Phase 1: 后端配置加载
- [ ] 创建 `~/.latte/models.yaml` 解析器
- [ ] 创建 `~/.latte-code-editor/roles.yaml` 解析器
- [ ] 支持环境变量展开 `${VAR}`
- [ ] 提供 `chat_list_models` 命令

### Phase 2: 前端 UI
- [ ] 添加配置按钮 ⚙️
- [ ] 创建 `ChatConfigModal` 组件
- [ ] 下拉选择模型
- [ ] 保存配置到文件

### Phase 3: 运行时切换
- [ ] `chat_set_role_model` 命令
- [ ] 热更新配置
- [ ] 当前会话应用新模型

## 配置文件示例

### ~/.latte/models.yaml（完整）

```yaml
# Latte Global Model Configuration
# This file is shared across all latte projects

# API Keys (use env vars or plain text)
api_keys:
  anthropic: ${ANTHROPIC_API_KEY}
  openai: ${OPENAI_API_KEY}
  deepseek: ${DEEPSEEK_API_KEY}

# Model Definitions
models:
  claude-opus-4:
    name: Claude Opus 4
    provider: anthropic
    model: claude-opus-4-20250514
    max_tokens: 8192
    context_window: 200000
    supports_vision: true
    supports_thinking: true
    cost_input: 15.0   # $/1M tokens
    cost_output: 75.0
    
  claude-sonnet-4:
    name: Claude Sonnet 4
    provider: anthropic
    model: claude-sonnet-4-20250514
    max_tokens: 8192
    context_window: 200000
    supports_vision: true
    supports_thinking: true
    cost_input: 3.0
    cost_output: 15.0
    
  deepseek-chat:
    name: DeepSeek Chat V3
    provider: openai
    api_base: https://api.deepseek.com
    model: deepseek-chat
    max_tokens: 8192
    context_window: 65536
    cost_input: 0.27
    cost_output: 1.10
    
  deepseek-reasoner:
    name: DeepSeek R1
    provider: openai
    api_base: https://api.deepseek.com
    model: deepseek-reasoner
    max_tokens: 8192
    context_window: 65536
    supports_thinking: true
    cost_input: 0.55
    cost_output: 2.19
    
  gpt-4o:
    name: GPT-4o
    provider: openai
    model: gpt-4o
    max_tokens: 16384
    context_window: 128000
    supports_vision: true
    cost_input: 2.50
    cost_output: 10.0
    
  gpt-4o-mini:
    name: GPT-4o Mini
    provider: openai
    model: gpt-4o-mini
    max_tokens: 16384
    context_window: 128000
    cost_input: 0.15
    cost_output: 0.60

# Default model (used when role doesn't specify)
default_model: deepseek-chat

# Tier presets (for quick selection)
tiers:
  premium: claude-opus-4
  standard: claude-sonnet-4
  budget: deepseek-chat
```

### ~/.latte-code-editor/roles.yaml（完整）

```yaml
# Latte Code Editor Role Configuration
# Define roles and their model assignments

# Default model for roles not specified below
default_model: deepseek-chat

# Role definitions
roles:
  pm:
    name: Product Manager
    icon: 📋
    category: planning
    model: claude-sonnet-4
    temperature: 0.7
    prompt: |
      You are a Product Manager in a multi-agent team.
      
      Your responsibilities:
      - Define requirements and user stories
      - Prioritize features and scope
      - Balance stakeholder needs
      
      When analyzing a topic:
      1. Identify user needs and pain points
      2. Define acceptance criteria
      3. Document scope boundaries
      4. Flag risks and dependencies
      
      Be concise but thorough. Use markdown formatting.

  architect:
    name: System Architect
    icon: 🏗️
    category: planning
    model: claude-sonnet-4
    temperature: 0.5
    prompt: |
      You are a System Architect in a multi-agent team.
      
      Your responsibilities:
      - Design system architecture
      - Evaluate technical tradeoffs
      - Identify risks and mitigation strategies
      
      When analyzing a topic:
      1. Consider scalability, maintainability, security
      2. Propose concrete design patterns
      3. Document architecture decisions
      4. Identify integration points
      
      Provide diagrams using ASCII or mermaid syntax when helpful.

  programmer:
    name: Software Engineer
    icon: 💻
    category: execution
    model: deepseek-chat
    temperature: 0.3
    prompt: |
      You are a Software Engineer in a multi-agent team.
      
      Your responsibilities:
      - Implement features and fixes
      - Write clean, maintainable code
      - Estimate effort and complexity
      
      When analyzing a topic:
      1. Identify affected modules
      2. Propose implementation approach
      3. Provide code examples
      4. List testing considerations
      
      Use <file_edit path="..."> tags for file changes.
      
      Example:
      <file_edit path="src/lib/example.ts">
      Add new function for X
      </file_edit>

  tester:
    name: QA Engineer
    icon: 🧪
    category: verification
    model: deepseek-chat
    temperature: 0.4
    prompt: |
      You are a QA Engineer in a multi-agent team.
      
      Your responsibilities:
      - Design test strategies
      - Identify edge cases
      - Ensure quality coverage
      
      When analyzing a topic:
      1. Define test scenarios
      2. Identify edge cases
      3. Suggest test types (unit, integration, e2e)
      4. Flag quality risks

  reviewer:
    name: Code Reviewer
    icon: 🔍
    category: verification
    model: claude-sonnet-4
    temperature: 0.4
    prompt: |
      You are a Code Reviewer in a multi-agent team.
      
      Your responsibilities:
      - Review code quality
      - Identify patterns and anti-patterns
      - Ensure best practices
      
      When reviewing:
      1. Check code clarity and maintainability
      2. Identify potential bugs
      3. Suggest improvements
      4. Verify error handling
      
      Be constructive and specific.

  devops:
    name: DevOps Engineer
    icon: 🚀
    category: execution
    model: deepseek-chat
    temperature: 0.3
    prompt: |
      You are a DevOps Engineer in a multi-agent team.
      
      Your responsibilities:
      - CI/CD pipeline design
      - Infrastructure planning
      - Deployment strategies
      
      Consider:
      - Build and deployment automation
      - Monitoring and logging
      - Security and compliance
      - Cost optimization

  security:
    name: Security Auditor
    icon: 🛡️
    category: verification
    model: claude-sonnet-4
    temperature: 0.4
    prompt: |
      You are a Security Auditor in a multi-agent team.
      
      Your responsibilities:
      - Identify security vulnerabilities
      - Review authentication/authorization
      - Assess data protection
      
      Focus on:
      - Input validation
      - Injection risks
      - Authentication bypasses
      - Data exposure
      - Dependency vulnerabilities

  designer:
    name: UI/UX Designer
    icon: 🎨
    category: planning
    model: claude-sonnet-4
    temperature: 0.7
    prompt: |
      You are a UI/UX Designer in a multi-agent team.
      
      Your responsibilities:
      - User experience design
      - Interface design
      - Accessibility considerations
      
      Provide:
      - User flow descriptions
      - Wireframe sketches (ASCII)
      - Interaction patterns
      - Accessibility checklist

  tech_writer:
    name: Technical Writer
    icon: 📝
    category: execution
    model: deepseek-chat
    temperature: 0.5
    prompt: |
      You are a Technical Writer in a multi-agent team.
      
      Your responsibilities:
      - Documentation planning
      - API documentation
      - User guides
      
      Focus on:
      - Clear, concise language
      - Code examples
      - Step-by-step instructions
      - Consistent terminology

  manager:
    name: Engineering Manager
    icon: 👔
    category: planning
    model: claude-sonnet-4
    temperature: 0.5
    prompt: |
      You are an Engineering Manager in a multi-agent team.
      
      Your responsibilities:
      - Project planning
      - Resource allocation
      - Risk management
      - Decision making
      
      Synthesize team input and make decisions on:
      - Scope and priorities
      - Timeline and resources
      - Risk mitigation
      - Tradeoffs

# Workflow presets
workflows:
  plan:
    name: 🗺️ Plan — design and architect
    roles: [pm, architect, programmer, designer, manager]
    max_rounds: 2
    
  code:
    name: 💻 Code — review and refactor
    roles: [programmer, reviewer, security, tester]
    max_rounds: 1
    
  debug:
    name: 🪲 Debug — triage and fix
    roles: [tester, programmer, security, devops, manager]
    max_rounds: 2
    
  discuss:
    name: 💬 Discuss — full team
    roles: [pm, architect, programmer, tester, reviewer, devops, manager]
    max_rounds: 3
```


## 角色模型优先级（model chain / fallback）

每个角色可以配置**按优先级排序的模型链**。运行时按顺序尝试：
第一个模型成功就返回；遇到可重试错误（429 / 5xx / 临时网络故障），
就把当前模型放入**冷却表**并切到下一个；冷却时间到了之后该模型会
自动重新进入候选。所有模型都失败或都在冷却中时，返回一个带
`Tried: a, b, c` 信息的错误给用户。

### 设计动机

1. **不把鸡蛋放在一个篮子里** — 一个供应商限流时自动切到备用
2. **按"重要性"分配成本** — 让贵的（opus）只跑"重要"角色，便宜的（deepseek）跑"量大"角色
3. **与 `latte-rs-agents` 上游 `Role::model_chain` 协议对齐** — 同一份配置可以在 agent 框架和 chat panel 之间共享

### 角色 YAML 形式

```yaml
roles:
  programmer:
    name: Software Engineer
    icon: 💻
    category: execution
    temperature: 0.3
    prompt: |
      You are a senior engineer...
    # 优先级：claude-sonnet-4 是主，deepseek-chat 兜底
    model_chain:
      - claude-sonnet-4
      - deepseek-chat

  pm:
    name: Product Manager
    icon: 📋
    category: planning
    temperature: 0.5
    prompt: |
      You are a PM...
    # 旧格式 `model: <id>` 仍然支持 — 内部会被规整为单元素 chain
    model: gpt-4o
```

读取规则（`RoleDef::chain()`）：

1. 如果 `model_chain` 非空 → 使用它
2. 否则如果 `model` 非空 → 包装成单元素链
3. 否则 → 空链；runner 回退到 `GlobalModelConfig::default_model`

写入规则（`RoleDef::set_chain()`）：写入时**清空** `model` 字段，
保证序列化的 YAML 不会有歧义。

### 错误 → 冷却 映射（`cooldown_for_error`）

| 错误类型                          | 冷却时长           | 理由                       |
| --------------------------------- | ------------------ | -------------------------- |
| `RateLimited { retry_after, .. }` | `retry_after` (≥1s) | 供应商明确说"等这么久"     |
| `Api { status: 429 }`             | 60s                | 标准限流窗口               |
| `Api { status: 500..=599 }`       | 30s                | 上游故障，短暂重试          |
| `Api { status: 4xx (其他) }`      | **None**           | 调用方错误，换模型也无效    |
| `Http(_)` (reqwest)               | 10s                | 瞬时网络抖动               |
| `Auth / Config / Serde / Stream`  | **None**           | 内部配置错误，必须抛给用户 |

> 关键设计：把"换模型能解决的"和"换模型也解决不了的"两类错误区分开。
> 后者直接抛给用户（可能还要提示改配置），不要因为有 fallback 就吞掉。

### 运行时行为

1. `run_live_discussion` 根据 `RoleDef.chain()` 解析出 `(ModelDef, AiClient)` 列表
2. 每个角色调用 `RoleAgent::chat_with_fallback(messages, params)`
3. `chat_with_fallback` 走 `cooldown` 表过滤出可用模型，按顺序试
4. 第一个成功的 `Completion` 返回；失败的可重试错误记入 cooldown
5. 全部失败 → 返回 `LLM call failed (role: <id>)\nTried: a, b, c\nLast error: <...>`

### 新的 Tauri 命令

```rust
#[tauri::command]
async fn chat_set_role_model_chain(
    request: SetRoleModelChainRequest,  // { role_id, chain: Vec<String> }
) -> Result<Vec<String>, String>;       // 返回去重后的 canonical chain
```

`chat_set_role_model(role_id, model_id)` 是旧 API 的兼容壳，
内部直接调用 `RoleDef::set_chain(vec![model_id])`，
所以旧调用方不需要改任何东西 — 写出来的 YAML 自然就是新格式。

### UI — 角色链编辑器

`RoleChainEditor` 组件（`src/components/RoleChainEditor.tsx`）替换了旧的单下拉：

```
┌──────────────────────────────────────────┐
│ 💻 Software Engineer              💾 …   │
│ ┌──────────────────────────────────────┐ │
│ │ 1 │ [claude-sonnet-4   ▼] [↑] [↓] [×]│ │
│ │ 2 │ [deepseek-chat     ▼] [↑] [↓] [×]│ │
│ └──────────────────────────────────────┘ │
│ + [Add fallback…                       ▼]│
└──────────────────────────────────────────┘
```

每行：
- **数字**：优先级
- **下拉**：可换成任何 `availableModels` 里的 id
- **↑/↓**：调整优先级（边界禁用）
- **×**：移除（最后一行禁用，保证至少有一个）

底部 `+ Add fallback…` 只列出**未在链中**的模型，避免重复。

每次改动立即持久化到 `roles.yaml`（`chat_set_role_model_chain`），
后端返回的 canonical 链覆盖本地，保证 UI 与 YAML 一致。

## 讨论 runner：对齐上游 `DiscussionOrchestrator`

`session.rs` 里的 `run_live_discussion` 不再自建 round/turn/cooldown 循环，
全部交给 `latte-agent-orchestrator` 的 `DiscussionOrchestrator`。
自建的那套 `RoleAgent` / `chat_with_fallback` / `cooldown_for_error` /
`build_chain_for_role` 全部删除，理由是：

1. **链路走与冷却跟踪是上游 `Agent::chat` 的语义** —— `ModelClient` 自带
   `cooldown_until: Mutex<Option<Instant>>`，按 `latte_ai::error::AiError` 自动
   区分可重试（429/5xx/Http → 进冷却）和不可重试（4xx 除 429 / Auth /
   Config → 立刻抛给用户）。再自己写一遍就是双份维护。
2. **round / step / turn 的编排逻辑没有项目特异性** —— `run_with_events`
   自带 per-turn 回调（`FnMut(&TurnRecord)`），正好可以映射到
   `chat:turn` Tauri 事件，UX 与原来"边跑边出"的体验一致。
3. **Role / Model 类型上游有正式版** —— 上游的 `Role`（带 handlebars
   prompt 渲染、`default_model_tier`、`model_chain`）和
   `latte_agent_core::config::ModelDef` 是协议层；项目在 YAML 里存的是
   轻量 config 视图，运行时由 `build_upstream_role` /
   `convert_model_def` 一次性桥接过去。

### 类型桥接（project → upstream）

| 项目 (`chat_panel::global_config`) | 上游 (`latte_agent_core::config` 等) | 桥接点 |
| --- | --- | --- |
| `ModelDef.reasoning: bool` | `ModelDef.supports_thinking: bool` | `convert_model_def` |
| `ModelDef.cost_per_million_*: f64` | `ModelDef.cost_per_million_*: Option<f64>` | `0.0 → None` |
| `ModelDef.api: String`（可空） | `ModelDef.api: String` | 空时回退到 `provider` |
| `RoleDef.prompt: String` | `Role.system_prompt: String` | 直接赋值（无 handlebars） |
| `RoleDef.temperature: f64` | `Role.default_params.temperature: Option<f64>` | `Some(temperature)` |
| `RoleDef.chain() -> Vec<String>` | `Role.model_chain: Vec<String>` | 直接赋值（文档/审查用） |
| `RoleDef.chain()[0]` | `ModelResolver::role_tiers[role_id]["standard"]` | `build_agent_config` 注入 |
| `RoleDef.chain()[1..]` | `ModelResolver::resolve_chain(..., &chain_tail)` | `build_agent_runners` 传入 |

### 一次性 wiring

```rust
// 1. 解析 chain → 上游 AgentConfig（带 per-role tier 覆盖）
let agent_config = build_agent_config(global_config, roles_config, &role_ids);
let resolver = ModelResolver::from_config(&agent_config)?;

// 2. 每个 role 解析出 Vec<Model>，装进 Agent::new_with_chain
let agents = build_agent_runners(&resolver, roles_config, &role_ids)?;

// 3. 一 role 一 step 的 workflow
let workflow = build_workflow(req, &role_ids);

// 4. 跑 — run_with_events 自带每 turn 回调，映射到 Tauri 事件
let result = orchestrator.run_with_events(|turn| {
    app.emit("chat:turn", TurnPayload { ... })?;
}).await?;
```

### `cooldown_for_error` 测试去哪儿了？

移到上游的 `latte-agent-core`（`agent::cooldown_for_error`），由其自带
单测覆盖（429/5xx/4xx/RateLimited/Http/Auth 等 9 个 case）。项目里再写
一遍是测同一份代码，留着反而变成"双份测试同一行为"的陷阱。

### 兼容性

| 不变 | 改 |
| --- | --- |
| Tauri 命令 `chat_start_discussion` 签名 | 内部：自建 runner → `DiscussionOrchestrator` |
| Tauri 事件 `chat:turn` payload | 类型：移除 `RoleAgent`/`ChainEntry` 等 |
| `DiscussionPayload` / `TurnPayload` / `RoundPayload` | imports：删除 `parking_lot::Mutex`、`AiError`、`Arc`、`Instant` |
| `WorkflowInfo` / `RoleInfo` | 增加上游 `Agent` / `AgentRunner` / `ModelResolver` 等 |
| 无 API key 时的提示 | 不再生成 stub 回复，交给 controller/runtime 返回真实错误 |
## 迁移策略

1. **首次启动**：如果 `~/.latte/models.yaml` 不存在，自动创建默认配置
2. **向后兼容**：如果存在 `latte-rs-agents/config/`，优先使用全局配置
3. **配置合并**：全局 + 项目级 + 运行时覆盖
