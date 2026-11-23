# AI-Zen Agents

## 它是什么

一套自己部署的 agent 运行时。这里的 agent 是进程内的一个对象，带一个 inbox 与两个循环；仓里其余的东西，要么给它能力，要么让它活着、能被连上，要么把它做过的事写下来。

分四层，每一层都能从上往下整块换掉：客户端可以换成一个脚本，宿主可以换成一个空实现，下面几层的行为一条不变。

## 怎么用

先构建、再跑套件：

```bash
pnpm install
pnpm test
```

`pnpm test` 先构建 `testing`、`logger`、`host` 与 `client`，再把各包自己的套件逐个跑一遍。跑单个包就进它的目录，那里的 `npm test` 先做类型检查再跑套件。跨进程那一套不进 `npm test`，手动跑：

```bash
cd packages/host
npm run pretest                                 # tsc --noEmit -p tsconfig.test.json
npx vitest run                                  # 域内用例：不起端口、不写真实磁盘
npx vitest run --config vitest.e2e.config.ts    # 真的一套：真端口、真磁盘、真 WebSocket
```

跑一台宿主：

```bash
pnpm build-host
node packages/host/dist/cli.js serve            # 缺省 127.0.0.1:8790
node packages/host/dist/cli.js token create     # 给另一台机器上的客户端造一串凭证
```

装好之后入口是 `agents-host` 这个 bin，命令因此写作 `agents-host serve`、`agents-host stop`、`agents-host token create`、`agents-host token list`、`agents-host token revoke`。一台宿主把库、配置、素材与运行期文件都放在一个数据根下面 —— 环境变量 `AI_ZEN_DIR`，缺省 `~/.ai-zen` —— 并在那里写 `run/host.json`、`run/token`、`run/next-version.json`。监听地址的规矩、凭证交付文件与契约面见 [`packages/host/README.md`](packages/host/README.md)。

不碰宿主，单独造一个 agent：

```ts
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const config = new ConfigManager(`${base}/config.json`);
await config.bootstrap();          // config.json、一个默认助手、出厂技能，都在这一句里
// ……把端点与 key 填进去，然后：
const scope = new Scope({ getConfig: () => config.read(), agentsDir: `${base}/agents`, cwd: base })
  .use(...allInOne({}));
await scope.init();
const agent = await createAgent(scope, DEFAULT_AGENT_ID, { lifetime: "one-shot" });
console.log((await agent.runOnce({ content: "你好", priority: "low", source: { kind: "user" } })).at(-1)?.content);
```

这段就是下面那条判据本身：一个宿主都不需要。完整版（含三处最容易踩的坑）在 [`packages/sdk/README.md`](packages/sdk/README.md)。

本仓不带界面。终端客户端与桌面端在各自的仓里，各自内联 `@ai-zen/agents-client`，那一层管连接：找到一台宿主或者拉起一台、读凭证、在两边任一重启之后把 WebSocket 接回去。它们自己的状态 —— 屏幕、按键、一段会话没有执行体时该怎么办 —— 留在线的另一侧。

## 它是怎么拼出来的

```
终端客户端 · 桌面端                       各在自己的仓里，各自把
        │                                @ai-zen/agents-client 捆进产物
        │  一条 WebSocket；tRPC 跑在上面，往回一条事件流
        ▼
@ai-zen/agents-host      会话行与消息、项目、连接与凭证、
        │                通知、素材、提问、搜索、用户可见文案
        │  procedure 进来，事件出去
        ▼
@ai-zen/agents-sdk       能力面：能力容器、内置工具、技能、subagent、MCP、平级会话。
        │                运行时：唤醒执行体、登记谁活着、给另一段会话发话、拆容器
        ▼
@ai-zen/agents-core      一个 agent：inbox、外循环、内循环、输入闸与输出闸、
                         事件名、插件钩子
```

只有宿主有契约面，它分两半。一半是按域分的 procedure：`session.*` 管会话行，`agent.*` 管活着的那个对象做什么，另有 `workspace.*`、`asset.*`、`notice.*`、`question.*`、`handoff.*`、`search.*`、`scope.*`、`config.*`、`mcp.*`、`agentDefinition.*`、`host.*`。另一半是一条订阅，宿主发出来的每一条事实都从它走 —— 客户端因此不会去问「有没有变」。

### 分层的判据

