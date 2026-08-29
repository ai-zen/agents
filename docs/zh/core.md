---
title: Core API
description: @ai-zen/agents-core 的公开 API：Agent / AgentContext / Message / Tool / ToolCallContext、内置工具、插件与事件系统。
outline: deep
---

# Core API

`@ai-zen/agents-core` 提供构建 LLM Agent 所需的基础抽象，同时兼容 Node.js 与浏览器。运行时**直接基于官方 `openai` SDK**，不维护内部请求层。

## 安装

```bash
npm install @ai-zen/agents-core
```

## Agent

`Agent` 是核心类，继承 `AgentContext`，管理对话生命周期，支持流式、工具调用与多轮递归对话。

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({ apiKey: "sk-xxx", baseURL: "https://api.openai.com/v1" });
const agent = new Agent({ client, model: "gpt-4o", modelConfig: { temperature: 0.7 } });
agent.append(Message.System("You are an AI assistant."));
await agent.send("Hello.");
```

构造参数继承自 `AgentContext`（见下），其中 `client` 与 `model` 必填。

核心方法：

| 方法 | 说明 |
|------|------|
| `use(plugin)` | 注册一个插件 |
| `init()` | 初始化所有已注册插件（执行各插件 `onInit`） |
| `send(content)` | 发送用户消息，返回对话消息数组 |
| `run(ctx?)` | 驱动一轮对话（内部由 `send` 调用） |
| `abort()` | 中止当前轮所有进行中的内循环任务 |

关键字段：

| 字段 | 说明 |
|------|------|
| `events` | 事件总线（非阻塞通知） |
| `lastUsage` | 最近一次 API 响应的 token 用量 |
| `messages` | 消息列表（继承自 `AgentContext`） |
| `tools` | 工具列表（继承自 `AgentContext`） |

## AgentContext

所有 Agent 的基类，持有核心配置。

```ts
interface AgentContext {
  client: OpenAI;                          // openai SDK 客户端
  model: string;                           // 发送给 API 的模型名
  modelConfig: Record<string, unknown>;    // 模型参数（temperature 等，透传进请求体）
  messages: AgentNS.Message[];             // 消息列表
  tools: Tool[];                           // 工具列表
  allowJsonParseError: boolean;            // 是否允许 JSON 解析错误（默认 true）
}
```

构造签名：`{ client, model, modelConfig?, messages?, tools?, allowJsonParseError? }`。

- `append(message)` —— 追加一条消息并返回它。
- 扩展应通过 **插件**（`agent.use(plugin)`），而非构造钩子。

## Message

用静态工厂方法创建各类角色的消息。

```ts
import { Message } from "@ai-zen/agents-core";

Message.System("You are an assistant.");          // 系统消息
Message.User("Hello");                             // 用户消息（纯文本）
Message.Assistant();                               // 助手消息（默认 Pending，等待 AI 回复）
Message.Tool(toolCall, "执行结果");                 // 工具结果
Message.Function(functionCall, "执行结果");         // 函数结果
```

多模态用户消息（文本 + 图片 / 文件）：

```ts
Message.User([
  { type: "text", text: "What is this?" },
  { type: "image_url", image_url: { url: "https://example.com/img.jpg", detail: "high" } },
]);

