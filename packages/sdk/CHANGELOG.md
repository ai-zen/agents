# Changelog

## [0.3.4] - 2026-07-27

### 🎯 优化

- **`AutoMigratePlugin` 钩子重命名** — `onHandoff` → `onMigrated`，语义更清晰：迁移前用 `onBeforeMigrate`（此时 `agent.messages` 仍是完整旧历史），迁移完成后用 `onMigrated`（交接文档已注入）
- **`conversation-runner.ts` 保存逻辑修正** — 将保存旧对话从 `onMigrated`（原 `onHandoff`）移至 `onBeforeMigrate`，确保保存的是完整的旧对话历史，而非迁移后的新消息

## [0.3.3] - 2026-07-27

### 🎯 优化

- **默认 SubAgent System Prompt 新增两条强制性要求**：
  1. 信息不明确/模糊/缺失时拒绝执行，要求补充
  2. 存在自相矛盾信息时指出矛盾，要求澄清
- **默认 Agent System Prompt 新增原则**："有矛盾就问 — 如果用户指令中存在自相矛盾之处，应指出矛盾并请求澄清，而不是自行取舍"
- **默认 SubAgent `function.description` 和 `task` 参数描述**同步更新，强调不明确信息将导致拒绝执行

## [0.3.2] - 2026-07-26

### 💥 破坏性变更

- **`EntityRepository` 所有方法改为异步** — `list()`、`read()`、`write()`、`delete()` 现在返回 `Promise`，需 `await`
- **`DraftRepository` 所有方法改为异步** — `read()`、`write()`、`delete()` 需 `await`
- **`ConfigManager` 所有方法改为异步** — `read()`、`write()`、`ensureDirs()`、`ensureDefaultAgent()`、`ensureDefaultSubAgent()`、`ensureDefaultConfig()`、`bootstrap()` 均需 `await`
- **`createAgent()` 恢复为 `async`** — 因底层仓储改为异步，`createAgent(provider, agentId)` 需 `await`
- **`AutoDraftPlugin.checkDraftForRestore()` 改为异步** — 需 `await`

### 🎯 优化

- **全面消除同步文件 IO** — 所有生产代码中的 `existsSync`、`readFileSync`、`writeFileSync`、`readdirSync`、`mkdirSync`、`unlinkSync`、`renameSync` 全部替换为 `fs.promises` 异步 API，避免事件循环阻塞
- **`skillTools.ts` — 工具回调中的 `readdirSync` 替换为 `fs.promises.readdir`**

### ✅ 测试

- 7 个测试文件同步更新为 `async`/`await`，测试辅助函数也使用 `fs.promises`

## [0.3.1] - 2026-07-26

### 💥 破坏性变更

- **`Provider` 移至 `runtime`，合并 `Capabilities`** — 删除 `capabilities/Capabilities.ts` 和原 `runtime/Provider.ts`，Provider 直接暴露 `filter()`、`buildTools()`、`instantiate()`、`refresh()`
- **去除 `getMcpManager()` 方法** — `mcpManager` 从 lazy getter 改为构造时直接 `new McpConnectionManager()`（有 mcpPaths 时），`readonly` 属性
- **字段重命名** — `builtinInstances` → `builtinTools`，`userInstances` → `userTools`，`subagentDefs` → `subagents`
- **`createModel` 签名变更** — 从 `createModel(config, modelId)` 改为 `createModel(provider, modelId)`，调用方不再需要 `.config` 解构
- **`SdkAgent` 去掉 `caps` 字段** — 只保留 `provider`

### 🚀 新功能

- **用户工具 ESM 支持** — 移除 `node:vm` 沙箱，统一使用 `import()` 加载 `.js` / `.mjs` 文件，每次 `refresh()` 加时间戳 querystring 防止缓存
- **`CallbackTool` 替代 `createToolFromObject`** — `{ function, exec }` 格式直接映射为 `CallbackTool`

### 🎯 优化

- **默认 Agent 系统提示词更新** — 精简为五条原则：开动脑筋、实事求是、一切行动听指挥、安全第一、能打胜仗
- **默认 SubAgent `function.description` 优化** — 强调主 Agent 必须提供完整任务上下文

### 🗑 移除

- 删除 `capabilities/Provider.ts`（已移回 `runtime/Provider.ts`）
- 删除 `createToolFromObject` 工具函数
- 删除 `TODO.md`、`TODO2.md`
- 测试 fixture 从 `.js` 迁移为 `.mjs`

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