不经过宿主，只用 `@ai-zen/agents-core` 与 `@ai-zen/agents-sdk` 也能组装出事件驱动、常驻、能互相通信的 agent：一段会话被唤醒之后，取件、开跑、回到闲都不需要有人在调用栈上等它；另一段会话能给它发话。这是分层唯一要过的那一关。有一块代码如果只是因为宿主恰好在才存在 —— 谁活着、能力容器什么时候拆、一段会话叫什么 —— 做法是把它搬进运行时，不是在宿主里再开一条路。

### 仓库里的包

| 包 | 做什么 | 不做什么 |
|---|---|---|
| `@ai-zen/agents-core` | 跑一个 agent：inbox、按批取件的外循环、发请求与跑工具的内循环、两道闸连同它们的开关与现读、事件名、插件钩子 | 不知道会话与项目、不碰库与任何持久化、不碰网络与凭证、不碰语言与文案、不读配置文件、不做能力发现 |
| `@ai-zen/agents-sdk` | 两半。能力面：按目录一份的能力容器，装工具、技能、subagent、MCP 服务器与平级会话那三个工具；模型的三级解析；交接。运行时：按交上来的材料唤醒执行体、留一份「谁活着」的登记、给另一段会话发话、最后一段会话没了就拆掉容器 | 不碰库、不碰连接与凭证、不碰会话行、不出用户可见文案；会话对它只是一个不透明的身份 |
| `@ai-zen/agents-host` | 一个 SQLite 文件里的行与表、连接与凭证、客户端杂项（通知、素材、提问、搜索）、用户可见文案与语言、单实例的发现文件、命令行 | 不装 agent、不记谁活着、不决定能力容器什么时候拆、不判配置合不合法、不算 MCP 合并、不管连接与重连 |
| `@ai-zen/agents-client` | 到宿主的连接：拉起一台、读发现文件与凭证交付文件、凭证来源、重连 | 不发版（`private: true`，被终端与桌面各捆进自己的产物）；不被 `core` 与 `sdk` import |
| `@ai-zen/agents-logger` | 一个进程一个日志文件，零依赖；`info` / `warn` / `error` 只从一个口出 | 不在装配根之外的地方被创建 |
| `@ai-zen/agents-testing` | 几个包共用的测试件，把 `@ai-zen/fake-llm` 转出去，调用点只认一个 import | 不进生产依赖图 |
| `@ai-zen/fake-llm` | 一个 OpenAI 兼容的假端点：交给它一条目标消息，它把那条消息本该到达的那一串 delta 放回来 | 不连真实的服务方，也不对「模型该答什么」有意见 |

## 细节

### 构建入口

都在根上：`pnpm build-core`、`pnpm build-sdk`、`pnpm build-host`、`pnpm build-client`、`pnpm build-logger`、`pnpm build-testing`。

### 目录树

```
agents/
├── packages/
│   ├── core/          @ai-zen/agents-core
│   ├── sdk/           @ai-zen/agents-sdk
│   ├── host/          @ai-zen/agents-host
│   ├── client/        @ai-zen/agents-client
│   ├── logger/        @ai-zen/agents-logger
│   ├── testing/       @ai-zen/agents-testing
│   ├── fake-llm/      @ai-zen/fake-llm
│   ├── test-home/     sdk 跨进程用例用的数据根
│   └── test-project/  同一批用例用的项目目录与 MCP 服务器
├── dev-docs/          PRD · TRD · PLAN · GLOSSARY · ARCHITECTURE · STYLE
├── docs/              文档站的页面，中英各一份
└── scripts/           仓库脚本
```

### 往下读

| 文件 | 装什么 |
|---|---|
| [`dev-docs/PRD.md`](dev-docs/PRD.md) | 用户要看见什么，正文分十四册：需求从哪来与八条硬规矩、不能推翻的用户决策、按对象分的九册（会话、控制、平级会话、交接、客户端、素材、观测、文案、明确不做与待定），以及反复被问的那些问题 |
| [`dev-docs/TRD.md`](dev-docs/TRD.md) | 这套东西按什么形状搭起来：四层各负责什么、引擎、活物、宿主基础设施 |
| [`dev-docs/PLAN.md`](dev-docs/PLAN.md) | 做完了什么、还差什么、怎么算做到了；以及已经拍过、不要重开的决定 |
| [`dev-docs/GLOSSARY.md`](dev-docs/GLOSSARY.md) | 一个概念只有一个名字，以及不许用的那些叫法 |

同一个目录下还有 [`dev-docs/ARCHITECTURE.md`](dev-docs/ARCHITECTURE.md) 与 [`dev-docs/STYLE.md`](dev-docs/STYLE.md)：前者是宿主的结构与那八条判据，后者是全仓的写法。

## 许可

MIT
