# @ai-zen/agents-sdk

## 它是什么

`@ai-zen/agents-sdk` 把一个 Agent 装出来，并让它活着。它从磁盘上读配置与 AgentDefinition，决定由哪个模型来答，决定这个 Agent 能用哪些工具、技能、MCP 服务器与 subagent，最后几行之内交给你一个已经在跑的 Agent。

它还让这些 Agent 互相发话：开一段新的、往它的队列里放一句话、看它发生了什么。

存储、连接与用户可见文案都不归它。消息写在哪、谁能连上来、人看见的那句话长什么样，都归宿主 —— 这个包只向调用方要它自己不可能知道的几样东西。

## 怎么用

```bash
pnpm add @ai-zen/agents-sdk
```

下面是到一个能跑的 Agent 的最短路径。除了端点与 key，其余都是出厂配置，`bootstrap()` 替你写好：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const base = mkdtempSync(join(tmpdir(), "my-agent-"));

const config = new ConfigManager(join(base, "config.json"));
await config.bootstrap(); // config.json、一个默认 AgentDefinition、一个默认 subagent、出厂技能

const current = await config.read();
await config.write({
  ...current,
  // 唯一必须自己填的：模型住在哪、用哪个 key
  endpoints: current.endpoints.map((endpoint) => ({
    ...endpoint,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-…",
  })),
});

const scope = new Scope({
  getConfig: () => config.read(),
  agentsDir: join(base, "agents"),
  cwd: base,
}).use(...allInOne({}));
await scope.init();

const agent = await createAgent(scope, DEFAULT_AGENT_ID, { lifetime: "one-shot" });
const messages = await agent.runOnce({
  content: "这个包是干什么的？",
  priority: "low",
  source: { kind: "user" },
});
console.log(messages.at(-1)?.content);

