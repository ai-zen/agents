# @ai-zen/agents-core

AI Agent 核心框架，提供构建智能代理所需的基础抽象层。支持 Node.js 和浏览器环境。

Agent 运行时是**插件驱动**的，直接构建在 **OpenAI 官方 SDK**（`openai` 包）之上——不再有自研请求层。

## 安装

```bash
npm install @ai-zen/agents-core
```

## 核心概念

### Agent（代理）

`Agent` 是核心类，继承 `AgentContext`，管理对话生命周期，支持流式解析、工具调用、多轮递归对话。

```typescript
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

// 1. 创建 OpenAI SDK client（任何 OpenAI 兼容端点均可通过 baseURL 接入）
const client = new OpenAI({
  apiKey: "sk-xxx",
  baseURL: "https://api.openai.com/v1",
});

// 2. 创建 Agent
const agent = new Agent({
  client,
  model: "gpt-4o",
  modelConfig: { temperature: 0.7 },
});

// 3. 添加系统消息
agent.append(Message.System("你是一个AI助手，请用中文回复。"));

// 4. 发送消息并等待回复
await agent.send("你好，请介绍一下你自己。");

// 5. 获取回复
console.log(agent.messages.at(-1)?.content);
```

`client` 是 `openai` SDK 实例——任何 OpenAI 兼容厂商（OpenAI、DeepSeek、智谱 BigModel、Azure OpenAI 兼容端点等）均可通过 `baseURL` 接入。

### AgentContext（上下文基类）

`AgentContext` 是所有 Agent 的基类，持有以下核心配置：

```typescript
interface AgentContext {
  client: OpenAI;                    // openai SDK client
  model: string;                     // 发送给 API 的模型名
  modelConfig: Record<string, unknown>; // 模型参数（temperature 等），展开进请求体；可含厂商特有字段（如 DeepSeek `thinking`）
  messages: AgentNS.Message[];       // 消息列表
  tools: Tool[];                     // 工具列表
  allowJsonParseError: boolean;      // 是否允许 JSON 解析错误（默认 true）
}
```

- `append(message)` — 追加一条消息并返回
- 扩展方式：通过**插件**（`agent.use(plugin)`），不再提供 `onXxx` 构造钩子

### Message（消息）

使用静态工厂方法创建各种角色的消息：

```typescript
import { Message, AgentNS } from "@ai-zen/agents-core";

// 系统消息
Message.System("你是一个助手。");

// 用户消息（纯文本）
Message.User("你好");

// 用户消息（多模态：文字 + 图片）
Message.User([
  { type: "text", text: "这是什么？" },
  { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
]);

// 用户消息（文字 + 图片，带细节级别：low / high / original / auto）
Message.User([
  { type: "text", text: "读出这张截图里的文字" },
  { type: "image_url", image_url: { url: "https://example.com/img.jpg", detail: "high" } },
]);

// 用户消息（文字 + 通过 Files API 上传的文件，以 file_id 引用）
Message.User([
  { type: "text", text: "这张图片里有什么？" },
  { type: "file", file_id: "file-api-xxxxxxxxxxxxxxxx" },
]);

// 助手消息（默认 Pending 状态，等待 AI 回复）
Message.Assistant();

// 工具调用结果
Message.Tool(toolCall, "执行结果");

// 函数调用结果
Message.Function(functionCall, "执行结果");
```

消息状态枚举：

| 状态 | 说明 |
|------|------|
| `Pending` | 等待处理 |
| `Writing` | AI 正在生成 |
| `Completed` | 已完成 |
| `Error` | 发生错误 |
| `Aborted` | 已中止 |

### Tool（工具基类）

抽象基类，扩展 Agent 的能力。自定义工具需继承 `Tool`，声明 `function` 定义并实现 `exec()` 方法：

```typescript
import { Tool, ToolCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  // 工具定义与实现放在一起（类体字段）
  function = {
    name: "get_weather",
    description: "查询天气",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名" },
      },
      required: ["city"],
    },
  };

  async exec(ctx: ToolCallContext) {
    const { city } = ctx.parsedArgs;
    return `今日${city}天气晴朗，气温22°C。`;
  }
}

// 注册到 Agent
const agent = new Agent({ client, model: "gpt-4o", tools: [new WeatherTool()] });
```

