---
title: SDK
description: 能力面与运行时：能力容器的三阶段管线与五个能力来源、四维权限即披露、模型的三级解析、交接的两个方法与两档策略、执行体插件、平级会话那三个工具、两个后台工具，以及容器什么时候拆。
outline: deep
---

# SDK

`@ai-zen/agents-sdk` 一个包名后面是两半。

- 能力面把内核装成一个能办事的执行体：能力从磁盘上发现，模型从配置里解析，还有权限与交接。
- 运行时让这些执行体活着，并让它们互相发话：一段会话一个常驻执行体，事实往外转发，`post` 从一段会话寄到另一段。

内核（`@ai-zen/agents-core`）垫在两者下面。这一页讲这个包在它周围加了什么，以及加的东西各自的边界。

| 一半 | 成员 |
|---|---|
| 能力面 | `createAgent`、`SdkAgent`、`Scope` 与它的五个能力来源（`allInOne`）、`PermissionEvaluator`、`ConfigManager`、`AgentRepository`、`HandoffService` + `HandoffGuardPlugin`、`completeOnce`、内置工具与它们的输出保护 |
| 运行时 | `AgentRuntime`（`wake` / `post` / `status` / `openPeer` / `kill` / `close` / `observe` / `get` / `sessionOf` / `aliveOn`）、`Scopes`、`RuntimePeerSessions` |

```bash
pnpm add @ai-zen/agents-sdk
```

## 分层：这个包不做什么

| 不在这里 | 在哪里 |
|---|---|
| 库、表、迁移 | 宿主 |
| 连接、发现文件、凭证 | 宿主 |
| 用户可见文案、语言、i18n | 宿主 |
| 会话行 | 宿主 —— 在这个包里，会话只是一个不透明的身份字符串 |

衡量分层的规矩：这个包永远不 import 宿主。会话以 `string` 的形式传来传去；它叫什么名字要问一个端口，从不存下来。一处代码若要知道「谁活着」「谁认识谁」「什么时候装、什么时候拆」，它属于运行时；它若读写文件、写行、转发事件、校验凭证或渲染文案，它属于宿主。

反过来，一个 `as unknown as` 强转、造一个假实例来满足这个包里的某个东西，意味着缺一个端口：端口该在这里声明，由调用方实现。

## 运行时借的四个端口

`AgentRuntime` 这四件事一件都不自己做，但每一件必须有地方做。

| 端口 | 调用方提供什么 |
|---|---|
| `openScope(cwd, peers)` | 为那个目录造一个能力容器 |
| `open(input)` | 建一段会话：写行、定身份、交回 `WakeMaterials` |
| `nameOf(sessionId)` | 这段会话当前的名字，从它的行上读；`undefined` = 没有这段会话 |
| `log` | 一个 `LogSink`；不给就不记日志 |

`WakeMaterials` 是装配一个执行体所需要的全部材料，从上面给下来：`cwd`、`agentId`、`modelId` / `modelParams`、`lineage`、`history`、上一次没被取走的 `waiting` 条目，以及这一段会话要装的插件（可选）。没有一样是运行时自己去取的：历史与没取走的条目在库里的那一份只有宿主认得，模型的三级解析只有 `createAgent` 一处实现。

## Scope：一个目录一个容器

一个 `Scope` 持有配置、工作目录、助手定义目录、插件，以及插件产出的工具。它给每个执行体跑一条三步管线 —— `discover` → `candidates` → `instantiate` —— 于是一个执行体能用什么，是在它被造出来的时候定下的，不是每次调用到来的时候。

```ts
const scope = new Scope({ getConfig: () => config.read(), agentsDir, cwd })
  .use(...allInOne({ toolsPaths, skillsPaths, subAgentsPaths, mcpPaths }));
await scope.init();
```

`getConfig` 是端口不是快照：配置改完之后 `refresh()` 重新读一遍，而不是重建容器。`use()` 必须在 `init()` 之前，`init()` 之后再 `use()` 会抛错。

