# @ai-zen/agents-core

AI Agent 核心框架，提供构建智能代理所需的基础抽象层。

## 安装

```bash
npm install @ai-zen/agents-core
```

## 核心概念

### Agent（代理）

`Agent` 是核心类，管理对话生命周期：

```typescript
import { Agent, Message, AgentNS } from "@ai-zen/agents-core";

const agent = new Agent({
  model: chatCompletionModel,
});

// 添加系统消息
agent.append(Message.System("你是一个AI助手，请用中文回复。"));

// 发送用户消息并获取回复
await agent.send("你好，请介绍一下你自己。");

// 输出回复内容
console.log(agent.messages.at(-1)?.content);
```

### Message（消息）

使用静态工厂方法创建各种角色的消息：

```typescript
// 系统消息
Message.System("你是一个助手。");

// 用户消息
Message.User("你好");
Message.User([{ type: "text", text: "这是什么？" },
              { type: "image_url", image_url: { url: "https://..." } }]);

// 助手消息（默认 Pending 状态，等待 AI 回复）
Message.Assistant();

// 工具调用结果
Message.Tool(toolCall, "执行结果");

// 函数调用结果
Message.Function(functionCall, "执行结果");
```

### Tool（工具）

抽象基类，扩展 Agent 的能力：

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

#### CallbackTool
通过回调函数快速定义工具：

```typescript
import { CallbackTool } from "@ai-zen/agents-core";

const tool = new CallbackTool({
  function: {
    name: "calculator",
    description: "计算器",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
    },
  },
  callback: (args) => args.a + args.b,
});
```

#### CodeTool
使用字符串代码定义工具逻辑：

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
    },
  },
  code: "return a + b;",
});
```

#### AgentTool
将一个子 Agent 暴露为工具，实现 Agent 嵌套调用：

```typescript
import { AgentTool } from "@ai-zen/agents-core";

const tool = new AgentTool({
  function: {
    name: "search",
    description: "搜索信息",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
  },
  model: chatModel,
  messages: [
    Message.System("你是搜索助手。"),
    Message.User("请搜索：{{query}}"),
  ],
});
```

#### IndexedSearchTool
基于关键词索引的本地搜索工具：

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

定义 API 连接方式：

```typescript
import { OpenAI, AzureOpenAI, Zhipu, CommonEndpoint } from "@ai-zen/agents-core";

// OpenAI 标准接口
const endpoint = new OpenAI({
  apiKey: "sk-xxx",
  baseUrl: "https://api.openai.com/v1",
});

// 构建请求
const requestConfig = await endpoint.chatCompletion("gpt-4");
```

### Model（模型）

```typescript
import { ChatGPT } from "@ai-zen/agents-core";
import { Models } from "@ai-zen/agents-core";

// 直接使用
const model = new ChatGPT({
  endpoint: myEndpoint,
  model_config: { max_tokens: 2048 },
});

// 通过模型注册表查找
const model = new Models.ChatGPT({ endpoint });
```

### RAG（检索增强生成）

通过改写用户消息注入上下文信息：

```typescript
import { Rag } from "@ai-zen/agents-core";

class MyRag extends Rag {
  async rewrite(questionMessage, messages) {
    const context = await fetchExternalData(questionMessage.content);
    questionMessage.content = `参考信息：${context}\n\n用户问题：${questionMessage.content}`;
  }
}

const agent = new Agent({ model, rag: new MyRag() });
```

### VectorDatabase（向量数据库）

基于余弦相似度的内存向量检索：

```typescript
import { VectorDatabase, KnowledgeBase } from "@ai-zen/agents-core";

const db = new VectorDatabase();
db.insert({ vector: [0.1, 0.2, 0.3], title: "示例", text: "..." });
const results = db.search(targetVector, topN = 5, minScore = 0.5);

// 或使用 KnowledgeBase（自动集成 EmbeddingModel）
const kb = new KnowledgeBase({ model: embeddingModel });
```

## 事件系统

Agent 提供事件总线，可监听运行过程中的关键节点：

```typescript
agent.events.on("run", (messages, tools) => { /* 开始运行 */ });
agent.events.on("open", () => { /* 连接已建立 */ });
agent.events.on("chunk", (chunk) => { /* 收到流式数据块 */ });
agent.events.on("chunk-parsed", (message, chunk) => { /* 数据块解析完成 */ });
agent.events.on("parsed", (message) => { /* 完整响应解析完成 */ });
agent.events.on("error", (error) => { /* 发生错误 */ });
agent.events.on("finally", () => { /* 运行结束 */ });
agent.events.on("sub-agent", ({ agent, ctx }) => { /* 子 Agent 启动 */ });
agent.events.on("sub-agent-end", ({ agent, ctx }) => { /* 子 Agent 结束 */ });
```

## 测试

```bash
pnpm test
```

## 许可

ISC
