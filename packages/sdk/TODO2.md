# TODO2 — Agent 原生插件

## 目标

去掉 `Session` / `SessionBuilder` / `SessionPlugin` 层，改为 **Agent 原生支持插件注册**。

```
之前：createAgent → createSession({ agent }).use(plugin).init()
之后：createAgent → agent.use(plugin) → agent.init()
```

---

## 改造内容

### 1. SdkAgent 增加插件能力

Core `Agent` 保持纯粹不动。插件能力通过 SDK 的 `SdkAgent` 提供，`SdkAgent` 继承 Core `Agent`，在其上增加 `use()` 和 `init()` 方法。

```typescript
// sdk/src/runtime/sdk-agent.ts

class SdkAgent extends Agent {
  private _hooks: AgentHook[] = [];

  use(plugin: AgentPlugin): void {
    this._hooks.push(plugin);
  }

  async init(): Promise<void> {
    for (const hook of this._hooks) {
      await hook.onInit?.();
    }
  }
}

interface AgentPlugin {
  onInit?(): Promise<void>;
  onBeforeSend?(ctx: SendContext): Promise<void>;
  onAfterSend?(ctx: SendContext): Promise<void>;
}

interface SendContext {
  agent: SdkAgent;
  content: string;
  messages: Message[];
}
```

`send()` 流程改为在 `SdkAgent` 中重写：

```
send(content)
  ├─ 遍历 _hooks.onBeforeSend
  ├─ super.send(content)    // 委托 Core Agent
  ├─ 遍历 _hooks.onAfterSend
  └─ 返回 messages
```

### 设计哲学：`init()` 为插件而生

`SdkAgent` 本身没有异步初始化需求——模型、工具、消息在构造时已就绪。`init()` 的存在完全是为了**给插件一个执行异步初始化的机会**。

例如 `autoMigrate` 插件可能需要在初始化时检查草稿，`autoDraft` 可能需要清理过期文件。这些是插件的需求，不是 Agent 的需求。

**`init()` 不是必须调用的**——如果不使用任何插件，可以不调。但建议统一调用以保持一致性。

### 2. SDK 的 useXxx 函数

每个插件改为独立函数，返回 `AgentPlugin`：

```typescript
// sdk/src/plugin/auto-migrate.ts
export function autoMigrate(options: AutoMigrateOptions): AgentPlugin {
  return {
    onInit: async () => { /* ... */ },
    onAfterSend: async (ctx) => { /* ... */ },
  };
}

// sdk/src/plugin/auto-draft.ts
export function autoDraft(): AgentPlugin {
  return {
    onAfterSend: async (ctx) => { /* ... 从 ctx.agent.provider 获取路径 */ },
  };
}

// sdk/src/plugin/auto-refresh-tools.ts
export function autoRefreshTools(): AgentPlugin {
  return {
    onBeforeSend: async (ctx) => { /* ... */ },
  };
}
```

### 3. 删除的文件

- `src/session/session.ts`（SessionImpl, SessionBuilderImpl, createSession）
- `src/session/types.ts`（Session, SessionBuilder, SessionPlugin, SessionContext）
- `src/session/restore.ts`（已删）

### 4. 新增/修改的文件

- `packages/sdk/src/runtime/sdk-agent.ts` — 增加 `use()` / `init()` / 勾子机制
- `packages/sdk/src/plugin/` — 插件目录，每个插件一个文件
- `packages/sdk/src/index.ts` — 导出新插件函数
- `packages/sdk/docs/sdk-design.md` — 更新使用方式

### 5. 消费模式变化

```typescript
// 之前
const agent = await createAgent(runtime, "my-agent");
const session = await createSession({ agent })
  .use(autoMigrate({ maxTokens, migrationAgent, onHandoff }))
  .use(autoDraft({ draftsDir, agentId }))
  .init();
await session.send("你好");

// 之后
const agent = createAgent(provider, "my-agent");
agent.use(autoMigrate({ maxTokens, migrationAgent, onHandoff }));
agent.use(autoDraft());
agent.use(autoRefreshTools());
await agent.init();
await agent.send("你好");
```