| 成员 | 干什么 |
|---|---|
| `init()` | 取一次配置、跑首次发现，随后锁住插件注册 |
| `refresh()` | 重新取配置、让每个插件重新发现一次 |
| `dispose()` | 逆序释放各插件（例如断开 MCP 连接） |
| `filter(definition, options?)` | 汇总各插件的候选名，剔除 `exclude`，再按四维权限过滤 |
| `instantiate(filtered)` | 名称变成工具实例，再按工具名去重 |
| `buildTools(definition, options?)` | 上面两步合成一步 |

`filter` 是纯名称操作，不造工具；`exclude` 是「这一层不该看见某个名字」（例如 subagent 解析自己的工具时排掉自身，防递归），它排在权限之前。

## 五个能力来源

`allInOne(options)` 按这个顺序返回五个标准插件 —— 内置工具、用户工具、技能、MCP、subagent。

| 插件 | 来源 |
|---|---|
| `BuiltinToolsScopePlugin` | 内置工具集；每个工具自己声明可用性（`isAvailable`） |
| `UserToolsScopePlugin` | 磁盘上找到的工具脚本 |
| `SkillsScopePlugin` | 技能目录，以及装载技能的那些工具 |
| `McpScopePlugin` | MCP 服务器 |
| `SubAgentsScopePlugin` | 磁盘上的 subagent 定义，一条定义展开成一个委派工具 |

两个来源给出同名工具时，靠后注册的那个留下（`instantiate` 按工具名去重，从后往前留）。这是工具名去重，不是「后一个来源的所有能力都压过前一个」：技能、MCP 服务器、subagent 各自按自己的维度判，谁也不盖谁的名字。

`allInOne` 的选项：`skillsPaths`、`toolsPaths`、`subAgentsPaths`、`mcpPaths`、`logger`、`mcpTaskNotice`。要拿掉或换掉某个来源，就一个一个造插件再 `use()` 它们。日志口不给就一律不记：四个会读盘的插件把「这个文件读不出来」报给它。

## 权限：四维与披露

四个维度，各自独立，每个是 `{ allow: [...] }` 或 `{ deny: [...] }`，支持 `*`。没命中就是拒；某一维根本没有策略也是拒；整个 `permissions` 缺失时四维全拒 —— 默认放行是危险的默认值。

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

同一个维度里 `allow` 与 `deny` 不能同时写，写了就抛。匹配的口径：`tools` 按工具名，`skills` 按技能 id，`mcps` 按服务器名，`subagents` 按那个委派工具的函数名。

过滤作用在候选名上、发生在实例化之前，于是被拒的能力不是「调用时才挡回来」—— 模型根本看不见它。看不见就不会去编，也不会反复试。

`PermissionEvaluator` 是这条规矩唯一的实现：`filter(candidates)` 一次过四维，`isAllowed(name, dimension)` 判一个名字，`match(name, policy)` 是一个不依赖实例的纯判据。

## 定义、配置与模型

| 成员 | 它管什么 |
|---|---|
| `ConfigManager` | `config.json` 和它旁边的目录：读写、出厂默认、坏文件恢复、思考档位表、出厂技能、`mcp.json` |
| `AgentRepository` | 一个文件一个助手定义，`<agentsDir>/<id>.json` |
| `createAgent(scope, agentId, options)` | 一个装好的 `SdkAgent`：读定义、解析模型、按过滤后的候选造工具 |
| `resolveModel` / `resolveModelParams` | 会话级覆盖 > 定义 > `config.defaultModel`，唯一的实现 |
| `createModel` / `createModelFromConfig` | `OpenAI` 客户端、模型名与请求参数 |
| `completeOnce` | 一次不带工具、不带历史的非流式调用 |

模型三级解析，越靠近「这一次」越优先：会话级覆盖（这一段会话说过「这次用这个模型」）、助手定义上绑的模型、`config.defaultModel` 兜底。三级都空就是真的没有模型，`createAgent` 直接报错，不静默挑一个出厂模型顶上 —— 否则用户以为在用配置里那个，请求和账单落在别处。