await scope.dispose();
```

三处最容易踩，上一段代码里都躲开了：

- `config.read()` 是**异步**的。少一个 `await`，拿到的是一个 promise，下游一路静默地看到一份空配置。
- `createAgent()` 默认造的是**常驻**Agent，而 `runOnce()` 只接受 `lifetime: "one-shot"`。要一问一答就走，就带上这一格。
- 出厂配置里有三个端点、八个模型，默认 AgentDefinition 绑在其中一个上。只改一个端点的 `baseUrl`，其余模型还指着原来那家，解析就会失败并报 `EndpointDefinition "x" is not configured` —— 所以要像上面那样整批换。

想让 Agent 长住、随时能再接一句话，路径一样，只是不要 `lifetime: "one-shot"`：`send()` 一句、听 `state:idle`、完事 `stop()`。常驻 Agent 上没有「投一条然后等」这种东西 —— 任何触发方随时都能推它，那个等待没有落脚点。为什么见内核那一册。

两段会话互相发话：看本文末尾那个示例。

## 它是怎么拼出来的

一个包名后面是两半。

- 能力面把内核装成一个能办事的 Agent：能力从磁盘上发现，模型从配置里解析，还有权限与交接。
- 运行时让这些 Agent 活着，并让它们互相发话：一段会话一个常驻 Agent，事实往外转发，`post` 从一段会话寄到另一段。

内核本身（`@ai-zen/agents-core`）垫在两者下面：一个 `Agent`、它的循环、它的两道开关、它的事件与钩子。这个包加的是某一个产品在它周围需要的东西 —— 不加任何属于宿主的东西。

| 一半   | 成员                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 能力面 | `createAgent`、`SdkAgent`、`Scope` 与它的五个能力来源（`allInOne`）、`PermissionEvaluator`、`ConfigManager`、`AgentRepository`、`HandoffService` + `HandoffGuardPlugin`、`completeOnce` |
| 运行时 | `AgentRuntime`（`wake` / `post` / `status` / `openPeer` / `kill` / `observe`）、`Scopes`、`RuntimePeerSessions`                                                                         |

### 这个包有意不做什么

| 不在这里                 | 在哪里                                             |
| ------------------------ | -------------------------------------------------- |
| 存储、表、迁移           | 宿主                                               |
| 连接、发现文件、凭证     | 宿主                                               |
| 用户可见文案、语言、i18n | 宿主                                               |
| 会话行                   | 宿主 —— 在这个包里，会话只是一个不透明的身份字符串 |

衡量分层的规矩：这个包永远不 import 宿主。会话以 `string` 的形式传来传去；它叫什么名字要问一个端口，从不存下来。一处代码若要知道「谁活着」「谁认识谁」「什么时候装、什么时候拆」，它属于运行时，不属于宿主。它若读写文件、写行、转发事件、校验凭证或渲染文案，它属于宿主。

反过来，一个 `as unknown as` 强转、造出一个假实例来满足这个包里的某个东西，意味着缺一个端口：端口该在这里声明，由调用方实现。

#### 运行时借的四个端口

`AgentRuntime` 这四件事一件都不自己做，但每一件必须有地方做：

| 端口                    | 调用方提供什么                                               |
| ----------------------- | ------------------------------------------------------------ |
| `openScope(cwd, peers)` | 为那个目录造一个 Scope                                       |
| `open(input)`           | 建一段会话：写行、定身份、交回 `WakeMaterials`               |
| `nameOf(sessionId)`     | 这段会话当前的名字，从它的行上读；`undefined` = 没有这段会话 |
| `log`                   | 一个 `LogSink`；不给就不记日志                               |

`WakeMaterials` 是装配一个 Agent 所需要的全部材料，从上面给下来：`cwd`、`agentId`、`modelId` / `modelParams`、`lineage`、`history`，以及上一次没被取走的 `waiting` InboxEntry。

### Scope：一个目录一个容器

一个 `Scope` 持有配置、工作目录、AgentDefinition 目录、插件，以及插件产出的工具。它给每个 Agent 跑一条三步管线（`discover` → `candidates` → `instantiate`），于是一个 Agent 能用什么，是在它被造出来的时候定下的，不是每次调用到来的时候。

```ts
const scope = new Scope({ getConfig: () => config.read(), agentsDir, cwd }).use(
  ...allInOne({ toolsPaths, skillsPaths, subAgentsPaths, mcpPaths }),
);
await scope.init();
```

`getConfig` 是端口不是快照：配置改完之后，`refresh()` 重新读一遍，而不是重建容器。`use()` 必须在 `init()` 之前。

### 五个能力来源

`allInOne(options)` 按这个顺序返回五个标准插件 —— 内置工具、用户工具、技能、MCP、subagent —— 所以两者给出同名能力时，靠后的那个生效。

| 插件                      | 来源                                                |
| ------------------------- | --------------------------------------------------- |
| `BuiltinToolsScopePlugin` | 内置工具集；每个工具自己声明可用性（`isAvailable`） |
| `UserToolsScopePlugin`    | 磁盘上找到的工具脚本                                |
| `SkillsScopePlugin`       | 技能目录，以及装载技能的那些工具                    |
| `McpScopePlugin`          | MCP 服务器（见下）                                  |
| `SubAgentsScopePlugin`    | 磁盘上的 subagent 定义，一条定义展开成一个委派工具  |

`allInOne` 的选项：`skillsPaths`、`toolsPaths`、`subAgentsPaths`、`mcpPaths`、`logger`、`mcpTaskNotice`。要拿掉或换掉某个来源，就一个一个造插件，再 `use()` 它们。

### 权限

四个维度，各自独立，每个是 `{ allow: [...] }` 或 `{ deny: [...] }`，支持 `*`。没命中就是拒；某一维根本没有策略也是拒。过滤作用在候选名上、发生在实例化之前，于是被拒的能力不是「调用时才挡回来」—— 模型根本看不见它。

```json
{
  "permissions": {
    "tools": { "allow": ["*"] },
    "skills": { "deny": ["deploy"] },
    "mcps": { "allow": ["github"] },
    "subagents": { "allow": ["reviewer"] }
  }
}
```

`PermissionEvaluator` 是这条规矩唯一的实现（`filter`、`isAllowed`、`match`）。

### 定义、配置与模型

| 成员                                                        | 它管什么                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ConfigManager`                                             | `config.json` 和它旁边的目录：读写、出厂默认、坏文件恢复、思考档位、出厂技能、`mcp.json` |
| `AgentRepository`                                           | 一个文件一个 AgentDefinition，`<agentsDir>/<id>.json`                                    |
| `createAgent(scope, agentId, options)`                      | 一个装好的 `SdkAgent`：读定义、解析模型、按过滤后的候选造工具                            |
| `resolveModelDefinition` / `resolveModelDefinitionParams`   | 会话级覆盖 > 定义 > `config.defaultModelDefinition`，唯一的实现                          |
| `createModelDefinition` / `createModelDefinitionFromConfig` | `OpenAI` 客户端、模型名与请求参数                                                        |
| `completeOnce`                                              | 一次不带工具、不带历史的非流式调用                                                       |

