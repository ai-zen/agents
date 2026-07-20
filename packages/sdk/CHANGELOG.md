# Changelog

## [0.2.6] - 2026-07-20

### 🔧 修复

- **默认 SubAgent 函数名和描述不足以让 LLM 识别为子 Agent** — `function.name` 从 `general_assistant` 改为 `sub_agent_default`，`function.description` 重写为详细描述，明确子 Agent 身份和能力边界。参数名 `query` → `task` 与设计规范统一，system prompt 明确角色定位
- **`DEFAULT_SUBAGENT_ID` 从 `general-assistant` 改为 `sub-agent-default`** — 文件名与函数名对应，便于识别

## [0.2.5] - 2026-07-20

### 🔧 修复

- **`DEFAULT_SUBAGENT_DEFINITION` 缺少 `permissions` 配置** — 默认 SubAgent `general-assistant` 未配置权限，导致所有维度等同于 `deny: ['*']`，完全无法使用任何工具/skill/MCP/SubAgent。现已按设计规范补全，仅 `subagents` 维度设为 `deny: ['*']` 防止递归调用

## [0.2.4] - 2026-07-20

### 🔧 修复

- **`load_skill` 不再注入 System 消息** — 改为在工具返回值中直接返回完整 SKILL.md 内容和 Skill 目录路径、文件列表，LLM 完全透明可见
- **`SkillInfo` 新增 `dirPath` 字段** — 记录 SKILL.md 所在目录的绝对路径
- **`McpConnectionManager.doConnect` 按 Server capabilities 按需调用** — 仅对声明了的能力调用对应方法，避免未声明时返回 Method not found
- **`McpConnectionManager.doConnect` 各 list 调用加 try/catch 保护** — 单个能力获取失败不影响其他能力

## [0.2.3] - 2026-07-20

### 🔧 修复

- **`AgentRepository` — 使用 `EntityRepository` 替代直接文件操作** — 采用基础仓储统一逻辑

## [0.2.2] - 2026-07-20

### 🔧 修复

- **`SdkAgent.send()` — `ctx.messages` 不再直接引用 `this.messages`** — 改为浅拷贝快照，确保消息数组仅由 agent 作为唯一维护者
- **`AutoMigratePlugin` — 不再创建新 Agent 实例** — 直接替换 `agent.messages` 数组，保留所有引用、插件绑定和事件监听
- **`AutoMigratePlugin` — 迁移前增加日志提示** — 使用 `log.warn` 输出迁移开始通知

### 🎯 优化

- **`AutoMigratePlugin` — `onHandoff` 签名简化** — 从 `(doc, oldAgent, newAgent)` 改为 `(doc, agent)`，因为 agent 是同一对象
- **`TaskMigrationService.createPrompt()` — 精简提示词** — 明确要求只输出交接文档，不做任何解释

### ✅ 测试

- 补充迁移前后消息数组**长度精确断言**（迁移前 3 条 → 迁移后 2 条）
- 补充迁移失败时消息数组**长度和内容不变**的断言