解析的产物是值加档位两件事，因为参数要跟着档位走：参数取「模型来自哪一级」的那一份，不跨级混合。会话把模型换掉之后，助手定义那份参数是配给旧模型的（可能带着旧模型才认的 `thinking` 形状），混进来就是把旧参数发给新模型。所以换模型的会话什么都不带，让模型走自己的出厂参数。

`createAgent` 的选项：

| 选项 | 干什么 |
|---|---|
| `modelId` / `modelParams` | 会话那一级的覆盖，与 `modelId` 同级的那一份参数 |
| `lifetime` | `"one-shot"` 造一个跑一次就死的执行体；缺省常驻 |
| `canOpenPeers` | 这一段会话能不能再开平级会话（见下） |
| `abortedToolRoundStrategy` / `abortedMessageStrategy` | 两个中断策略，不传就取 `config.json` 里的同名配置，再缺才用内核默认值 |

`SdkAgent` 是一个 `Agent`，另外带着 `scope` 与 `definition`（生效中的那份定义，解析出来的模型已经写进去），还有 `useModel(modelId, modelParams?)` —— 就地换模型与参数，不杀执行体：记忆、排队区、两道闸、在途的请求一处都不动，下一次请求从头读那三格。

## 交接：只写文档与换手

`HandoffService` 两半：先写出一份交接文档，再决定要不要用它换掉记忆。

| 方法 | 干什么 |
|---|---|
| `handoff(params)` | 给执行体一条指令去写那份文档，会话的其余部分一概不动 |
| `migrate(params)` | 写完文档，算出新的记忆并提交它 |

谁写文档有两档：`self`（同一个执行体，在它自己的会话里写 —— 默认）与 `summary`（拿序列化后的历史单独调一次模型，没有工具、没有原会话上下文）。两者之间没有自动过渡：申请哪个就跑哪个，做不成就报失败 —— 换一个执行者接着做，会让一次失败的交接看起来像成功。

旧记忆怎么处置有两档策略：`omit`（打标记 `omit: true` 留着，之后不再发给模型 —— 默认）与 `prune`（物理删除，只留定义里的模板消息）。

换完的记忆只有两截：模板（系统提示那几条）与末尾一条交接断点 —— `role: system`、`hidden`、正文只带文档路径。这份形状在 SDK 里算完，`commitMemory` 只决定它落到哪：不给，SDK 就地把 `agent.messages` 换成新记忆；给了，SDK 一个字节都不动，由调用方落库。

`HandoffGuardPlugin` 是交接那一批的守卫：那一批里唯一放行的写是写交接文档本身，其余写工具一律被拒，并给出一句模型能读懂、能照着办的句子。它还观察那次写到底发生了没有（`arm` 交回一个结果与一个「这批结束」的 promise，`disarm` 之后一切照旧放行）。它防的是工作目录被写坏，不是沙箱：shell 命令照样能写文件。

取消只认调用方递进来的 `signal`：服务自己不持有取消句柄。取消以 `HandoffAbortedError` 的形式出现，不降级、不在另一种模式下悄悄重跑一次 —— 那会白烧一次全量请求。`handingOff` 说的是「本服务这一趟正在跑」，自动交接插件据此让行，防止交接触发自动交接、自动交接再触发交接。

## 执行体插件

挂在执行体上，不挂在容器上。

| 插件 | 干什么 |
|---|---|
| `AutoMigratePlugin` | 闲下来的那一刻看一眼上一次回答的 `prompt_tokens`，越过软线就 `migrate()`；手里拿着 `HandoffService` 与 `handoffTokens`，`resolveMode` 决定这一次谁来写 |
| `AutoRefreshToolsPlugin` | 重新发现一次能力，再按新的发现结果重建工具表；缺省每次请求前刷，可配成每批开头只刷一次 |
| `ContextGuardPlugin` | 硬线：请求前用量超过 `guardTokens` 就拒这一次请求；交接那一趟也不让路 |
| `SubAgentGuardInstallerPlugin` | 把同一条硬线装到 subagent 上 —— 只护主会话等于没护 |
| `HandoffGuardPlugin` | 交接那一批的写守卫 |
| `UnknownToolHintPlugin` | 模型调了一个不存在的工具时给一句提示（MCP 那侧尤其用得上） |
| `AssetTransportPlugin` | 按当前模型把素材还原成真东西，发出去的那一份按实发模型重建 |