`createAgent` 的选项：`modelId` 与 `modelParams`（会话那一级）、`lifetime`（跑一次就死的 Agent 用 `"one-shot"`）、`canOpenPeers`，以及两个中断策略 `abortedToolRoundStrategy` / `abortedMessageStrategy` —— 它们回落到配置，再回落到内核默认值。

模型解析从不混级：参数跟着提供模型的那一级走，于是换了模型的会话不会带着上一个模型的参数。

`SdkAgent` 是一个 `Agent`，另外带着 `scope` 与 `definition`（生效中的那份定义，解析出来的模型已经写进去），还有 `useModelDefinition(modelId, modelParams?)` —— 就地换模型与参数，不杀 Agent。

### 交接

`HandoffService` 写一份交接文档，并且可以选择用它换掉记忆。

| 方法              | 干什么                                                |
| ----------------- | ----------------------------------------------------- |
| `handoff(params)` | 给 Agent 一条指令去写那份文档，会话的其余部分一概不动 |
| `migrate(params)` | 写完文档，算出新的记忆并提交它                        |

谁写文档有两种模式：`self`（同一个 Agent，在它自己的会话里 —— 默认）与 `summary`（拿序列化后的历史单独调一次模型）。旧消息怎么处置有两种策略：`omit`（打标记，之后的请求不再发 —— 默认）与 `prune`（物理删除）。`commitMemory` 决定新记忆落到哪：不给，SDK 就地拼 `agent.messages`；给了，由调用方去存。

`HandoffGuardPlugin` 是交接那一批的守卫：在那一批里，唯一放行的写是写交接文档本身；其余写工具一律被拒，并给出一句模型能读懂、能照着办的句子。它还观察那次写到底发生了没有（`arm` 返回一个结果和一个「这批结束」的 promise；`disarm` 之后一切照旧放行）。它防的是工作目录被写坏，不是沙箱：shell 命令照样能写文件。取消以 `HandoffAbortedError` 的形式出现，并且绝不会悄悄换成另一种模式重跑。

### Agent 插件

挂在 Agent 上，不挂在容器上：`AutoMigratePlugin`（用量越过软线就交接）、`AutoRefreshToolsPlugin`、`ContextGuardPlugin`（会越过硬线的请求直接拒）、`SubAgentGuardInstallerPlugin`（把守卫也装到 subagent 上）、`HandoffGuardPlugin`、`UnknownToolHintPlugin`、`AssetTransportPlugin`。

### 运行时

`AgentRuntime` 一段会话一个常驻 Agent，并把内核的事实转发出去。

| 成员                                                     | 干什么                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `wake(sessionId, materials)`                             | 装配、登记、开跑；幂等，并发的调用共用一次装配              |
| `post({ from, to, content })`                            | 往另一段会话的 inbox 里放一句；回 `{ ok: true }` 或一个原因 |
| `status(sessionId)`                                      | 在干还是闲、叫什么名字、最后一条消息的摘要                  |
| `openPeer({ from, prompt, agentId?, modelId?, label? })` | 开一段 PeerSession、唤醒它、递上第一句、立刻返回            |
| `kill(sessionId)`                                        | 注销、杀死、报它没了                                        |
| `close()`                                                | 杀掉一切，拆掉每个容器                                      |
| `observe(listener)`                                      | 订阅事实；返回退订函数                                      |
| `get(sessionId)` / `sessionOf(agent)` / `aliveOn(cwd)`   | 快照：哪个 Agent、哪段会话、那个目录上有哪几段会话活着      |
| `scopes` / `peerSessions`                                | 容器登记表，以及这个运行时实现的 PeerSession 端口           |

事实是一个可判别联合：`resident:appeared` 与 `resident:gone`（运行时自己的两个）、`scope:appeared` / `scope:refreshed` / `scope:gone`（来自容器登记表），以及每个 Agent 的每条内核事件 —— 名字与载荷都不变，多一个 `sessionId`。

