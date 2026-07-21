# @ai-zen/agents-core

AI Agent 核心框架，提供构建智能代理所需的基础抽象层。支持 Node.js 和浏览器环境。

## 安装

```bash
npm install @ai-zen/agents-core
```

## 核心概念

### Agent（代理）

`Agent` 是核心类，继承 `AgentContext`，管理对话生命周期，支持流式解析、工具调用、多轮递归对话。

```typescript
import { Agent, Message, ChatGPT, OpenAI } from "@ai-zen/agents-core";

// 1. 创建端点
const endpoint = new OpenAI({
  api_key: "sk-xxx",
  openai_endpoint: "https://api.openai.com/v1",
});

// 2. 创建模型
const model = new ChatGPT({
  request_config: await endpoint.chatCompletion("gpt-4"),
  model_config: { temperature: 0.7 },
});

// 3. 创建 Agent
const agent = new Agent({ model });

// 4. 添加系统消息
agent.append(Message.System("你是一个AI助手，请用中文回复。"));

// 5. 发送消息并等待回复
await agent.send("你好，请介绍一下你自己。");

// 6. 获取回复
console.log(agent.messages.at(-1)?.content);
```

### AgentContext（上下文基类）

`AgentContext` 是所有 Agent 的基类，持有以下核心配置：

```typescript
interface AgentContext {
  model: ChatCompletionModel;      // 对话模型
  model_config: any;               // 模型参数
  messages: AgentNS.Message[];     // 消息列表
  tools: Tool[];                   // 工具列表
  rag?: Rag;                       // RAG 检索增强
  allowJsonParseError: boolean;    // 是否允许 JSON 解析错误（默认 true）
}
```

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

抽象基类，扩展 Agent 的能力。自定义工具需继承 `Tool` 并实现 `exec()` 方法：

```typescript
import { Tool, FunctionCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  constructor() {
    super({
      function: {
        name: "get_weather",
        description: "查询天气",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "城市名" },
          },
          required: ["city"],
        },
      },
    });
  }

  async exec(ctx: FunctionCallContext) {
    const { city } = ctx.parsed_args;
    return `今日${city}天气晴朗，气温22°C。`;
  }
}

// 注册到 Agent
const agent = new Agent({ model, tools: [new WeatherTool()] });
```

### 内置工具

#### CallbackTool（回调工具）
通过回调函数快速定义工具。`callback` 中的 `this` 指向 `FunctionCallContext` 实例。

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
  callback(parsedArgs) {
    // this 指向 FunctionCallContext
    return parsedArgs.a + parsedArgs.b;
  },
});
```

#### CodeTool（代码工具）
使用字符串代码定义工具逻辑，通过 `new Function` 动态执行。参数名需与 `parameters.properties` 的键一致。

```typescript
import { CodeTool } from "@ai-zen/agents-core";

