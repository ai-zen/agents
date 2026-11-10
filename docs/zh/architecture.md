---
title: 架构
description: 五个包与两个应用的分层与单向依赖、每层管什么不管什么、协议面 44 个方法 / 17 个事件、协议为什么独立成包、client 的传输/门面/会话三层、server 的目录、会话寿命的唯一规则、SessionManager 的四件、<aiZenDir> 落盘布局与构建测试顺序。
outline: deep
---

# 架构

AI-Zen Agents 是一个 **pnpm monorepo**（工作区根 `@ai-zen/agents-workspace`，私有，`2.0.0`）。`packages/` 下与本文件相关的是六个包：

| 包 | 版本 | 定位 |
|----|------|------|
| `@ai-zen/agents-core` | 4.5.5 | 对话运行时内核 |
| `@ai-zen/agents-sdk` | 1.1.0 | 业务能力层 |
| `@ai-zen/agents-protocol` | 0.1.0 | 两进程之间的线上契约：方法/事件名、载荷形状、错误码、帧、发现文件、`callOnce` |
| `@ai-zen/agents-server` | 0.1.0 | 常驻服务端：会话编排 / 存档 / 工作区 |
| `@ai-zen/agents-client` | 0.1.0 | 到服务端的连接层 |
| `@ai-zen/agents-testing` | 0.1.0 | 私有，测试替身（OpenAI 兼容的假流式端点） |

（`packages/` 下另有 `test-project`（私有 fixture 包）、`test-home` 与 `webui`（两个目录都没有 `package.json`，不是包）。CLI 与桌面端是**独立仓库**，不在本 monorepo 内，但它们在本文件的依赖图里各有位置。）

## 分层与依赖方向

依赖是**单向**的，永不反向：

```
@ai-zen/agents-core ←──────────── @ai-zen/agents-sdk ←──────── @ai-zen/agents-server ←── bin: agents-server
      ↑ (仅类型)                                                   ↑
@ai-zen/agents-protocol ←─────────────────────────────────────────┘
      ↑
@ai-zen/agents-client ←── bin: ai (cli) / desktop main
```

读法：`A ← B` 是「B 依赖 A」。五条边都是 `package.json` 里的事实 ——

| 从 | 到 | 形态 |
|----|----|------|
| `sdk` | `core` | 运行期依赖 |
| `protocol` | `core` | **只有** `model.ts` 的一次 `import type`（`Message` / `Usage` / `ToolCall` 的形状），产物里擦除 |
| `server` | `sdk` + `protocol` | 运行期依赖，`dependencies` 两项 |
| `client` | `protocol` | 运行期依赖，`dependencies` **只有这一项** |
| `cli` / `desktop main` | `client`（CLI 另加 `sdk` / `core`） | 应用侧依赖。两仓的 `dependencies` 里也都有 `server` —— 它们经 `ensureServer` 拉起服务端，得能定位它的 bin；方向上它们只是 `client` 的使用者 |

### 三条硬性质

每一条都能用命令证伪，而不是靠「记得别那么写」。

**① `client` 与 `server` 之间没有边。** 两侧都只依赖 `protocol`，谁都不依赖谁。

```bash
# 依赖表：只有协议一项
node -e 'const d=require("./packages/client/package.json").dependencies; if(Object.keys(d).join()!=="@ai-zen/agents-protocol") throw new Error(Object.keys(d).join())'

# 源码：除注释与那一个例外文件外，不该出现 agents-server
grep -rn 'agents-server' packages/client/src --include=*.ts | grep -v '\.test\.' | grep -v 'ensure-server\.ts' | grep -v '^\S*:[0-9]*: *\*'
# 必须为空
```

唯一例外是 `ensure-server.ts`：它要 spawn 一个 `agents-server serve`，就得知道那个 bin 在哪，只能 `require.resolve("@ai-zen/agents-server/package.json")`（那个包不在就抛错）。这是**部署策略，不是分层**：所以它不在 `dependencies` 里 —— 宿主应用（CLI / 桌面端）本来就装着服务端包；不想走这条路的应用可以注入自己的 `startServerProcess`，那样连那个 `resolve` 都不会跑。消费点只有那一个文件。

**② `protocol` 运行期零第三方依赖。** 类型上依赖 `core`，但那是 `import type`，产物里擦除。

```bash
# 源码：滤掉测试、node:* 与类型转出之后，只剩本包的相对路径
grep -rn '^import\|^\} from' packages/protocol/src | grep -v '\.test\.' | grep -v 'node:' | grep -v 'agents-core'

# 产物侧才是真正的裁决
(cd packages/protocol && npm run build && grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u)
# 期望只有 ./xxx.js 与 node:*
```

**③ `protocol` 是数据模型的唯一出口。** `Message` / `Usage` / `ToolCall` / `ModelParams` / `PhaseInfo` 都从协议取，客户端不再自己去 `core` 里捞。

