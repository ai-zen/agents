---
title: 快速开始
description: 从零到第一句发出去：装依赖、跑测试、起一台宿主（agents-host serve 与它的参数）、拿一串凭证（token create 与 run/token）、把客户端连上去，以及不经宿主的两种用法（只用 core；core 加 Scope）。
outline: deep
---

# 快速开始

这一页从空目录走到「第一句发出去」。两条路可以分开走：一条是把宿主跑起来、让另一个仓里的客户端连上来；另一条是只用 `core` 与 `sdk` 装一个 agent，不经过宿主。

## 前提

| 项 | 说明 |
|---|---|
| Node.js | 宿主用 `node:sqlite`（`packages/host/src/infra/db.ts`），运行环境要有这个模块 |
| pnpm | 本仓是 pnpm workspace（`pnpm-workspace.yaml`），`packages/*` 都挂在它下面 |
| 模型端点 | 内核跑在官方 `openai` 包上；一个 `OpenAI` 客户端、一个模型名、一组消息就够构造一个 agent |

## 装依赖、跑测试

```bash
pnpm install
pnpm test
```

`pnpm test` 先构建 `testing`、`logger`、`host` 与 `client`，再把各包自己的套件逐个跑一遍。跑单个包就进它的目录：

```bash
cd packages/core
npm run pretest      # tsc --noEmit -p tsconfig.test.json
npx vitest run
```

宿主另有一套跨进程的用例，不进 `npm test`：

```bash
cd packages/host
npx vitest run                                  # 域内用例：不起端口、不写真实磁盘
npx vitest run --config vitest.e2e.config.ts    # 真的一套：真端口、真磁盘、真 WebSocket
```

构建在根上给了入口：`pnpm build-core`、`pnpm build-sdk`、`pnpm build-host`、`pnpm build-client`、`pnpm build-logger`、`pnpm build-testing`。

## 起一台宿主

```bash
pnpm build-host
node packages/host/dist/cli.js serve
```

装好之后入口是 `agents-host` 这个 bin，同一条命令因此写作 `agents-host serve`。缺省只监听回环地址的 8790 端口。

`serve` 的参数（`packages/host/src/cli.ts`）：

| 参数 | 意思 |
|---|---|
| `--port <n>` | 监听这个端口。`0` 由系统分配，只有这一档放行 |
| `--host <addr>` | 监听这个地址，压过 `--public` 推出的那一个。它本身不改变这台实例算不算本机实例，改变的是 `--public` |
| `--public` | 监听所有网卡，而不是回环地址 |
| `--ai-zen-dir <dir>` | 数据根，先写进 `AI_ZEN_DIR` 再让别的模块读 |

端口显式给出但不是 0 到 65535 的整数时，命令行直接拒绝并打印用法，退出码 2；端口被占用时启动失败退出，不换端口重试。

`stop` 按 `<数据根>/run/host.json` 里那个 pid 关掉这台机器上的宿主，问一次再动手；脚本里加 `--yes` 跳过这一问。

## 拿一串凭证

客户端连上来要一串令牌，握手时带上。造它的是宿主自己的管理动作，走命令行，不开服务：

```bash
node packages/host/dist/cli.js token create --note laptop   # 明文只打印这一次
node packages/host/dist/cli.js token list                   # 列出 id 与状态
node packages/host/dist/cli.js token revoke <id>            # 吊销一串
```

库里存的是这串令牌的 SHA-256 摘要，明文只在创建那一次出现；吊销影响的是此后能不能连上，已经握过手的连接不会被回头断开。

本机实例还会把一串能用的令牌写进 `<数据根>/run/token`，同一台机器上的客户端读它就行，不必手抄。对外实例（`--public`）不写这个文件：那台机器上的凭证只能由人当场造出来，再分发给要连的设备。

## 把客户端连上去

仓里不带界面。另有一份终端客户端（还有一份桌面端），各自在别的仓里，各自把 `@ai-zen/agents-client` 捆进自己的产物。

客户端到宿主的全部交通是一条 WebSocket，tRPC 跑在上面，宿主发出来的事实从同一条连接上的一条订阅回来。令牌放在握手的 `connectionParams` 里（`{ token }`），不进 URL 查询串；验不过的连接连一个 procedure 都调不到，回 `unauthorized` 之后关闭。