运行时上没有「等到它做完」这种东西：常驻会话没有做完的一刻，它从在干回到闲，随时可以被再推一条。运行时里没有任何东西替调用方等；叫醒一段会话的是一次 `send()`。

#### Scopes：容器按目录活着

`Scopes` 持有容器登记表：一个 `cwd` 一个容器，那个目录上的每段会话共用它。

| 成员           | 干什么                                                 |
| -------------- | ------------------------------------------------------ |
| `for(cwd)`     | 那个目录的容器，第一次用到时造                         |
| `dispose(cwd)` | 拆掉它 —— 那个目录上还有会话活着时拒绝                 |
| `refreshAll()` | 让每个已经造好的容器重读配置；报刷新了几个、哪几个失败 |
| `disposeAll()` | 全拆，给进程退出用                                     |

没有空闲计时器，没有引用计数，也没有自动回收：容器活着是因为有人拿着它，有人拆它才拆。「没人用了」不是一个可判定的状态。拆的时候拒绝，而不是连带拆掉别的东西 —— 连带会悄悄杀掉正办到一半的会话。

### PeerSession

PeerSession 是 Agent 给自己开的另一段会话，有自己的 Agent、自己的上下文、自己的用量，而且之后留在会话列表里。

模型那一侧是三个工具（`packages/sdk/src/scope/plugins/peers/`）：

| 工具                  | 干什么                                                   |
| --------------------- | -------------------------------------------------------- |
| `create_session`      | 开一段 PeerSession，立刻回 `{ sessionId, label }`        |
| `read_session_status` | 它在干还是闲、还活着没有、叫什么名字、最后一条消息的摘要 |
| `post_message`        | 往那段会话的 inbox 里放一条消息                          |

它们自己不实现任何东西。`PeerSessionsScopePlugin` 收一个带三个方法的 `PeerSessionPort` —— `create`、`status`、`send` —— 不给端口就一个工具都不产出。运行时实现的正是这个端口（`RuntimePeerSessions`），所以没有宿主在场时那三个工具也能用。

两条规矩是结构上的，不是调用时才校验的：

- 本身就是被当作 PeerSession 开出来的 Agent，手上没有 `create_session`：给它调 `createAgent` 时传的是 `canOpenPeers: false`，于是开 PeerSession 只有一层深，模型连试都试不了。`post_message` 与 `read_session_status` 留着，因为 PeerSession 之间是双向的。
- 一次性 Agent 三样都没有，两个后台工具也没有：它没有身份给一条消息签名，也开不出任何有人认领的东西，而且在后台结果回来之前它就已经没了。

`post_message` 不看两段会话之间是什么关系，它的回执只说明那条消息被收下了。拒绝是结构化的：`gone`（没有这段会话）与 `dead`（行在，后面没有 Agent，于是没人会取）。开 PeerSession 也可能被 `depth_exceeded`（这段会话自己就是被开出来的 PeerSession，或者调用方根本不是一段会话）或 `model_unresolved` 拒掉；`PeerSessionRejectReason` 里还有 `too_many_peers`，给会限量的端口用。

PeerSession 历史的摘要与消息条数一概不返回：模型只拿到一份摘要，于是它不会把另一段会话的记录当成自己的上下文。

### 后台工具

两个内置工具立刻返回、事后才报：

| 工具            | 干什么                                                                |
| --------------- | --------------------------------------------------------------------- |
| `async_exec`    | 在后台跑一条 shell 命令；它的输出与退出状态作为一条新消息递回这段会话 |
| `async_timeout` | 一个定时器；到点时把带着任务 id 的一条消息递回来                      |

两个都在 `scope/plugins/builtin/` 里（`AsyncExecTool`、`AsyncTimeoutTool`、`asyncTasks`）。结果通过一次 `send()` 回到同一段会话，低优先级，于是永远不落在正跑着的那一批里。任务 id 来自每个 Agent 一个计数器（`async_exec-1`、`async_timeout-2`），Agent 停下或被杀时，还在跑的全部收掉。

一次性 Agent 两个都拿不到（`ASYNC_TASK_TOOL_NAMES` 在装配时被摘掉）：结果回来时它的调用栈已经退回去了，没有人可以递。这和内核就「常驻与一次性」说的那条是同一条规矩，落在「挑工具」这一步上。