```bash
grep -rn '@ai-zen/agents-core' packages/client/src --include=*.ts | grep -v '\.test\.' | grep -v '^\S*:[0-9]*: *\*'
# 必须为空
```

为什么这值得一条硬性质：`Message` 的形状既是落盘格式（存档 JSON）也是线上形状。给它再造一份「线上镜像」就是第二份定义 —— 而这个项目最忌讳的正是第二份定义。所以它只在一个地方（协议）声明。

### 反向没有边

- `packages/sdk/src` 与 `packages/core/src` 里搜不到 `agents-server`；
- `packages/server/src` 里没有对 `agents-client` 的 import；
- `packages/client/src` 的生产代码里没有对 `@ai-zen/agents-server` 的 import（除上面那一个例外）；
- `packages/protocol/src` 里搜不到 `domain/` / `daemon/` / `lib/`（协议不认识任何一方的实现）。

## 每层管什么、不管什么

| 包 / 应用 | 管 | 不管 |
|---|---|---|
| `core` | 对话运行时：`Agent` / `Message` / `Tool` / `ToolCallContext`、插件与事件系统 | 权限、文件系统、配置、持久化 —— `src/` 里没有任何 `node:*` 内置模块的导入。依赖只有 `openai` 与 `@ai-zen/event-bus` |
| `sdk` | 业务能力：能力管线（发现 → 过滤 → 实例化）、权限模型、MCP 生命周期、任务交接与迁移、内置工具、`ConfigManager` | 进程与连接、会话存档、工作区、任何「客户端长什么样」的事。依赖 `core`、`@modelcontextprotocol/sdk`、`dayjs`、`openai` |
| `protocol` | 线上契约：怎么找到对方（发现文件的形状与原子读写）、怎么说话（帧编解码、`hello` 握手、`callOnce`）、说什么形状（方法名表、事件名表、载荷类型、错误码表、阶段形状、数据模型的类型出口） | 任何业务判断、任何状态机、任何 UI 概念 —— 这里没有一行代码知道「会话该怎么存活」，只有它**在线上的样子** |
| `server` | 会话编排、存档、工作区、配置与 Agent 定义的服务端读写、资产清单、事件出口，以及把这一切接到一条 TCP 连接上的 `Daemon` | UI 栈（不依赖 ink / react / 终端库 —— 包边界就是进程边界）、进程级全局（cwd / 全局配置路径 / 全局 locale）。两条硬约束写在 `packages/server/src/index.ts` 的文件头，唯一例外是组装根 `src/cli.ts` |
| `client` | 一个前端到服务端之间**全部**需要在客户端发生的事：服务发现与拉起、一条 TCP 连接、会话与配置两张门面、**会话流状态机**（三个前端必须一致的那部分「想」）、两个判据（要不要把 cwd 递上去、服务端现在什么状态） | 渲染、本地化、进程级全局、任何服务端数据的本地读写 |
| `cli`（独立仓） | 渲染与输入（ink）、斜杠命令与会话层、把 `SessionStream` 的状态画出来 | 会话编排、存档、工作区、配置写入 —— 那些都在服务端。它依赖 `client`，另加 `sdk` / `core`（应用要用 `AgentDefinition` 这类业务类型与 `Role` / `MessageStatus` 这类**运行期 enum**） |
| `desktop main`（独立仓） | 应用级事实（`app.getVersion()` 当 `clientInfo`）、拉起服务端、订阅事件并把状态转给 renderer | 服务端实现本身。它今天还持有一份**自己的**会话状态机（见「已知缺口 / 未完成」） |

## 协议面：44 个方法 / 17 个事件

方法名与事件名都是 `as const` 常量表，客户端与服务端共用同一份字面量。**统计口径**：数这些表里的条目 —— 一个方法名字面量算一条；参数 / 结果类型不算；三个内置方法（`ping` / `status` / `shutdown`）**算**方法（它们和其它方法一样要握手后才能调，只是由 `Daemon` 自己实现）；通知码（`SESSION_NOTICE_CODES` / `SERVER_NOTICE_CODES`）不算事件，它们是 `session-notice` / `server-notice` 载荷里的枚举。

| 命名空间 | 条数 | 定义处 |
|----------|------|--------|
| `workspace.*` | 6 | `sessions.ts` 的 `WORKSPACE_METHODS` |
| `session.*` | 21 | `sessions.ts` 的 `SESSION_METHODS` |
| `events.watch` | 1 | `sessions.ts` 的 `EVENT_METHODS`（连接级，不属于任何会话） |
| `config.*` | 7 | `config.ts` 的 `CONFIG_METHODS` |
| `agent.*` | 5 | `config.ts` 的 `AGENT_METHODS` |
| `asset.*` | 1 | `assets.ts` 的 `ASSET_METHODS` |
| 内置 `ping` / `status` / `shutdown` | 3 | `daemon.ts` 的 `DAEMON_METHODS` |
| **合计** | **44** | |

