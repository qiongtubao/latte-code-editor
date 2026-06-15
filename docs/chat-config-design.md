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

## 迁移策略

1. **首次启动**：如果 `~/.latte/models.yaml` 不存在，自动创建默认配置
2. **向后兼容**：如果存在 `latte-rs-agents/config/`，优先使用全局配置
3. **配置合并**：全局 + 项目级 + 运行时覆盖