const tool = new CodeTool({
  function: {
    name: "add",
    description: "两数相加",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
  code: "return a + b;", // 代码中可直接使用 a, b 作为变量
});
```

#### AgentTool（子 Agent 工具）
将一个子 Agent 暴露为工具，实现 Agent 嵌套调用。子 Agent 拥有独立的模型、消息列表和工具。

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
  model: chatModel, // 可复用主 Agent 的模型，或使用独立模型
  messages: [
    Message.System("你是一个通用助手，擅长独立完成各类任务。"),
    Message.User("请完成以下任务：{{task}}"), // {{变量}} 会被调用时替换
  ],
  tools: [], // 子 Agent 可使用的工具列表
});
```

> **注意**：AgentTool 的消息列表最后一条必须是 User 消息，其中可使用 `{{变量名}}` 占位符，调用时会被 `parsed_args` 自动替换。

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

### Endpoint（端点）

定义 API 连接方式，负责构建 HTTP 请求的 URL、Headers 和 Body。

```typescript
import { OpenAI, AzureOpenAI, CommonEndpoint } from "@ai-zen/agents-core";

// OpenAI 标准接口
const endpoint = new OpenAI({
  api_key: "sk-xxx",
  openai_endpoint: "https://api.openai.com/v1",  // 可选，默认 https://api.openai.com/v1/
  organization: "org-xxx",                         // 可选
  headers: { "X-Custom": "value" },                // 可选额外请求头
  body: { user: "user-id" },                       // 可选额外请求体字段
});

// Azure OpenAI
const azureEndpoint = new AzureOpenAI({
  azure_endpoint: "https://xxx.openai.azure.com",
  api_key: "xxx",
  api_version: "2024-02-15-preview",
});

// 通用端点（任意 OpenAI 兼容接口）
const commonEndpoint = new CommonEndpoint({
  url: "https://your-api.com/v1/chat/completions",
  headers: { Authorization: "Bearer sk-xxx" },
});

// 构建请求
const config = await endpoint.chatCompletion("gpt-4");
// config.url => "https://api.openai.com/v1/chat/completions"
// config.headers => { "Content-Type": "application/json", "Authorization": "Bearer sk-xxx", ... }
// config.body => { model: "gpt-4", ... }
```

**内置端点**：

| 类 | 静态属性 `title` | 说明 |
|------|------|------|
| `OpenAI` | `"OpenAI"` | OpenAI 标准接口，也兼容任何 OpenAI 格式的 API |
| `AzureOpenAI` | `"Azure OpenAI"` | Azure OpenAI 服务，注意第二个参数是部署名而非模型名 |
| `CommonEndpoint` | `"Common"` | 通用端点，直接指定完整 URL，极少定制 |
| `Zhipu` | `"Zhipu"` | 智谱AI（已废弃，建议使用 OpenAI 兼容接口方式接入） |

### Model（模型）

#### ChatCompletionModel（对话模型）
```typescript
import { ChatGPT } from "@ai-zen/agents-core";

const model = new ChatGPT({
  model_config: {
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  },
  request_config: await endpoint.chatCompletion("gpt-4"),
});

// 流式生成
const stream = model.createStream({
  messages: [{ role: "user", content: "你好" }],
  tools: [],
  onOpen: () => console.log("连接已建立"),
  onError: (err) => console.error(err),
  onFinally: () => console.log("完成"),
});

for await (const chunk of stream) {
  console.log(chunk.choices?.[0]?.delta?.content);
}

// 非流式生成
const response = await model.createCompletion({
  messages: [{ role: "user", content: "你好" }],
  tools: [],
});
```

属性标记（用于判断能力）：

| 属性 | 说明 |
|------|------|
| `IS_SUPPORT_FUNCTION_CALL` | 是否支持函数调用（旧版） |
| `IS_SUPPORT_TOOLS_CALL` | 是否支持工具调用（新版） |
| `IS_SUPPORT_IMAGE_CONTENT` | 是否支持图片输入 |
| `INPUT_MAX_TOKENS` | 最大输入 Token 数 |
| `OUTPUT_MAX_TOKENS` | 最大输出 Token 数 |

#### EmbeddingModel（嵌入模型）
```typescript
import { TextEmbeddingAda002_2 } from "@ai-zen/agents-core";

const model = new TextEmbeddingAda002_2({
  request_config: await endpoint.embedding("text-embedding-ada-002"),
});

const vector = await model.createEmbedding("要嵌入的文本");
// 返回 number[]，维度 1536
```

#### ImageGenerationModel（图片生成模型）
```typescript
import { ZhipuImage } from "@ai-zen/agents-core";

const model = new ZhipuImage({
  request_config: await endpoint.imageGeneration("cogview-4"),
});

const result = await model.generate({
  prompt: "一只可爱的猫咪",
  size: "1024x1024",
  quality: "hd",
});
// result.data => [{ url: "https://..." }, ...]
```

### 模型注册表

通过 `Models` 对象可引用所有内置模型类：

```typescript
import { Models } from "@ai-zen/agents-core";
// Models.ChatGPT
// Models.TextEmbeddingAda002_2
// Models.ZhipuImage
```

### RAG（检索增强生成）

通过改写用户消息注入上下文信息，增强模型回答质量。

```typescript
import { Rag } from "@ai-zen/agents-core";

class MyRag extends Rag {
  async rewrite(questionMessage, messages) {
    const context = await fetchExternalData(questionMessage.content);
    // 改写用户消息，注入参考信息
    Message.rewrite(
      questionMessage,
      `参考信息：${context}\n\n用户问题：${questionMessage.content}`
    );
  }
}

const agent = new Agent({ model, rag: new MyRag() });
```

内置实现 `EmbeddingSearch`：通过嵌入向量检索知识库，将匹配的参考文本注入到用户问题中：

```typescript
import { EmbeddingSearch, KnowledgeBase } from "@ai-zen/agents-core";

const rag = new EmbeddingSearch({
  knowledge_bases: [knowledgeBaseInstance],
});
```

### VectorDatabase（向量数据库）

基于余弦相似度的内存向量检索：

```typescript
import { VectorDatabase } from "@ai-zen/agents-core";

interface MyRecord {
  vector: number[];
  title: string;
  text: string;
}

const db = new VectorDatabase<MyRecord>();
db.insert({ vector: [0.1, 0.2, 0.3], title: "示例", text: "..." });

const results = db.search(targetVector, topN = 5, minScore = 0.5);
```

### KnowledgeBase（知识库）

自动集成嵌入模型和向量数据库：

```typescript
import { KnowledgeBase } from "@ai-zen/agents-core";

const kb = new KnowledgeBase({
  model: embeddingModel,
  data: [
    { vector: [...], title: "文档1", text: "内容1" },
  ],
});

const results = kb.search(targetVector, topN = 5, minScore = 0.8);
```

### 生命周期钩子

Agent 提供多个生命周期钩子，可在运行时自定义行为。

```typescript
const agent = new Agent({
  model,
  // 每次内循环开始前触发，可用于刷新工具定义、RAG 等
  onInnerLoopStart: () => {
    console.log("内循环开始");
  },
  // 每次内循环结束后触发，可用于后处理
  onInnerLoopEnd: () => {
    console.log("内循环结束");
  },
  // 当 LLM 调用一个未注册的工具时触发
  onUnknownTool: (ctx) => {
    return `工具 "${ctx.toolCall.function?.name}" 不可用。`;
  },
});
```

#### onUnknownTool — 未知工具处理钩子

当 LLM 调用了一个 Agent 未注册的工具时，`onUnknownTool` 钩子被触发。

**签名**：
```typescript
onUnknownTool?: (ctx: UnknownToolContext) => string | Promise<string>;

interface UnknownToolContext {
  toolCall: AgentNS.ToolCall;    // LLM 发出的工具调用请求
  availableTools: Tool[];        // 当前注册的所有工具列表（浅拷贝）
}
```

**返回值**：返回的字符串将作为工具执行结果返回给 LLM。

**默认行为**：不设置时，返回固定提示 `"未知工具: {name}，没有找到对应的工具实现。"`。

**使用场景**：
- 自定义错误提示，提供更有用的上下文信息
- 根据可用工具列表向 LLM 推荐类似工具
- 异步记录审计日志或调用外部监控服务

**示例**：
```typescript
// 同步用法 — 推荐可用工具
const agent = new Agent({
  model,
  tools: [weatherTool, calculatorTool],
  onUnknownTool: (ctx) => {
    const names = ctx.availableTools.map(t => t.function.name).join(", ");
    return `抱歉，工具 "${ctx.toolCall.function?.name}" 不可用。当前可用的工具有: [${names}]。`;
  },
});

// 异步用法 — 记录审计日志
const agent = new Agent({
  model,
  tools: [fileReadTool],
  onUnknownTool: async (ctx) => {
    await auditService.log({
      event: "unknown_tool_call",
      toolName: ctx.toolCall.function?.name,
      timestamp: new Date(),
    });
    return `工具 "${ctx.toolCall.function?.name}" 不存在，操作已记录。`;
  },
});
```

### FunctionCallContext（函数调用上下文）

工具执行时的上下文对象，包含以下属性：

| 属性 | 说明 |
|------|------|
| `agent` | 触发调用的 Agent 实例 |
| `function_call` | 原始函数调用信息（name, arguments） |
| `parsed_args` | JSON 解析后的参数字典 |
| `result_message` | 用于写入执行结果的消息 |
| `is_prevent_default` | 是否阻止后续自动继续对话 |
| `parse_error` | JSON 解析错误信息（当 `allowJsonParseError=true` 时） |
| `preventDefault()` | 标记阻止自动继续下一轮对话 |

## Agent 运行机制

### 对话流程

```
send(content)
  ├── 创建 User 消息并追加到消息列表
  ├── 创建 Assistant 消息（Pending 状态）
  ├── RAG.rewrite() 改写用户问题
  └── run()
        ├── formatHistory() → 过滤并格式化消息
        ├── formatTools() → 格式化工具定义
        ├── 触发 "run" 事件
        ├── model.createStream() → 流式请求
        ├── parseStreamData() → 解析流式响应（content/reasoning/tool_calls）
        ├── 触发 "chunk" / "chunk-parsed" / "parsed" 事件
        ├── handleToolCall() → 执行工具调用
        │     ├── 遍历 tool_calls / function_call
        │     ├── 创建 Tool 或 Function 结果消息
        │     ├── 实例化 FunctionCallContext
        │     ├── 执行对应工具的 exec()
        │     └── 返回是否需要继续对话
        └── 若需要继续 → 追加新的 Assistant 消息 → 递归 run()
```

### 工具调用处理

- 当模型返回 `tool_calls` 或 `function_call` 时，Agent 自动执行对应工具
- 工具执行结果作为 Tool/Function 角色消息追加到消息列表
- 如果所有工具执行成功且未调用 `preventDefault()`，Agent 自动开启新一轮对话（将结果回传给模型）
- 如果 `allowJsonParseError = true`（默认），参数解析失败时会自动将错误信息返回给 AI 修正

### 事件系统

Agent 提供事件总线，可监听运行过程中的关键节点：

```typescript
// 开始运行（携带格式化的消息和工具列表）
agent.events.on("run", (messages, tools) => {});

// 流式连接已建立
agent.events.on("open", () => {});

// 收到流式数据块（原始 chunk）
agent.events.on("chunk", (chunk: AgentNS.StreamResponseData) => {});

// 数据块解析完成（合并到 receiver 消息后）
agent.events.on("chunk-parsed", (receiver, chunk) => {});

// 完整响应解析完成
agent.events.on("parsed", (receiver) => {});

// 发生错误
agent.events.on("error", (error) => {});

// 运行结束（无论成功或失败）
agent.events.on("finally", () => {});

// 子 Agent 启动（AgentTool 执行时）
agent.events.on("sub-agent", ({ agent, ctx }) => {});

// 子 Agent 结束
agent.events.on("sub-agent-end", ({ agent, ctx }) => {});
```

### 中止

```typescript
agent.abort(); // 中止所有待处理的对话
```

## 更多示例

### 带工具的多轮对话

```typescript
const agent = new Agent({
  model,
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

ISC