事件共 **17** 条，分三张表，都在 `sessions.ts`：

| 表 | 条数 | 事件名 | 定义 |
|----|------|--------|------|
| `AGENT_EVENTS` | 9 | `open`、`chunk`、`chunk-parsed`、`parsed`、`tool-call-end`、`error`、`finally`、`sub-agent-start`、`sub-agent-end` | 值逐字等于 core `Agent.events` 的原名，时机也照抄 core |
| `SESSION_EVENTS` | 7 | `session-phase`、`session-tool-calls`、`session-turn-end`、`session-notice`、`session-question`、`session-id-changed`、`session-title-changed` | 服务端派生 / 服务端自己的动作 |
| `SERVER_EVENTS` | 1 | `server-notice` | 服务端自己的通知（不属于任何会话） |
| **合计** | **17** | | |

五条与本文件有关的性质：

- 事件载荷只装**事实**（阶段 kind、工具名、正文字符串），不装文案——渲染成哪种语言由客户端决定。
- `AGENT_EVENTS` 的 9 条是 core 的原名（`open` / `chunk` / `chunk-parsed` / `parsed` / `tool-call-end` / `error` / `finally` / `sub-agent-start` / `sub-agent-end`），服务端在 core 发它的**同一刻**原样转上线，一条不改名。其中 `open` / `chunk` / `parsed` / `error` / `finally` 客户端今天用不到，但照样发 —— 协议面是 core 的公开事实，用不用是客户端的事。
- 时机是硬的：同一片 `chunk` 早于 `chunk-parsed`；`error` 早于 `finally`；`finally` 早于 `session-turn-end`（后者是服务端落盘、换 id、回收判定都做完之后）。`finally` 与 `session-turn-end` 是**两条不同的事件**，不是改名关系。
- `chunk-parsed` 是**文本流**（每片追加），`session-tool-calls` 是**组装态**（每次给「到现在为止是什么」）：语义不同就不合进一条事件，否则客户端得猜哪个字段该接、哪个该替。
- `tool-call-end` 推的是**一条完整消息**（工具结果：`role: "tool"` + `tool_call_id` + 正文），逐条推、不等快照：工具结果在 core 里是逐个定型的，快照却要等 `session-turn-end`，长轮次里用户会盯着参数卡片等好几分钟。
- `send` 立刻返回 `turnId`，一轮的后续全部走事件：一轮可能跑几分钟，等它跑完再回，客户端就没有任何东西可渲染。
- 命名空间按**作用对象**分：`workspace.*` 是对容器做事，`session.*` 是对一段会话做事，`events.watch` 是连接级的，`asset.*` 只读（资产是用户的文件系统，改它是另一个动作）。事件同理：`session-` 前缀是**会话事件**（服务端派生或服务端自己的动作，载荷里有 `sessionId`），`server-notice` 是**服务端自己的通知**（不属于任何会话，切会话也不该消失），`AGENT_EVENTS` 那 9 条说的是**一个 Agent 身上发生了什么**（名字就是 core 的名字）—— 看一眼名字就知道该看哪张表，不必背清单。

每个方法/事件的入参、出参与语义**不在这里抄**——那是 `packages/server/README.md` 的事。这里只给分类与规模。

## 协议为什么是独立包

`@ai-zen/agents-protocol`（`packages/protocol`）是**一个独立的包**，不是任何一方的一部分。

**理由只有一条**：契约是**双方的东西**。住在其中一方家里，包依赖图就必然是 `client → server`，于是「客户端不该拖进服务端实现」只能靠纪律维持 —— 只许走某个子路径、产物依赖图必须闭合。而**纪律会腐化，结构不会**。搬出来之后那条边根本不存在：`server` 与 `client` 都只依赖协议包，谁都不依赖谁。今天 `packages/server/package.json` 的 `exports` 只有两项（`.` 与 `./package.json`，后者是 `ensure-server` 定位 bin 用的），没有任何「为了让客户端能用而开的口子」。

**桌面端 main 是打包产物**，这是同一条理由的现实版本：import 图上出现 `@ai-zen/agents-server` 的主入口，整套服务端实现（连带 `@ai-zen/agents-sdk`、MCP SDK、openai）就会被塞进安装包。

判断标准同样硬：协议包里能 export 的东西都必须**零运行期外部依赖**。`index.ts` 只 `export *` 本包的模块（`frames` / `messages` / `daemon` / `sessions` / `config` / `assets` / `discovery` / `host` / `phase` / `errors` / `model` / `call-once`），这些模块只 import 兄弟模块与 `node:*`；唯一跨出去的是 `model.ts` 对 `@ai-zen/agents-core` 的一次 `import type`（编译后抹掉）。

三处细节：