两条用量线都是绝对值：`handoff`（软线，响应回来后 `prompt_tokens` 超过它就交接）与 `guard`（硬线，请求前超过它就拒）。`guard` 该明显大于 `handoff`，给交接那一批额外的请求留余量；想调松就调大数字，没有隐式倍数。

## 平级会话

平级会话是执行体给自己开的另一段会话：它有自己的执行体、自己的上下文、自己的用量，之后留在会话列表里。

模型那一侧是三个工具，它们自己不实现任何东西。

| 工具 | 干什么 |
|---|---|
| `create_session` | 开一段平级会话，立刻回 `{ sessionId, label }` |
| `read_session_status` | 它在干还是闲、还活着没有、叫什么名字、最后一条消息的摘要 |
| `post_message` | 往那段会话的 inbox 里放一条消息 |

`PeerSessionsScopePlugin` 收一个带三个方法的 `PeerSessionPort` —— `create`（建完立刻回）、`status`（现读加最近一句摘要）、`send`（投递不等结果）—— 不给端口就一个工具都不产出。运行时实现的正是这个端口（`RuntimePeerSessions`），所以没有宿主在场时那三个工具也能用。

投递不看两段会话之间是什么关系，回执只说明那条消息进了对方的 inbox。拒绝是结构化的，模型读得懂也能改策略：`gone`（没有这段会话）与 `dead`（行在，后面没有执行体，于是没人会取）；创建还可能被 `depth_exceeded`、`model_unresolved` 拒掉，端口自己限量时还有 `too_many_peers`。

平级会话历史的摘要与消息条数一概不返回：模型只拿到最近一句的一小段，于是它不会把另一段会话的记录当成自己的上下文搬进来。

防套娃是结构上的，不是调用时才校验：本身就是被当作平级会话开出来的执行体，`createAgent` 拿到的是 `canOpenPeers: false`，它手上没有 `create_session` —— 开平级会话只有一层深，模型连试都试不了。`post_message` 与 `read_session_status` 留着，平级之间是双向说话的。这条规矩用 `exclude` 落地，不动定义里的 `permissions`：定义文件是用户可编辑的配置，这条规矩不长在那儿。

## 两个后台工具

两个内置工具立刻返回、事后才报。

| 工具 | 干什么 |
|---|---|
| `async_exec` | 在后台跑一条 shell 命令；它的输出与退出状态作为一条新消息递回这段会话 |
| `async_timeout` | 一个定时器；到点时把带着任务 id 的一条消息递回来 |

两个都只投递，模型手上没有第二个工具去「查结果」或「等结果」，也不轮询。结果通过一次递话回到同一段会话，低优先级，于是永远不落在正跑着的那一批里。任务 id 来自每个执行体一个计数器（`async_exec-1`、`async_timeout-2`），执行体停下或被杀时，还在跑的全部收掉。

一次性执行体两个都拿不到（`ASYNC_TASK_TOOL_NAMES` 在装配时被摘掉）：结果回来时它的调用栈已经退回去了，没有人可以递。这和内核就「常驻与一次性」说的那条是同一条规矩，落在「挑工具」这一步上。

## Scopes：容器什么时候拆

`Scopes` 持有能力容器的登记表：一个 `cwd` 一个容器，那个目录上的每段会话共用它。

| 成员 | 干什么 |
|---|---|
| `for(cwd)` | 那个目录的容器，第一次用到时造 |
| `dispose(cwd)` | 拆掉它 —— 那个目录上还有会话活着时拒绝 |
| `refreshAll()` | 让每个已经造好的容器重读配置，报刷了几份、哪几份没刷成 |
| `disposeAll()` | 全拆，给进程退出用 |

没有空闲计时器，没有引用计数，也没有自动回收：容器活着是因为有人拿着它，有人拆它才拆。「没人用了」不是一个可判定的状态。拆的时候拒绝，而不是连带拆掉别的东西 —— 连带会悄悄杀掉正办到一半的会话。