`exec()` 返回 `AgentNS.MessageContent` —— 可以是普通字符串（文本结果），也可以是内容块数组（多模态结果）。返回内容块数组可以让工具把结构化内容回传给模型，例如图片：

```typescript
async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
  // 文本结果
  return `今日${city}天气晴朗。`;

  // 图片/文件结果：模型可直接看到
  return [
    { type: "text", text: "当前截图：" },
    { type: "image_url", image_url: { url: "https://example.com/shot.png" } },
  ];
}
```

### 内置工具

#### CallbackTool（回调工具）
通过回调函数快速定义工具。回调签名 `(parsedArgs, ctx)` —— 通过 `ctx`（`ToolCallContext`）访问 agent、中止信号等。

```typescript
import { CallbackTool } from "@ai-zen/agents-core";

const tool = new CallbackTool({
  function: {
    name: "calculator",
    description: "计算两数之和",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "第一个数" },
        b: { type: "number", description: "第二个数" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  callback(parsedArgs, ctx) {
    // ctx: ToolCallContext —— 如 ctx.agent、ctx.signal、ctx.preventDefault()
    return parsedArgs.a + parsedArgs.b;
  },
});
```

#### CodeTool（代码工具）
> **已废弃** —— 字符串代码工具（`new Function`）缺少类型安全与清晰的参数映射。建议改用 `CallbackTool` 或自定义 `Tool` 子类。为向后兼容保留。

#### AgentTool（子 Agent 工具）
将一个子 Agent 暴露为工具，实现 Agent 嵌套调用。子 Agent 拥有独立的 client、模型、消息列表和工具。

```typescript
import { AgentTool, Message } from "@ai-zen/agents-core";

const tool = new AgentTool({
  function: {
    name: "general_assistant",
    description: "将复杂任务交给通用助手处理",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "要处理的任务" },
      },
      required: ["task"],
    },
  },
  client,           // 可复用主 Agent 的 client，或使用独立 client
  model: "gpt-4o",  // 子 Agent 的模型名
  messages: [
    Message.System("你是一个通用助手，擅长独立完成各类任务。"),
    Message.User("请完成以下任务：{{task}}"), // {{变量}} 会被调用时替换
  ],
  tools: [], // 子 Agent 可使用的工具列表
});
```

> **注意**：AgentTool 的消息列表最后一条必须是 User 消息，其中可使用 `{{变量名}}` 占位符，调用时会被 `parsedArgs` 自动替换。

#### AgentToolLazy（延迟构建子 Agent 工具）
与 AgentTool 类似，但子 Agent 不在构造时创建，而是在执行时通过 `buildAgent(parsedArgs, ctx)` 回调延迟构建。可避免构建工具列表时的递归创建问题（SubAgent → 构建工具列表 → SubAgent → …）。

```typescript
import { AgentToolLazy, Agent, Message } from "@ai-zen/agents-core";

const tool = new AgentToolLazy({
  function: { /* ... */ },
  messages: [Message.System("..."), Message.User("...")],
  async buildAgent(parsedArgs, ctx) {
    // ctx.agent 可访问父 Agent
    return new Agent({
      client: ctx.agent.client,
      model: parsedArgs.model ?? "gpt-4o",
      tools: [/* ... */],
    });
  },
});
```

#### IndexedSearchTool（索引搜索工具）
基于关键词索引的本地搜索工具，自动从 entries 提取关键词作为 enum。

```typescript
import { IndexedSearchTool } from "@ai-zen/agents-core";

const tool = new IndexedSearchTool({
  entries: [
    { keywords: ["价格", "费用"], text: "本产品价格为99元/月" },
    { keywords: ["售后", "保修"], text: "产品提供一年免费保修" },
  ],
});
```

### 插件——唯一的扩展方式

`AgentContext` 不再提供任何 `onXxx` 构造钩子，**插件是扩展 Agent 的唯一途径**。通过 `agent.use(plugin)` 注册插件，然后 `await agent.init()`。