- **`discovery` 也在协议里**：`<aiZenDir>/run/server.json` 的形状与读写同样是跨进程契约（服务端写、客户端读，决定「要不要连、连哪个端口」）；放进服务端的 `daemon/` 会让人以为它属于服务端内部实现。
- **用 `export *` 而不是逐个列符号**：协议每加一条方法就要补一行导出，忘了就是「导出不存在」，而这类遗漏不会被任何门禁抓到。`export *` 让这里成为纯透传；代价是符号重名会编译失败——那正是想要的提醒。
- **协议也转出数据模型的类型**（`Message` / `Usage` / `ToolCall` / `ModelParams`，见 `model.ts`），因为落盘格式与线上形状本来就是同一份。这条与硬性质③是同一件事的两个说法：**声明一次，而不是让每个客户端各自去 core 里捞**。

`client` 把这个包原样转出（`packages/client/src/index.ts` 末尾 `export * from "@ai-zen/agents-protocol"`），所以上层只要认一个包：方法名常量、结果类型、帧编解码、数据模型类型都在手边，且**不是**第二份定义。

## `client` 包的三个层次

包内按「脏 / 纯」和「谁负责什么」分三层。凡是能纯的都不碰 I/O，这样状态机可以被直接单测。

| 层 | 文件 | 职责 |
|---|---|---|
| **传输** | `transport/connection.ts`（`ServerConnection`） | **一个进程一条连接**：每次取用都判 `closed`、断了就重建、重建后在新连接上重新订阅 `events.watch`、断线与就绪都往上说（`onClose` / `onOpen`）。它**不重试** —— 重试是会话层的规则 |
| | `ensure-server.ts` | 读 `<aiZenDir>/run/server.json`；探活（`callOnce` 问一句 `ping`）失败就 detached 拉起 `agents-server serve`，轮询到 `ping` 通。它是包里**唯一**知道 `agents-server` 的地方（部署策略，不是分层） |
| | `socket-server-client.ts` | 一条 TCP + JSON-lines 连接：`hello` 握手、在飞调用、事件分发、断开通知 |
| **门面** | `facade/sessions.ts`（`RemoteSessions`，27 条） | `session.*`(21) + `workspace.*`(6) 的类型化薄封装 |
| | `facade/config.ts`（`RemoteConfig`，13 条） | `config.*`(7) + `agent.*`(5) + `asset.*`(1) |
| | `facade/coverage.test-d.ts` | 门面方法集合 **===** 协议方法表 key 集合，**100% 覆盖**由类型保证：少一条、多一条都编译不过 |
| **会话** | `session/stream.ts`（`SessionStream`） | **纯**状态机：一轮之内的消息 / 阶段 / 模型 / 用量 / 子 Agent / 失败终态。零 I/O、零 timers、零全局 |
| | `session/channel.ts`（`SessionChannel`） | 脏的那一半：订阅、请求、重连（三条不变式）、重新 `attach`、`close` 当场回收 |
| | `session/errors.ts` | 「这段会话还在不在」的唯一判据：`session-missing` 与 `unknown-session` **都算**会话没了 |

纯件还有一份在包根：`stream-merge.ts`（`mergeStreamedSnapshot`，本地增量与服务端快照的合并规则，唯一实现）。它放根上是因为前端与应用都要显式用它。**没有**「agent view」这类视图层文件：子 Agent 栏目是 `SessionStreamState.subAgents` 里的一份数据。

**为什么这么切**：这一块**不是展示**。它决定「屏幕上的答案会不会凭空短一截」「子任务失败会不会被显示成成功」「这一轮到底结束没有」—— 三个前端都会错、且会错得一样。一纯一脏的分界（`SessionStream` / `SessionChannel`）与 `PhaseTracker`（纯）/ `SessionManager`（脏）那一刀是同一条道理：纯的那个可以直接单测，脏的那个只做接线。

`SessionStream` 不给 `send()`，也不给「等这一轮」：**「等这一轮」在 `SessionChannel.waitForTurn(turnId)`**。因为 `session-turn-end` 有可能先于 `send()` 的回执落地，把两件事合成一个 promise 就得在里面记一份「已经收尾过的轮次」才能不挂死 —— 那正是 `waitForTurn` 干的事。

### 三条硬约束（都能用命令检验）

1. **运行期只依赖协议包** —— 见「分层与依赖方向」的硬性质①。`devDependencies` 里另有四个 workspace 包，都只为类型与用例，不进产物。
2. **产物的运行期依赖图必须闭合**：`npm run build` 之后 `dist/*.js` 的外部 import 只允许 `@ai-zen/agents-protocol`，其余是同级相对路径与 `node:*`。

   ```bash
   cd packages/client && npm run build
   grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u
   ```

   > 检查命令必须锚在行首的 `^import`。不锚的话，本包文档注释里那句 `import type … from "@ai-zen/agents-sdk"` 会被自己 grep 到，得出「拖了 sdk」的错误结论 —— 这一步实际踩过。

