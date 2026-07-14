# TODO2

> 从 CLI 使用视角推演发现的 SDK 缺口。这些不是设计文档中的缺失功能，而是实际接入时暴露的问题。

---

## 背景

CLI 当前未接入 SDK，自己实现了一套 Agent 创建、工具发现、draft 保存、任务迁移逻辑（见 `packages/cli/src/conversation-runner.ts`、`agent-creator.ts`、`draft.ts`）。

SDK 的目标是让 CLI 变成这样：

```ts
const resolved = resolveAgent(...);          // SDK: 加载定义 + 发现候选 + 装配
const coreAgent = new Agent({...});          // Core: 用 ResolvedAgent 构造实例
const session = await createSession({ agent: coreAgent, model: resolved.model })
  .use(autoMigrate({ maxTokens, migrationAgent, onHandoff }))
  .use(autoDraft({ draftsDir, agentId }))
  .init();

// 绑定 UI 事件
session.agent.events.on("chunk", renderChunk);
session.agent.events.on("sub-agent", renderSubAgent);

// 对话循环
while (running) {
  await session.send(userInput);
}
```

---

## 缺口

### 1. ~~Agent 替换后事件丢失~~ ✅ 已完成

> `AutoMigrateOptions.onHandoff` 签名从 `(handoffDoc: string)` 扩展为 `(handoffDoc: string, oldAgent: Agent, newAgent: Agent)`。
> CLI 在回调中解绑旧 Agent 事件、重绑到新 Agent。新增测试验证此场景。

---

### 2. ~~缺少 onBeforeSend 钩子~~ ✅ 已完成

> `SessionPlugin` 增加 `beforeSend?(ctx: SessionContext): Promise<void>` 钩子。
> `send()` 流程变为：`beforeSend → agent.send() → afterRun`。
> CLI 可实现 `refreshTools` 插件在每次 send 前刷新工具列表。

---

### 3. ~~shouldMigrate 过度依赖 usage.prompt_tokens~~（已决策：不做）

> 之后一律以 API 返回的 `usage.prompt_tokens` 为准，不需要字符估算 fallback。

---

### 4. ResolvedAgent → Core Agent 缺少便捷桥接

**问题**：SDK 的 `createAgent` / `resolveAgent` 产出纯数据 `ResolvedAgent`，但 `ResolvedAgent.capabilities.tools` 存的是工具名称字符串（`string[]`），不是 Core 的 `Tool` 实例。上层（CLI/Desktop）需要自己把工具名映射到实际的工具实例、创建 model、创建 Core Agent。

这不是 bug，但每个消费者都要写一遍相同的样板代码。

**建议方案**：SDK 不越界创建 Core Agent 实例（保持边界清晰），但可以在文档中提供示例代码，或者提供一个轻量的 `buildCoreAgentInput(resolved: ResolvedAgent)` 辅助函数，返回构造 `new Agent()` 所需的所有参数。

---

## 优先级

| # | 缺口 | 影响 | 建议优先级 |
|---|------|------|:--:|
| 1 | Agent 替换后事件丢失 | CLI 迁移后 UI 渲染断裂 | **P0** |
| 2 | 无 beforeSend 钩子 | 新增工具需要重启才能识别 | **P1** |
| 3 | ~~shouldMigrate 无 fallback~~ | 已决策：一律以 API 返回为准 | — |
| 4 | 缺少便捷桥接 | 每个消费者写样板代码 | P2 |