Message.User([
  { type: "text", text: "What is in this image?" },
  { type: "file", file_id: "file-api-xxxxxxxxxxxxxxxx" },
]);
```

`MessageStatus` 枚举：`Pending` / `Writing` / `Completed` / `Error` / `Aborted` / `Unknown`。

> 自 core `4.1.0` 起，`AgentNS.Message.id` 为必填。普通对象字面量赋给 `Message` / `Message[]` 将无法编译，请使用上面的工厂方法。

## Tool（抽象基类）

自定义工具继承 `Tool`，在类体声明 `function` 定义并实现 `exec(ctx)`。

```ts
import { Tool, ToolCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  function = {
    name: "get_weather",
    description: "Query the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  };

  async exec(ctx: ToolCallContext) {
    const { city } = ctx.parsedArgs;
    return `The weather in ${city} today is sunny, 22°C.`;
  }
}
```

`exec` 返回 `AgentNS.MessageContent`：可返回字符串（文本），或内容块数组（多模态，如 `image_url` / `file`）。

## 内置工具

| 工具 | 说明 |
|------|------|
| `CallbackTool` | 用回调函数快速定义工具；回调签名 `(parsedArgs, ctx)` |
| `CodeTool` | ⚠️ 已弃用。字符串代码工具（`new Function`），缺少类型安全，保留向后兼容 |
| `AgentTool` | 将子 Agent 暴露为工具；模板消息中的 `{{variable}}` 在调用时替换 |
| `AgentToolLazy` | 与 `AgentTool` 类似，但在执行时经 `buildAgent(parsedArgs, ctx)` 延迟构建子 Agent，避免递归构建问题 |
| `IndexedSearchTool` | 关键词本地搜索工具；自动从条目关键词中提取 enum |

`CallbackTool` 示例：

```ts
import { CallbackTool } from "@ai-zen/agents-core";

const tool = new CallbackTool({
  function: { name: "calculator", description: "Calculate the sum", parameters: { /* ... */ } },
  callback(parsedArgs, ctx) {
    return parsedArgs.a + parsedArgs.b;   // ctx 携带 agent / signal 等
  },
});
```

## ToolCallContext

同一个实例贯穿「拦截决策 → 执行」，`onToolCall` 钩子与 `Tool.exec(ctx)` 接收同一实例。

| 字段 | 说明 |
|------|------|
| `agent` | 触发调用的 Agent |
| `tool_call` | 统一形状的工具调用 `{ id?, type?, function: { name, arguments } }` |
| `tool` | 匹配到的已注册工具（未注册为 `undefined`） |
| `function_call` | 兼容字段，等价于 `tool_call.function` |
| `parsedArgs` | JSON 解析后的参数字典 |
| `resultMessage` | 工具结果消息 |
| `isPreventDefault` | 是否阻止下一轮对话 |
| `parseError` | JSON 解析错误信息 |
| `signal` | 该工具执行的中止信号 |
| `preventDefault()` | 标记停止自动进入下一轮 |

## 插件 —— 唯一的扩展点

```ts
import { Agent, Message } from "@ai-zen/agents-core";
import type { AgentPlugin, SendContext, ToolCallContext, UnknownToolContext } from "@ai-zen/agents-core";

const guard: AgentPlugin = {
  onBeforeSend(ctx: SendContext) {
    if (ctx.content.includes("secret")) return "This content is not allowed.";
  },
  onToolCall(ctx: ToolCallContext) {
    if (ctx.tool_call.function?.name === "rm") return `Tool "rm" is rejected.`;
  },
  onUnknownTool(ctx: UnknownToolContext) {
    return `Tool "${ctx.toolCall.function?.name}" is unavailable.`;
  },
};

agent.use(guard);
await agent.init();
```

### 钩子与其「返回 string」语义

| 钩子 | 入参 | 返回 string 的语义 |
|------|------|---------------------|
| `onInit` | — | 初始化，不短路 |
| `onBeforeSend` | `SendContext` | 拒绝 send（抛错） |
| `onAfterSend` | `SendContext` | 仅短路后续插件 |
| `onInnerLoopStart` | `SendContext` | 中断本轮（抛错） |
| `onInnerLoopEnd` | `SendContext` | 仅短路后续插件 |
| `onInnerLoopsStart` | `SendContext` | 中断整组（抛错） |
| `onInnerLoopsEnd` | `SendContext` | 仅短路后续插件 |
| `onToolCall` | `ToolCallContext` | 拒绝该工具，原因作为工具结果回给 LLM |
| `onUnknownTool` | `UnknownToolContext` | 作为工具结果返回；`undefined` 走默认提示 |

`HookResult = string | void | Promise<string | void>`。多个插件按注册顺序调用，首个返回 string 即短路。

## 事件系统

事件是**非阻塞**通知（不影响流程，需干预请用插件）。事件名采用 **kebab-case**，由 `dispatchHook` 与 `run` 内部发射。

```ts
agent.events.on("before-send", (ctx: SendContext) => {});
agent.events.on("tool-call", (ctx: ToolCallContext) => {});
agent.events.on("unknown-tool", (ctx: UnknownToolContext) => {});

// 流式 / 生命周期
agent.events.on("open", () => {});
agent.events.on("chunk", (chunk) => {});
agent.events.on("chunk-parsed", (receiver, chunk) => {});
agent.events.on("parsed", (receiver) => {});
agent.events.on("error", (error) => {});
agent.events.on("finally", () => {});

// 子 Agent
agent.events.on("sub-agent", ({ agent, ctx }) => {});
agent.events.on("sub-agent-end", ({ agent, ctx }) => {});
```

对应钩子的事件名：`before-send` / `after-send` / `inner-loop-start` / `inner-loop-end` / `inner-loops-start` / `inner-loops-end` / `tool-call` / `unknown-tool`。

## 中止

```ts
agent.abort();  // 中止当前轮所有进行中的内循环任务
```

## 相关文档

- [快速开始](getting-started.md)
- [架构](architecture.md)
- [`packages/core/README.md`](../../packages/core/README.md) —— core 包维护的英文 README（更完整示例）
- [`packages/core/CHANGELOG.md`](../../packages/core/CHANGELOG.md) —— 版本与破坏性变更历史
