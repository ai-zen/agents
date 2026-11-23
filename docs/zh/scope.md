---
title: 只用 core 与 Scope
description: 不装 AgentRuntime、不碰宿主：Scope 只要一个取配置的函数、一个AgentDefinition目录与一个 cwd，插件由调用方显式装上；配 createAgent 就能跑一轮。
outline: deep
---

# 只用 core 与 Scope

`Scope` 是能力那一层的容器，它不依赖 `AgentRuntime`，也不依赖宿主。要的东西只有三样：一个取配置的函数、一个AgentDefinition目录、一个 `cwd`。插件必须显式装上 —— `Scope` 自己不装任何默认插件。

这段代码跑通过：假端点（`@ai-zen/fake-llm`）当模型侧，一份常量配置当 `config.json`，一个定义文件当AgentDefinition，结果是最后那条 `assistant` 消息的 `content` 就是假端点说的那句。

```ts
import { Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

// 配置从哪里来由调用方定：这里是常量，也可以读 config.json、查库、或者别处算出来。
// 给函数而不是给一份快照：`scope.refresh()` 要能现读到「当下这一份」。
const config = {
  endpoints: [{ id: "local", name: "Local", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "..." }],
  models: [{ id: "m1", name: "M1", endpointId: "local", modelName: "gpt-4o-mini" }],
  defaultAgent: "writer",
};

const scope = new Scope({
  getConfig: () => config,
  agentsDir: "/path/to/agents", // 一个定义一个文件：<agentsDir>/<id>.json
  cwd: "/path/to/project",
}).use(...allInOne());

await scope.init();

// 一次性：跑一句、等到闲、关门，交回这一次跑出来的消息
const agent = await createAgent(scope, "writer", { lifetime: "one-shot" });
const messages = await agent.runOnce({
  content: "在吗",
  priority: "low",
  source: { kind: "user" },
});
console.log(messages.at(-1)?.content);

await scope.dispose();
```

`<agentsDir>/writer.json` 是一份定义：

```json
{
  "id": "writer",
  "name": "Writer",
  "messages": [{ "role": "system", "content": "Answer in one sentence." }],
  "modelId": "m1",
  "permissions": { "tools": { "allow": ["*"] } }
}
```

`permissions` 不能省。没写它就等于一样都不放行：同一份定义不写这一格，`buildTools()` 回 0 个工具；写上 `tools.allow: ["*"]` 之后，只装 `BuiltinToolsScopePlugin` 就得到 20 个。两者都实测过。

## 装哪些能力由你定

`allInOne()` 一次装上五个来源，也可以只装其中几个 —— 每个来源都是一个 `ScopePlugin`：

```ts
import { BuiltinToolsScopePlugin, SkillsScopePlugin, Scope } from "@ai-zen/agents-sdk";

const scope = new Scope({ getConfig: () => config, agentsDir, cwd }).use(
  new BuiltinToolsScopePlugin(), // 内置工具：读、写、跑命令那些
  new SkillsScopePlugin(), // 技能
);
```

| 插件 | 给什么 |
|---|---|
| `BuiltinToolsScopePlugin` | 内置工具 |
| `UserToolsScopePlugin` | 用户写的工具（`tools/` 目录） |
| `SkillsScopePlugin` | 技能 |
| `McpScopePlugin` | MCP 服务器与它们摊开的五个工具 |
| `SubAgentsScopePlugin` | sub-agent |

一个插件都不装时 `Scope` 仍然可用：`filter()` / `buildTools()` 回空数组，Agent手上没有工具，只剩模型与会话。反过来也成立 —— 插件装了、定义的 `permissions` 没写，一样是 0 个。

## 常驻那一种

`lifetime: "one-shot"` 是「跑一次就散」。要让同一个 `Agent` 接着收下一条，就别给这个选项，自己收尾：

```ts
const agent = await createAgent(scope, "writer");
const idle = new Promise<void>((resolve) => {
  const off = agent.on("state:idle", () => {
    off();
    resolve();
  });
});

void agent.start(); // 只在Agent死的时候 resolve，不能在这里 await
runtime.agent.send("在吗");
await idle;
agent.stop();
```

## 什么时候该上 `AgentRuntime`

上面这些够一个进程自己跟一个 `Agent` 说话。下面这几件事 `Scope` 不管，它们是 `AgentRuntime` 的活：

多段会话同时活着，并且要互相发话（`AgentRuntime.post()`）；一份「谁活着」的登记（`get()` / `status()` / `aliveOn()`）；同一个目录上的几段会话共用一个 `Scope`，以及它们什么时候拆（`scope:appeared` / `scope:gone` 那几条事实）；Agent的事件往外转发给观察者。

那一份用法在[SDK](sdk.md)的运行时那一节与[快速开始](getting-started.md)。