3. **不读进程级全局**：`aiZenDir`（配置根）与 `clientInfo`（握手时自称的身份）都由**组装根注入**。两者都是「应用级事实」，而本包是库，拍不了这个板 —— 否则桌面端拉起服务端时会自称是 CLI。

## `server` 包的目录

```
packages/server/src/
  domain/       业务对象，每个子目录一个
    session/      SessionManager + EventBridge + Persistence + QuestionBroker
                  （+ LiveSession 形状、AutoTitle、store/ 存档端口与实现）
    workspace/  agent/  config/  asset/  handoff/
  lib/          无业务语义的通用零件：phase.ts（PhaseTracker）、events.ts（EventHub）
  daemon/       传输与接线：Daemon / wire / params / *Handlers
  cli.ts        组装根（唯一读 env / argv 的地方）
  index.ts      包对外桶（`export *`，撞名会编译失败——那正是提醒）
```

`domain/` 与 `lib/` 的**分界线**是这条：`domain/` 里是**业务对象**（它知道「会话」「工作区」是什么，也允许知道规则），`lib/` 里是**无业务语义的通用零件** —— `phase.ts` 是生成阶段的状态机，`events.ts` 是连接扇出，两者都不认识会话、存档与握手。`EventHub` 只有 50 来行，但别合并它：`watcherCount()` 承担一条真实业务判定（没人在看就别向客户端提问），而那条判定的用户在 `QuestionBroker` 手里。

其余两处：

- **`daemon/` 只管「字节流 → 帧 → 方法调用」**：`Daemon` 自己只带 `ping` / `status` / `shutdown`，其余方法表由组装根通过 `DaemonOptions.handlers` 注入。这一层**不做业务编排** —— 它只验参数形状、接线；需要读别的对象再决定做什么的判定属于 `domain/`（例：「删工作区要连带关活会话」下沉成了 `SessionManager.closeWorkspace`）。
- **`cli.ts` 是组装根**：唯一允许读 env / argv 的地方（`AI_ZEN_DIR`、`HOME`、命令行参数），把路径解析成值后注入给下面的对象；`domain/`、`lib/`、`daemon/` 一律不读全局。**`index.ts` 是 `export *` 桶**，不是方法清单。

线上契约不在本包里 —— 它在独立的 `@ai-zen/agents-protocol`，本包只依赖它。

### Agent 装配按工作区

`domain/agent/` 里一个工作区共用一个 `Scope`（一套 MCP 连接与一次工具发现），**不跨工作区共用**——缓存键是工作区路径，值是 `Promise`（并发建会话共享同一次初始化）。理由是两头的：同工作区分开装会每个会话多一套 MCP 连接；跨工作区共用则会把 A 项目的项目级 skills / tools / mcp 塞给 B 项目。见 `packages/server/src/domain/agent/SessionAgentFactory.ts` 文件头。

## 服务端进程模型

### 常驻进程与单实例

`agents-server` 是 `@ai-zen/agents-server` 的 bin（`dist/cli.js`），子命令 `serve`（缺省）/ `status` / `stop`。

`serve` 启动前先读发现文件：pid 还活着且能 `ping` 通，就打印 `already running on <host>:<port>` 并以退出码 1 收场；pid 已死则把残留文件收掉继续启动。**单实例判断只在服务端做一份**，客户端不重复实现（`packages/client/src/ensure-server.ts` 文件头）。

### 发现文件

位置 `<aiZenDir>/run/server.json`，形状由 `packages/protocol/src/discovery.ts` 的 `ServerDescriptor` 定义：

| 字段 | 含义 |
|------|------|
| `pid` | 判断「上次是不是崩了」——进程不在了就收掉残留文件 |
| `host` / `port` | 连哪儿（端口可能被占，服务端会退回系统分配，所以不能靠猜） |
| `protocol` | 协议版本，连之前先做一次粗判 |
| `version` | 服务端包版本，用于版本漂移提示与诊断 |
| `startedAt` | 启动时刻 |
| `schema` | 发现文件的 schema 版本，当前恒为 `1` |

写是原子的（先写 `.tmp` 再 `rename`），避免客户端读到半个 JSON；读不到 / 内容坏掉一律返回 `null`（视为「没有在跑」）。

### 传输与握手

- **TCP + JSON-lines**：一行一个 JSON，`\n` 结尾；单帧上限 8 MiB，超了判协议错误并断开连接（`packages/protocol/src/frames.ts`）。选 JSON-lines 是为了能用手搓工具调试，并能原样塞进 WebSocket 文本帧与 stdio。
- **首帧必须 `hello`**：客户端先发 `{ kind: "hello", protocol, client: { name, version } }`，服务端回同形状回执，带 `ok` 与 `server: { name, version, protocol, pid, startedAt }`。**没有例外**——即使当前还没有鉴权，也必须先握手，否则「将来加鉴权」就得改所有客户端的建连逻辑（`packages/protocol/src/messages.ts` 文件头）。
- 之后两个方向的消息各两类：请求/响应 `{ id, method, params }` → `{ id, ok, result | error }`；事件 `{ event, ... }` 由服务端主动推、无 `id`、不等回执。
- 协议版本 `PROTOCOL_VERSION = 1`；任何不兼容的字段变化都要 +1，不做「尽力兼容」。