```typescript
import { Agent, Message } from "@ai-zen/agents-core";
import type { AgentPlugin, SendContext, ToolCallContext, UnknownToolContext } from "@ai-zen/agents-core";

const guard: AgentPlugin = {
  // 发送前触发；返回 string 拒绝本次发送（抛错）
  onBeforeSend(ctx: SendContext) {
    if (ctx.content.includes("secret")) {
      return "该内容不允许发送。";
    }
  },

  // 每个工具调用执行前触发；返回 string 拒绝该工具（原因回给 LLM）
  onToolCall(ctx: ToolCallContext) {
    if (ctx.tool_call.function?.name === "rm") {
      return `工具 "rm" 被拒绝：需要用户明确授权。`;
    }
    // undefined = 放行
  },

  // LLM 调用未注册工具时触发；返回 string 作为工具结果
  onUnknownTool(ctx: UnknownToolContext) {
    return `工具 "${ctx.toolCall.function?.name}" 不可用。`;
  },
};

const agent = new Agent({ client, model: "gpt-4o", tools: [weatherTool] });
agent.use(guard);
await agent.init();
```

#### AgentPlugin 钩子

| 钩子 | 入参 | 返回 string 的语义 |
|------|------|---------------------|
| `onInit` | — | 初始化，不短路 |
| `onBeforeSend` | `SendContext` | 拒绝本次 send（抛错中断） |
| `onAfterSend` | `SendContext` | 仅短路后续插件 |
| `onInnerLoopStart` | `SendContext` | 中断本轮（抛错） |
| `onInnerLoopEnd` | `SendContext` | 仅短路后续插件 |
| `onInnerLoopsStart` | `SendContext` | 中断整组（抛错） |
| `onInnerLoopsEnd` | `SendContext` | 仅短路后续插件 |
| `onToolCall` | `ToolCallContext` | 拒绝该工具，原因作为工具结果回给 LLM |
| `onUnknownTool` | `UnknownToolContext` | 作为工具结果返回；`undefined` 走默认提示 |

#### HookResult —— 统一的短路语义

所有钩子统一返回 `HookResult = string | void | Promise<string | void>`：

- **string** → 短路（拒绝 / 中断 / 提供结果，语义见上表）
- **undefined / void** → 放行（继续后续插件或默认行为）

多个插件按注册顺序调用，任一返回字符串即短路。

#### dispatchHook —— 事件 + 插件的统一入口

内部每个钩子都经过 `dispatchHook`：先发出**非阻塞**的 kebab-case 事件（`agent.events`），再**阻塞**调用插件钩子。因此可以通过事件观察（非阻塞、不影响流程），也可以通过插件干预（阻塞、可短路）。

事件名：`before-send` / `after-send` / `inner-loop-start` / `inner-loop-end` / `inner-loops-start` / `inner-loops-end` / `tool-call` / `unknown-tool`。

**未知工具兜底**：Agent 内置返回简单文本提示；更智能的提示通过 `onUnknownTool` 插件提供（如 SDK 的 `UnknownToolHintPlugin` 提供 MCP 引导，由调用方显式注册）。插件优先级最高；插件返回 undefined 时回落到内置提示。

### ToolCallContext（工具调用上下文）

一个类贯穿**拦截决策 → 执行**：同一个实例既传给 `onToolCall` 钩子（执行前拦截），也传给 `Tool.exec(ctx)`（真正执行）。

| 属性 | 说明 |
|------|------|
| `agent` | 触发调用的 Agent 实例 |
| `tool_call` | 统一形状的工具调用（`{ id?, type?, function: { name, arguments } }`） |
| `tool` | 匹配到的已注册工具（未注册则为 undefined） |
| `function_call` | 兼容字段，等价于 `tool_call.function`（旧版形状） |
| `parsedArgs` | JSON 解析后的参数字典 |
| `resultMessage` | 工具结果消息 —— 执行结果 / 拒绝原因 / 解析错误均写入此处 |
| `isPreventDefault` | 是否阻止后续自动继续对话 |
| `parseError` | JSON 解析错误信息（当 `allowJsonParseError=true` 时） |
| `signal` | 本次工具执行的中止信号（`abort()` 时触发；工具可监听以真正中断执行） |
| `preventDefault()` | 标记阻止自动继续下一轮对话 |