### MCP

四样东西在 `scope/plugins/mcp/` 里。

发现把一串有序的 `mcp.json` 合并，近的在前：同一个服务器 id，靠前的文件生效；近处文件里 `disabled: true` 的一条会取消远处文件里的定义。标准链条那五个位置由调用方拼好、作为 `mcpPaths` 传进来（知道那五个位置的是宿主），所以这个包合并的就是它拿到的那些。

连接是懒的，归 `McpConnectionManager`：`load_mcp` 连一个服务器并交回它的清单，没人用的连接在空闲超时之后被丢掉（stdio 30 分钟，http 5 分钟），`disconnect` / `disconnectAll` 显式关掉它们。传输断掉时，那个服务器被标成已断开，而不是自己去重连 —— 重连发生在模型又要点这个服务器的时候，过期的清单不会被当作当前的那份出示。配置变了的时候 `McpScopePlugin` 做对账：删掉的和改过的断开，没改过的一律不碰。

模型那一侧是五个工具：`load_mcp`、`call_mcp_tool`、`read_mcp_resource`、`get_mcp_task_result`、`cancel_mcp_task`。

任务是 MCP 调用里那种长时间运行的形式。工具声明自己支持还是不支持任务（`forbidden` / `optional` / `required`）；一次调用产出任务时，`call_mcp_tool` 立刻交回任务 id，服务器推送状态通知，管理器记住是哪段会话起的这个任务。终态（`completed` / `failed` / `cancelled`，见 `isTerminalTaskStatus`）交给 `McpTaskNoticePort`，由宿主实现：`sessionOf(agent)` 说调用方属于哪段会话，`deliver(sessionId, notice)` 把通知放进它的 inbox。结果本身用任务 id 通过 `get_mcp_task_result` 取。

## 细节

### 示例：两段会话，一条消息

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

// config.json 与 "lead" / "helper" 两份定义已经在 base 下面了
const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
const names = new Map<string, string>();

const runtime = new AgentRuntime({
  openScope: async (cwd, peers) => {
    const scope = new Scope({ getConfig: () => config.read(), agentsDir: `${base}/agents`, cwd })
      .use(...allInOne({ mcpPaths: [`${base}/mcp.json`] }))
      .use(new PeerSessionsScopePlugin(peers)); // PeerSession 那三个工具要运行时给的端口
    await scope.init();
    return scope;
  },
  open: async (input) => {
    // 真的宿主在这里写会话行、定身份
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
await runtime.wake("helper", {
  cwd: base,
  agentId: "helper",
  lineage: null,
  history: [],
  waiting: [],
});

// helper 被这次 `send()` 叫起来、自己跑完、回到闲
console.log(await runtime.post({ from: "lead", to: "helper", content: "用一句话打个招呼。" }));
console.log(await runtime.status("helper"));

await runtime.close();
```

运行时上的 `peerSessions` 就是那三个工具最终对接的端口；`Scopes` 是运行时自己持有的容器登记表，所以示例不用自己造它。

### 自己写配置

`bootstrap()` 会写一份能用的配置。如果你想自己写 —— 比如你要随程序带一份默认值 —— 下面是完整的形状：

```ts
const config = new ConfigManager(`${base}/config.json`);
await config.write({
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-…" },
  ],
  models: [
    {
      id: "gpt-4o",
      name: "GPT-4o",
      endpointId: "openai",
      tokenThresholds: { handoff: 500_000, guard: 750_000 },
    },
  ],
  defaultModelDefinition: "gpt-4o",
});

const agents = new AgentRepository(`${base}/agents`);
await agents.write({
  id: "demo",
  name: "Demo",
  messages: [Message.System("用一句话回答。")],
  modelId: "gpt-4o",
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

`tokenThresholds` 是绝对的输入 token 数，不是上下文窗口的百分比：越过软线开始交接，越过硬线在请求发出之前就拒。

### 测试

```bash
npm run pretest      # tsc --noEmit over src and the tests
npx vitest run       # 不依赖本仓之外任何东西的那套用例
```

两条命令都在 `packages/sdk` 下跑。`npm run test:e2e` 跑需要 API key 或真的 MCP 服务器的那些用例；`npm test` 绝不能需要这两样。用例所用的假端点在 `@ai-zen/fake-llm` 里。

## 许可

MIT