### 只绑回环

`Daemon.start()` 对 host 做断言：不是回环地址就抛错拒绝启动（`packages/server/src/daemon/Daemon.ts`）。判据 `isLoopbackHost()` 在 `packages/protocol/src/host.ts`，认 `localhost`、`::1`、以及 `127.0.0.0/8` 整段（按 RFC 1122，不是只有 `127.0.0.1`）。

这条不是占位符：本版**没有鉴权**，而服务端暴露的能力里有 `exec`（任意命令执行），未鉴权的端口一旦能被非本机访问，等于把 shell 送给整个局域网。默认 `127.0.0.1:8790`；`--port 0` 让系统分配。

两个 idle 是两个不同的东西：`--idle-timeout` 是整个守护进程（一个连接都没有了，多久后退出，缺省不退出），`--session-idle-timeout` 是单段会话（没人看着了，多久后回收）。

日志写 `<aiZenDir>/logs/server.log`：守护进程是客户端 detached 拉起的，绝不能往客户端终端写。

## 一段会话的寿命只有一条规则

> 连接上有持有者 → 活着；持有者没了 → 宽限期后回收；`session.close` → 立刻回收。

就这样三条，**没有第二个判据**。

`holders` 是「此刻真有一条连接在看着它」：由传输层登记（`session.create` / `session.attach` 登记调用方那条连接），连接断开时摘掉（挂在 `connection.onClose` 上）。它不需要客户端配合 —— 连接消失是**内核保证的**（进程被 `kill -9`、崩溃、断电都会让那条 socket 消失）。宽限期是 `DEFAULT_SESSION_IDLE_TIMEOUT_MS`（60 s，`--session-idle-timeout`），够覆盖客户端最坏情况下的重连预算；到点时会**重新判一遍**规则，所以窗口内到达的 `attach` 只是取消这次回收，而还在跑的一轮会把回收推到 `session-turn-end`。

**为什么没有「客户端上报的保活意图」**：那种设计的判据是「上报的意图 **与** 持有者的合取」，而两个事实里只有一个在**最难的情况**下还成立 —— 崩溃的进程发不出那一帧，声明会永远停在「要」，会话连同它占的 Agent 与消息历史永久留在内存里（本包跑在回环上，唯一的回收时机是重启守护进程）；而持有者是内核保证的事实，同样的崩溃恰好把它清干净。取合取只是把不可靠的那个当成了必要条件。这条理由的唯一「为什么」现场是 `SessionManager.ts` 的文件头。

两条**行为后果**必须记账，不许说成「机制少一个、行为不变」：

- 切走一段会话而连接仍在（TUI 的 `/new`、`/load`、`rollback` 后重挂载）时**必须显式 `close()` 旧的那段**，否则内存峰值随切换次数线性增长，直到宽限期才回落；
- 一次性调用（`ai "…"`）跑完也要 `close()`，否则每跑一次就往常驻服务端留一段活会话。
  这两件事的出口都在 `SessionChannel.close()`（它 `await session.close()`，让服务端当场回收）。

## `SessionManager` 的四件

`domain/session/` 下的会话是四个类加一份形状文件，全部靠构造参数拿协作者（互不 `import`）。拆分判据不是行数，是**「谁拥有 `LiveSession` 的哪些字段」**：

| 文件 | 拿走的东西 | 职责 |
|---|---|---|
| `SessionManager.ts` | 注册表 `sessions` / `holders` / 回收 / turn 生命周期（`beginTurn` / `settleTurn` / `failTurn`）/ 目录（`list` / `last` / `rename` / `remove` / `rollback`）/ 交接（`handoff` / `migrate` / `autoMigrate`）/ `create` / `attach` / `close` / `dispose` | 注册表与轮次生命周期 —— 「我正在管的那批会话」 |
| `EventBridge.ts` | `toolCalls` / `pushedMessages` / 流式影子 / 子 Agent 栏目 | SDK 事件 → 协议事件。只依赖 `agent.events` + `hub`，**不需要会话表、不需要 store** |
| `Persistence.ts` | `store` / `record` / `persistOnSettle` / `autoPersist` | 存档形状与全部写盘路径。**`recordOf` 是存档形状唯一定义处** |
| `QuestionBroker.ts` | `questions` / `questionSeq` | 服务端向客户端提问：认领、超时、放行。唯一需要 `hub.watcherCount()` 的组件 —— **没人在看就不问** |
| `LiveSession.ts` | — | 那段会话的形状，以及 `AgentLike` / `SubAgentLike` / `AskQuestionSpec`。四个类都只依赖它 |

