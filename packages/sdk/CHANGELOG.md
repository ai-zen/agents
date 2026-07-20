# Changelog

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
