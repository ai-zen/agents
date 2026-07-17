# TODO2 — Agent 原生插件 ✅ 已完成

## 目标

去掉 `Session` / `SessionBuilder` / `SessionPlugin` 层，改为 **Agent 原生支持插件注册**。

```
之前：createAgent → createSession({ agent }).use(plugin).init()
之后：createAgent → agent.use(plugin) → agent.init()
```

---

## 改造内容 ✅

### 1. ✅ SdkAgent 增加插件能力

Core `Agent` 保持纯粹不动。插件能力通过 SDK 的 `SdkAgent` 提供，`SdkAgent` 继承 Core `Agent`，在其上增加 `use()` 和 `init()` 方法。

```typescript
// sdk/src/runtime/sdk-agent.ts

class SdkAgent extends Agent {
  private _hooks: AgentPlugin[] = [];

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

### 2. ✅ SDK 的 useXxx 函数

每个插件改为独立函数，返回 `AgentPlugin`：

```typescript
// sdk/src/plugin/auto-migrate.ts
export function autoMigrate(options: AutoMigrateOptions): AgentPlugin {
  return {
    onAfterSend: async (ctx) => { /* ... */ },
  };
}

// sdk/src/plugin/auto-draft.ts
export function autoDraft(options: AutoDraftOptions): AgentPlugin {
  return {
    onAfterSend: async (ctx) => { /* ... 从 ctx.agent.runtime 获取路径 */ },
  };
}

// sdk/src/plugin/auto-refresh-tools.ts
export function autoRefreshTools(): AgentPlugin {
  return {
    onBeforeSend: async (ctx) => { /* ... */ },
  };
}
```

### 3. ✅ 删除的文件

- ~~`src/session/session.ts`~~（SessionImpl, SessionBuilderImpl, createSession）
- ~~`src/session/types.ts`~~（Session, SessionBuilder, SessionPlugin, SessionContext）
- ~~`src/session/auto-migrate.ts`~~（搬迁到 `src/plugin/`）
- ~~`src/session/auto-draft.ts`~~（搬迁到 `src/plugin/`）
- ~~`src/session/auto-refresh-tools.ts`~~（搬迁到 `src/plugin/`）
- ~~`src/session/helpers.ts`~~（搬迁到 `src/plugin/`）
- ~~`src/session/*.test.ts`~~（搬迁到 `src/plugin/`）

### 4. ✅ 新增/修改的文件

- `packages/sdk/src/runtime/sdk-agent.ts` — 增加 `use()` / `init()` / 勾子机制 + `AgentPlugin` / `SendContext` 类型导出
- `packages/sdk/src/runtime/sdk-agent.test.ts` — 新增测试
- `packages/sdk/src/plugin/` — 插件目录，每个插件一个文件
- `packages/sdk/src/index.ts` — 导出更新（移除 session导出，增加 plugin导出）
- `packages/sdk/TODO.md` — 更新状态

### 5. ✅ 消费模式变化

```typescript
// 之前
const agent = await createAgent(runtime, "my-agent");
const session = await createSession({ agent })
  .use(autoMigrate({ maxTokens, migrationAgent, onHandoff }))
  .use(autoDraft({ draftsDir, agentId }))
  .init();
await session.send("你好");

// 之后
const agent = createAgent(runtime, "my-agent");
agent.use(autoMigrate({ maxTokens, migrationAgent, onHandoff }));
agent.use(autoDraft({ draftsDir, agentId }));
agent.use(autoRefreshTools());
await agent.init();
await agent.send("你好");
```

---

## 附加改动（已完成）

### Runtime → Provider ✅ 已完成

`Runtime` 类已改名为 `Provider`（类定义在 `runtime/runtime.ts` 中），`Provider` 本质是配置 + 路径 + 模型工厂 + MCP 管理器的集合，是 Agent 所需外部依赖的**提供者**。

---

## Core 配合改动（待完成）

### Endpoint 提供同步 `chatCompletion`

当前 `endpoint.chatCompletion(modelName)` 返回 `Promise<ChatCompletionRequestConfig>`，导致 `createModel` 和 `createAgent` 都变成 async。

改为提供同步版本，让 `createModel` / `createAgent` 可以同步执行。

### 状态

- `createModel` — ⬜ 待改为同步
- `createAgent` — ⬜ 待改为同步