「配置改完即生效」就落在这里：配置一变，运行时让每份已造好的容器重读一遍，容器再让插件重新发现一次；MCP 那一侧按定义对账，删掉的和改过的断开，没改过的一个字节都不动。没人用过的目录不在其中 —— 它没有容器，下一次 `for` 会按新配置造一个。

## 运行时：唤醒与发话

`AgentRuntime` 一段会话一个常驻执行体，并把内核的事实转发出去。

| 成员 | 干什么 |
|---|---|
| `wake(sessionId, materials)` | 装配、登记、开跑；幂等，并发的调用共用一次装配 |
| `post({ from, to, content })` | 往另一段会话的 inbox 里放一句；回 `{ ok: true }` 或一个原因（`gone` / `dead`） |
| `status(sessionId)` | 在干还是闲、还活着没有、叫什么名字、最后一条消息的摘要 |
| `openPeer({ from, prompt, agentId?, modelId?, label? })` | 开一段平级会话、唤醒它、递上第一句、立刻返回 |
| `kill(sessionId)` | 注销、杀死、报它没了 |
| `close()` | 杀掉一切，拆掉每个容器 |
| `observe(listener)` | 订阅事实；返回退订函数 |
| `get(sessionId)` / `sessionOf(agent)` / `aliveOn(cwd)` | 快照：哪个执行体、哪段会话、那个目录上有哪几段会话活着 |
| `scopes` / `peerSessions` | 容器登记表，以及这个运行时实现的平级会话端口 |

`post` 投递不创建、也不复活会话：目标没有执行体就是没投出去，由发起方自己决定怎么跟用户说。两条拒绝原因要分得开 —— `gone` 是这段会话不在了，`dead` 是行还在、只是没人取件。投递优先级是低：寄来的话不该插进对方手上那一批的工具调用之间。

事实是一个可判别联合：`resident:appeared` 与 `resident:gone`（运行时自己的两个）、`scope:appeared` / `scope:refreshed` / `scope:gone`（来自容器登记表），以及每个执行体的每条内核事件 —— 名字与载荷都不变，多一个 `sessionId`。

运行时上没有「等到它做完」这种东西：常驻会话没有做完的那一刻，它从在干回到闲，随时可以被再推一条。运行时里没有任何东西替调用方等；叫醒一段会话的是一次递话。装配不出来就抛，并且不留登记项 —— 装了一半的会话在登记表里，等于告诉外面「它活着」，而它连件都收不了。

## 示例

```ts
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
// 一次把 config.json、默认助手定义、mcp.json 与出厂技能释放到位（已存在的文件不覆盖）
await config.bootstrap();

const scope = new Scope({
  getConfig: () => config.read(),
  agentsDir: `${base}/agents`,
  cwd: base,
}).use(...allInOne({ mcpPaths: [`${base}/mcp.json`] }));
await scope.init();

const agent = await createAgent(scope, DEFAULT_AGENT_ID);

const idle = new Promise<void>((resolve) => {
  const offIdle = agent.on("state:idle", () => {
    offIdle();
    resolve();
  });
});

agent.push({ content: "What is a Scope?", priority: "low", source: { kind: "user" } });
void agent.start();
await idle;

console.log(agent.messages.at(-1)?.content);
agent.stop();
await scope.dispose();
```

两段会话互相发话的那一份在[快速开始](getting-started.md)里：`AgentRuntime` 装上执行体、留一份「谁活着」的登记，`post` 把一条话寄给另一段会话，被投的那一段自己从闲变成忙、跑完回到闲。

## 往下读

- [快速开始](getting-started.md) —— 不经过宿主的最小 agent，以及两段会话互相发话
- [架构](architecture.md) —— 四层的判据、活物的四问、事实与材料的方向
- [Core API](core.md) —— 这个包垫在下面的那一个：inbox、两个循环、两道闸、事件与钩子
- [MCP](mcp.md) —— 服务器的配置从哪来、怎么连、工具怎么给模型