## Agent 运行机制

### 对话流程

```
send(content)
  ├── onBeforeSend 钩子 → 可拒绝
  ├── 追加 User 消息
  └── run()
        ├── onInnerLoopsStart 钩子（一次 send 仅一次）
        ├── 内循环（工具调用持续则重复）
        │     ├── 开头追加 Assistant 占位（Pending）
        │     ├── onInnerLoopStart 钩子（每次请求前）
        │     ├── client.chat.completions.create(...) — 官方 SDK 流式请求
        │     ├── parseStreamData() → content / reasoning_content / tool_calls
        │     ├── handleToolCall() → 执行工具调用
        │     │     ├── onToolCall 拦截钩子 → 可拒绝
        │     │     ├── onUnknownTool 插件（可提供提示）→ 内置兜底
        │     │     └── Tool.exec(ctx) 执行匹配工具
        │     └── onInnerLoopEnd 钩子
        ├── onInnerLoopsEnd 钩子
        └── 返回 this.messages
  └── onAfterSend 钩子
```

### 工具调用处理

- 当模型返回 `tool_calls` 时，Agent 自动（并行）执行对应工具
- 工具执行结果作为 Tool 角色消息追加到消息列表
- 如果所有工具执行成功且未调用 `preventDefault()`，Agent 自动开启新一轮对话（将结果回传给模型）
- 如果 `allowJsonParseError = true`（默认），参数解析失败时会自动将错误信息返回给 AI 修正
- 未注册的工具依次经过 `onUnknownTool` 插件（返回字符串即作为工具结果），最终兜底简单内置提示

### 事件系统

Agent 提供事件总线。事件是**非阻塞通知**（不影响流程——要干预请用插件）：

```typescript
// 生命周期事件（payload = 对应钩子的 ctx）
agent.events.on("before-send", (ctx: SendContext) => {});
agent.events.on("after-send", (ctx: SendContext) => {});
agent.events.on("inner-loop-start", (ctx: SendContext) => {});
agent.events.on("inner-loop-end", (ctx: SendContext) => {});
agent.events.on("inner-loops-start", (ctx: SendContext) => {});
agent.events.on("inner-loops-end", (ctx: SendContext) => {});
agent.events.on("tool-call", (ctx: ToolCallContext) => {});
agent.events.on("unknown-tool", (ctx: UnknownToolContext) => {});

// 流式 / 生命周期事件
agent.events.on("open", () => {});                       // 连接已建立
agent.events.on("chunk", (chunk) => {});                 // 原始流式 chunk
agent.events.on("chunk-parsed", (receiver, chunk) => {});// chunk 合并进 receiver 消息后
agent.events.on("parsed", (receiver) => {});             // 完整响应解析完成
agent.events.on("error", (error) => {});                 // 发生错误
agent.events.on("finally", () => {});                    // 运行结束（无论成功或失败）

// 子 Agent 事件
agent.events.on("sub-agent", ({ agent, ctx }) => {});    // AgentTool 子 Agent 启动
agent.events.on("sub-agent-end", ({ agent, ctx }) => {});// 子 Agent 结束
```

### 中止

```typescript
agent.abort(); // 中止当前轮所有进行中的内循环任务
```

## 更多示例

### 带工具的多轮对话

```typescript
const agent = new Agent({
  client,
  model: "gpt-4o",
  tools: [new WeatherTool(), new CalculatorTool()],
  allowJsonParseError: true, // 允许 AI 参数格式错误时自动修正
});

// 添加系统提示
agent.append(Message.System("你是一个天气助手，可以使用工具查询天气。"));

// 发送消息，Agent 会自动处理工具调用和多轮对话
await agent.send("北京和上海今天天气怎么样？");
```

## 测试

```bash
pnpm test
```

## 许可

MIT