### 6. 恢复对话

```typescript
// 之前
const agent = await createAgent(runtime, conv.agentId);
agent.messages.push(...conv.messages);
const session = await createSession({ agent }).use(...).init();

// 之后
const agent = createAgent(provider, conv.agentId);
agent.messages.push(...conv.messages);
agent.use(autoMigrate({ ... }));
agent.use(autoDraft());
await agent.init();
```

---

---

## 附加改动

### Runtime → Provider

`Runtime` 类改名为 `Provider`，文件名 `runtime.ts` → `provider.ts`，相关引用同步更新。

`Runtime` 本质是配置 + 路径 + 模型工厂 + MCP 管理器的集合，是 Agent 所需外部依赖的**提供者**，不存在真正的"运行时"行为。

```typescript
// 之前
const runtime = new Runtime({ config, agentsDir, ... });
const agent = await createAgent(runtime, "my-agent");

// 之后
const provider = new Provider({ config, agentsDir, ... });
const agent = createAgent(provider, "my-agent");
```

### 涉及文件

- `packages/sdk/src/runtime/runtime.ts` → `provider.ts`（类名 + 文件名）
- `packages/sdk/src/runtime/` 下引用 `Runtime` 的各文件
- `packages/sdk/src/index.ts` 导出
- `packages/sdk/docs/sdk-design.md` 文档
- 测试文件中的 `new Runtime(...)`

---

---

## Core 配合改动

### Endpoint 提供同步 `chatCompletion`

当前 `endpoint.chatCompletion(modelName)` 返回 `Promise<ChatCompletionRequestConfig>`，导致 `createModel` 和 `createAgent` 都变成 async。

改为提供同步版本，让 `createModel` / `createAgent` 可以同步执行：

```typescript
// packages/core/src/Endpoint.ts

class Endpoint {
  // 异步（保持不变，用于需要网络请求的场景）
  chatCompletion(modelName: string): Promise<ChatCompletionRequestConfig>;

  // 新增同步版本
  chatCompletionSync(modelName: string): ChatCompletionRequestConfig;
}
```

对于 `OpenAI`、`AzureOpenAI`、`CommonEndpoint` 等实现，`chatCompletion` 本身就是同步构造配置对象再返回，没有真正的异步操作，只是签名上返回了 Promise。直接提供同步版本即可。

### 影响

- `packages/core/src/Endpoint.ts` — 基类增加 `chatCompletionSync`
- `packages/core/src/Endpoints/OpenAI.ts` — 实现同步版本
- `packages/core/src/Endpoints/AzureOpenAI.ts` — 同上
- `packages/sdk/src/runtime/create-model.ts` — `createModel` 改为同步
- `packages/sdk/src/runtime/create-agent.ts` — `createAgent` 改为同步

```typescript
// 之前
const model = await provider.createModel(modelId);
const agent = await createAgent(provider, "my-agent");

// 之后
const model = provider.createModel(modelId);
const agent = createAgent(provider, "my-agent");
```

---

## 实施步骤

| # | 步骤 | 说明 |
|---|------|------|
| 1 | SdkAgent 增加 `use()` / `init()` / 勾子 | 修改 `packages/sdk/src/runtime/sdk-agent.ts` |
| 2 | SDK 创建 `src/plugin/` 目录 | 从 `src/session/` 搬移并改造 |
| 3 | 改造 `autoMigrate` | `SessionPlugin` → `AgentPlugin`，去掉 `SessionContext` 依赖 |
| 4 | 改造 `autoDraft` | 从 `ctx.agent.runtime` 自发现路径，零参数 |
| 5 | 改造 `autoRefreshTools` | 同上 |
| 6 | 删除 `src/session/` | 整个目录 |
| 7 | 更新 `src/index.ts` 导出 | |
| 8 | 更新 `docs/sdk-design.md` | |
| 9 | 更新测试 | |