`LiveSession` 单独一份的理由是「拆了但还在一个团里」的反面：形状留在其中任一个类里，另外三个就得 `import` 那个类。字段仍然长在同一个对象上（不是四张表）—— 它们说的是同一段会话的四个面，分成四张表就意味着四条「按 id 查回来」的路径，而那种查不到的状态最难解释。

`SessionManager` 不碰文件（只经 `SessionStore` 端口），也不读配置（要「配置 + Agent 定义」才算得出来的东西，由组装根注入成窄函数）。这条边界让它可测：给一个假 Agent 就能跑完整个事件流程。

## 数据落盘布局

配置根记为 `<aiZenDir>`：`--ai-zen-dir` 参数、否则 `AI_ZEN_DIR`、否则 `<HOME>/.ai-zen`（`packages/server/src/cli.ts` 的 `parseArgs`）。这条路径只由组装根解析一次，之后以参数注入。

| 路径 | 内容 | 出处 |
|------|------|------|
| `<aiZenDir>/config.json` | 全局配置（形状 = SDK 的 `AppConfig`） | `domain/agent/agentPaths.ts` 的 `globalAgentPaths` |
| `<aiZenDir>/agents/` | 顶层 Agent 定义（一实体一 JSON） | 同上；`sdk/src/config/constants.ts` 的 `CONFIG_SUB_DIRS` |
| `<aiZenDir>/sub-agents/` | 子 Agent 定义 | `src/cli.ts` 注入 `ConfigService` 的 `subAgentsDir`；同上 `CONFIG_SUB_DIRS` |
| `<aiZenDir>/skills/` | 全局 Skill | `agentPaths.ts` 的 `globalSkillsDirs`；`CONFIG_SUB_DIRS` |
| `<aiZenDir>/tools/` | 全局用户工具 | `agentPaths.ts` 的 `globalToolsDirs`；`CONFIG_SUB_DIRS` |
| `<aiZenDir>/mcp-oauth/` | MCP OAuth 凭据目录 | `sdk/src/config/constants.ts` 的 `CONFIG_SUB_DIRS` |
| `<aiZenDir>/mcp.json` | 全局 MCP 配置 | `src/cli.ts` 注入 `ConfigService` 的 `globalMcpFile`；`agentPaths.ts` 的 `mcpConfigs` 末段 |
| `<aiZenDir>/workspaces/<workspaceId>/workspace.json` | 工作区身份与位置（id 冻结） | `domain/workspace/workspace.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.json` | 会话存档（正文 + 元数据，原子写） | `domain/session/store/FileSessionStore.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.meta.json` | 该会话的列表清单（无正文） | 同上 |
| `<aiZenDir>/workspaces/<workspaceId>/last-session.json` | 「本工作区上一轮会话」指针 | 同上 |
| `<aiZenDir>/run/server.json` | 服务发现文件 | `@ai-zen/agents-protocol` 的 `discovery.ts` 中 `descriptorPath` |
| `<aiZenDir>/logs/server.log` | 守护进程日志（追加写） | `src/cli.ts` 的 `openLog` |

`<aiZenDir>` 下**没有按前端分家的目录**：会话属于**工作区**，CLI 与桌面端共享同一份数据。指针也不按 cwd 分键 —— 工作区自己就是分区键，所以它是单指针（`last-session.json`）。

`workspaceId` 的形状是 `<目录名规范化>-<sha256(绝对路径) 前 8 位>`，例如 `/home/ubuntu/projects/ai-zen/cli` → `cli-3f9a1c2b`。它只是**首次分配**时的候选，分配之后冻结：`mv` 之后 id 不变，要靠 `workspace.relocate` 显式改记录里的 path，否则历史会「挪个目录就没了」（`workspace.ts` 文件头）。

项目层的资产不在这里，挂在工作区目录上：`<ws>/.ai-zen/skills`、`<ws>/.ai-zen/tools`、`<ws>/.ai-zen/sub-agents`，MCP 配置的优先级链是 `<ws>/.mcp.json` → `<ws>/.ai-zen/mcp.json` → `<ws>/.agents/mcp.json` → `<aiZenDir>/mcp.json` → `~/.agents/mcp.json`（`agentPaths.ts`；顺序就是优先级，项目层在前）。

## 构建与测试顺序

根 `package.json` 的 scripts：

| script | 做什么 |
|--------|--------|
| `build-core` | `pnpm --filter @ai-zen/agents-core build` |
| `build-sdk` | `pnpm --filter @ai-zen/agents-sdk build` |
| `build-protocol` | `pnpm --filter @ai-zen/agents-protocol build` |
| `build-server` | `pnpm build-protocol && pnpm --filter @ai-zen/agents-server build` |
| `build-client` | `pnpm build-protocol && pnpm --filter @ai-zen/agents-client build` |
| `test` | `pnpm build-testing && pnpm build-server && pnpm build-client`，然后依次跑 `protocol` → `testing` → `core` → `sdk` → `server` → `client` 的 `test` |