本机这一档不用配置地址，也不用给令牌：客户端从 `<数据根>/run/host.json` 读「谁在服务」，从同一处的 `run/token` 读那串令牌。连另一台机器上的宿主时，地址与令牌都要显式给，令牌就是上一步 `token create` 打印出来的那一串。

## 不经过宿主的最小 agent

这一段只用 `@ai-zen/agents-core`：没有库、没有会话行、没有连接。`start()` 的 promise 在这个 agent 死掉时才 resolve，所以要等一批跑完，等的是 `state:idle`。

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o",
  messages: [Message.System("Answer in one sentence.")],
});

// on() returns the unsubscribe function; the handler receives the live message
const offFinished = agent.on("messageFinished", ({ message }) => {
  if (message.role === "assistant" && message.content) console.log(message.content);
});

// resolve when one batch is done and the queue is empty
const idle = new Promise<void>((resolve) => {
  const offIdle = agent.on("state:idle", () => {
    offIdle();
    resolve();
  });
});

agent.send({ content: "What does this package do?", priority: "low", source: { kind: "user" } });

void agent.start();  // resolves only when the agent is dead
await idle;          // the batch in hand finished
agent.stop();        // drain what is queued, then die
offFinished();
console.log(agent.messages.at(-1)?.content);
```

再加一层 `@ai-zen/agents-sdk`，就是两段会话互相发话：`AgentRuntime` 装上 `Agent`、留一份「谁活着」的登记，`post()` 把一条话寄给另一段会话。被投的那一段自己从闲变成忙、跑完回到闲，投的那一侧不等它。

```ts
import {
  AgentRuntime,
  ConfigManager,
  PeerSessionsScopePlugin,
  Scope,
  allInOne,
  type RuntimeFact,
  type WakeMaterials,
} from "@ai-zen/agents-sdk";

// config.json and the two definitions "lead" and "helper" already exist under `base`
const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
const names = new Map<string, string>();

const runtime = new AgentRuntime({
  openScope: async (cwd, peers) => {
    const scope = new Scope({ getConfig: () => config.read(), agentsDir: `${base}/agents`, cwd })
      .use(...allInOne({ mcpPaths: [`${base}/mcp.json`] }))
      .use(new PeerSessionsScopePlugin(peers)); // the peer tools need the port from the runtime
    await scope.init();
    return scope;
  },
  open: async (input) => {
    // a real host writes a session row here and decides the identity
    const sessionId = `session-${names.size + 1}`;
    names.set(sessionId, input.label ?? input.prompt);
    const materials: WakeMaterials = {
      cwd: base,
      agentId: input.agentId,
      modelId: input.modelId,
      lineage: input.lineage,
      history: [],
      waiting: [],
    };
    return { ok: true, sessionId, materials };
  },
  nameOf: async (sessionId) => names.get(sessionId),
});

runtime.observe((fact: RuntimeFact) => {
  if (fact.type === "messageFinished") console.log(fact.sessionId, fact.message.content);
});

names.set("lead", "lead");
names.set("helper", "helper");
await runtime.wake("lead", { cwd: base, agentId: "lead", lineage: null, history: [], waiting: [] });
await runtime.wake("helper", { cwd: base, agentId: "helper", lineage: null, history: [], waiting: [] });

// the helper is woken up by this delivery, runs on its own, and comes back to idle
console.log(await runtime.post({ from: "lead", to: "helper", content: "Say hi in one line." }));
console.log(await runtime.status("helper"));

await runtime.close();
```

这一段里的模型从 `config.json` 解析出来：端点、模型与密钥都写在那个文件里。运行时有四个端口由调用方给 —— 造一个 `Scope`（`openScope`）、开一段会话（`open`）、现读一段会话此刻叫什么（`nameOf`）、日志 —— 宿主给的就是这四格；把它们换成空实现，这一层的行为一条不变。

要工具、技能、MCP 这些能力，但不要 `AgentRuntime` 时，`Scope` 与 `createAgent` 就够 —— 那份代码在[只用 core 与 Scope](scope.md)。

## 下一步

- [架构](architecture.md) —— 四层的判据、活物的四问、事件与持久化的落点
- [Core API](core.md) —— 一个 `Agent` 的 inbox、两个循环、两道开关、插件钩子
- [SDK](sdk.md) —— `Scope`、模型解析、交接、运行时
- [只用 core 与 Scope](scope.md) —— 不装 `AgentRuntime`、不碰宿主
- [部署](deploy.md) —— 本机实例与对外实例、端口三档、凭证、升级