**为什么是这个顺序**：包之间靠 `dist` 解析，不靠源码路径。每个包的 `main` / `types` / `exports` 都指向 `dist/`，pnpm 只是把 workspace 包软链进 `node_modules`（软链的落点还是包的 `package.json`，于是解析到 `dist`），各包也没有 `paths` 之类的源码映射；每个包的 `build` 是 `prebuild`（`rimraf ./dist`）+ `tsc`。上游不先产出 `dist`，下游连类型都看不见。

于是操作口径是：

- **改了协议**（`packages/protocol/src/`）→ 先 `pnpm build-protocol`。否则 `server` 与 `client` 的 `tsc` 拿不到新的方法名常量与结果类型——它们读的是 `@ai-zen/agents-protocol` 的**产物**。
- **改了客户端层**（`packages/client/src/`）→ `pnpm build-client`。它自带 `build-protocol`（协议是它的直接依赖）。
- **`build-server` 也自带 `build-protocol`**：改完协议只跑一条命令就能重编服务端。两者都不含 core / sdk（那两条是独立脚本）。干净检出要按 `build-core` → `build-sdk` → `build-protocol` → `build-server` → `build-client` 走一遍。
- **`pnpm test` 显式构建 `testing` / `server` / `client`**（后两者连带 `protocol`）；`core` / `sdk` 的产物必须事先由 `build-core` / `build-sdk` 备好，否则依赖它们的包会在 `pretest`（`tsc --noEmit`）与 `vitest` 阶段解析不到。client 的用例会起**真 Daemon**，所以 `server` 的 `dist` 也必须在。
- 只跑单个包的用例：`pnpm --filter @ai-zen/agents-server test`（前提同上：它的上游 `dist` 在）。

## 已知缺口 / 未完成

- **桌面端 main 已经用上 `SessionStream`**（`desktop@49c82c1`，`events.ts` 838 → 665 行）：手写的增量累积、子 Agent 合并、收尾整份替换、`failed` 判定全部删了，只剩「喂事件 / 映射成 `ChatStreamEvent`」。留着没搬的两块**是桌面端独有的事实**，不是重复：① `user` 事件的正文（协议不推用户消息）；② 占位 assistant 消息的 id（render 的 `v-for` key 需要它，而状态机刻意不给流式消息编 id）。
- **`SessionStream` 还差三个出口**（桌面端因为缺它们各留了一小段 workaround，都在 `events.ts` 里且有注释）：① 流式消息的稳定 id（现在 main 自己按 `一轮一个` 编）；② 「丢掉某段会话的拼接态」的公开入口（现在靠 `new SessionStream()` 整台替换）；③ `applySnapshot` 不对齐 `state.turnId`（现在 main 自己拿快照比对残影）。
- **服务端 README 的 handler 清单落后于协议**：`packages/server/README.md` 里那段「registers …」漏了 6 条会话方法（`session.snapshot` / `session.rollback` / `session.save` / `session.saveAs` / `session.model.set` / `session.modelParams.set`），还把事件 `session-question` 当方法列了出来。README 本身待改，清单的唯一真相是 `SESSION_METHODS`。
- **方法表命名不同构**：`EVENT_METHODS`（单数）与其余五张方法表（复数）不一致。纯命名问题，改它要动两处引用。
- **`Role` / `MessageStatus` 是 core 的 `enum`（运行期值）**，所以**应用**（CLI / 桌面端）依赖 core 是正当的。若要让应用也只依赖协议，得把数据词汇落到底层包 —— 本轮判定不划算，不做。
- **`packages/sdk/src/config/constants.ts` 的注释仍在描述按前端分家的运行时目录**（`~/.ai-zen/<前端>/`），与「会话属于工作区、`config.json` 在 `<aiZenDir>` 下」的现状不符。
- **一轮收尾时若快照取失败**，桌面端仍推 `error`（与改造前一致：本地近似里那条占位消息没有稳定 id，不能塞进 `done`）。真窗口里要确认错误条出现且输入框恢复。

## 相关文档

- [Core API](core.md) —— 运行时公开 API 与实现细节
- [SDK](sdk.md) —— 能力层公开 API
- [检索与 RAG](rag.md) —— 检索能力现状
- [MCP](mcp.md) —— MCP 接入与生命周期
- [`packages/server/README.md`](../../packages/server/README.md) —— 服务端：方法逐个语义、会话层细节、运维口径
- [`packages/client/README.md`](../../packages/client/README.md) —— 连接层：三个层次、三条硬约束与 grep 检验
- [`packages/protocol/README.md`](../../packages/protocol/README.md) —— 契约包：包里有什么、三条硬约束
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) —— SDK 设计真相源
