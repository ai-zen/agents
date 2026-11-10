---
title: 架构
description: 六个包的分层与单向依赖、agents-server 的进程模型与协议面规模、协议包为什么独立成包、构建与测试顺序、以及 <aiZenDir> 的落盘布局。
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

（`packages/` 下另有 `test-project`（私有 fixture 包）、`test-home` 与 `webui`（两个目录都没有 `package.json`，不是包）。CLI 与桌面端是**独立仓库**，不在本 monorepo 内。）

## 分层与依赖方向

依赖是**单向**的，永不反向：

```
@ai-zen/agents-core ←──────── @ai-zen/agents-sdk ←──── @ai-zen/agents-server ←── bin: agents-server
      ↑ (仅类型)                                              ↑
@ai-zen/agents-protocol ←──────────┬─────────────────────────┘
      ↑                            │
@ai-zen/agents-client ──────────────┴──→ @ai-zen/cli / desktop main
```

三条都是 `package.json` 里的事实：`sdk` 依赖 `core`；`server` 依赖 `sdk` **与** `protocol`；
`client` **只**依赖 `protocol`（`dependencies` 里一项）。`protocol` 对 `core` 只是一次
`import type`（`Message` / `Usage` / `ToolCall` 的形状），编译后抹掉 —— 它的运行期依赖只有 `node:*`。

**`client` 与 `server` 之间没有边**：谁都不依赖谁，两侧都只依赖 `protocol`。这不是靠纪律
维持的（「只许走某个子路径」），是结构保证的 —— 这也是协议包独立成包的全部理由。

### 每层管什么、不管什么

- **core** —— 管：对话运行时（`Agent` / `Message` / `Tool` / `ToolCallContext`、插件与事件系统）。不管：权限、文件系统、配置、持久化——它的 `src/` 里没有任何 `node:*` 内置模块的导入。依赖只有 `openai` 与 `@ai-zen/event-bus`。
- **sdk** —— 管：业务能力层。能力管线（发现 → 过滤 → 实例化）、权限模型、MCP 生命周期、任务交接与迁移、内置工具、`ConfigManager`。依赖 `@ai-zen/agents-core`、`@modelcontextprotocol/sdk`、`dayjs`、`openai`。不管：进程与连接、会话存档、工作区、任何「客户端长什么样」的事。
- **protocol** —— 管：两进程之间的**线上契约**。怎么找到对方（`<aiZenDir>/run/server.json` 的形状与原子读写）、怎么说话（JSON-lines 帧编解码、`hello` 握手、`callOnce`）、说什么形状（方法名表、事件名表、参数/结果类型、错误码表、`PhaseInfo`、数据模型的类型出口）。不管：任何业务判断、任何状态机、任何 UI 概念 —— 这里没有一行代码知道「会话该怎么存活」，只有它**在线上的样子**。
- **server** —— 管：会话编排（`SessionManager`）、存档（`FileSessionStore`）、工作区（`service/workspace/workspace.ts`）、配置与 Agent 定义的服务端读写（`ConfigService`）、资产清单（`AssetService`）、事件出口（`EventHub`），以及把这一切接到一条 TCP 连接上的 `Daemon`。`dependencies` 是 `@ai-zen/agents-sdk` 与 `@ai-zen/agents-protocol` 两项。不管：UI 栈（不依赖 ink / react / 终端库——包边界就是进程边界）、进程级全局（cwd / 全局配置路径 / 全局 locale）。这两条硬约束写在 `packages/server/src/index.ts` 的文件头，唯一例外是组装根 `src/cli.ts`。
- **client** —— 管：一个前端到服务端之间**全部**需要在客户端发生的事：服务发现与拉起、一条 TCP 连接、会话与配置两张门面、两个判据（要不要把 cwd 递上去、服务端现在什么状态）。`dependencies` **只有** `@ai-zen/agents-protocol`。不管：服务端实现（`Daemon` / `SessionManager` / 装配），也不读进程级全局。
- **CLI / 桌面端 main** —— 管：渲染与输入。两者都只依赖 `@ai-zen/agents-client`（以及协议类型）。

### 反向没有边

可以用 grep 检验（命令出自 `packages/server/README.md` 与 `packages/client/README.md`）：

- `packages/sdk/src` 与 `packages/core/src` 里搜不到 `agents-server`；
- `packages/server/src` 里没有对 `agents-client` 的 import；
- `packages/client/src` 的生产代码里没有对 `@ai-zen/agents-server` 的 import，见下文「client 包的三条纪律」；
- `packages/protocol/src` 里搜不到 `service/` / `daemon/` / `domain/`（协议不认识任何一方的实现）。

### Agent 装配按工作区

`server` 里一个工作区共用一个 `Scope`（一套 MCP 连接与一次工具发现），**不跨工作区共用**——缓存键是工作区路径，值是 `Promise`（并发建会话共享同一次初始化）。理由是两头的：同工作区分开装会每个会话多一套 MCP 连接；跨工作区共用则会把 A 项目的项目级 skills / tools / mcp 塞给 B 项目。见 `packages/server/src/service/agent/SessionAgentFactory.ts` 文件头。

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

### 进程内的分工

- `src/cli.ts` 是**组装根**：唯一允许读 env / argv 的地方（`AI_ZEN_DIR`、`HOME`、命令行参数），把路径解析成值后注入给下面的对象。`src/service/` 与 `src/daemon/` 一律不读全局。
- `src/daemon/` 只管「字节流 → 帧 → 方法调用」：`Daemon` 自己只带 `ping` / `status` / `shutdown` 三个方法，其余方法表由组装根通过 `DaemonOptions.handlers` 注入。
- `src/service/` 是业务：会话编排、存档、工作区、配置、资产、事件。
- 线上契约不在本包里 —— 它在**独立的** `@ai-zen/agents-protocol`（见下一节），本包只依赖它。

两个 idle 是两个不同的东西：`--idle-timeout` 是整个守护进程（一个连接都没有了，多久后退出，缺省不退出），`--session-idle-timeout` 是单段会话（没人看着了，多久后回收）。

日志写 `<aiZenDir>/logs/server.log`：守护进程是客户端 detached 拉起的，绝不能往客户端终端写。

## 协议面：45 个方法 / 12 个事件

方法名与事件名都是 `as const` 常量表，客户端与服务端共用同一份字面量。**统计口径**：数这些表里的条目——一个方法名字面量算一条；参数 / 结果类型不算；三个内置方法（`ping` / `status` / `shutdown`）**算**方法（它们和其它方法一样要握手后才能调，只是由 `Daemon` 自己实现）；通知码（`SESSION_NOTICE_CODES` / `GLOBAL_NOTICE_CODES`）不算事件，它们是 `session.notice` / `server.notice` 载荷里的枚举。

| 命名空间 | 条数 | 定义处 |
|----------|------|--------|
| `workspace.*` | 6 | `sessions.ts` 的 `WORKSPACE_METHODS` |
| `session.*` | 22 | `sessions.ts` 的 `SESSION_METHODS` |
| `events.watch` | 1 | `sessions.ts` 的 `EVENT_METHODS`（连接级，不属于任何会话） |
| `config.*` | 7 | `config.ts` 的 `CONFIG_METHODS` |
| `agent.*` | 5 | `config.ts` 的 `AGENT_METHODS` |
| `asset.*` | 1 | `assets.ts` 的 `ASSET_METHODS` |
| 内置 `ping` / `status` / `shutdown` | 3 | `daemon.ts` 的 `DAEMON_METHODS` |
| **合计** | **45** | |

事件共 **12** 条，分两张表：`sessions.ts` 的 `SESSION_EVENTS`（11 条，值全部以 `session.` 开头）—— `session.phase`、`session.delta`、`session.toolCalls`、`session.messageAppended`、`session.turnEnd`、`session.notice`、`session.question`、`session.idChanged`、`session.titleChanged`、`session.subAgent.started`、`session.subAgent.ended`；以及同一个文件的 `SERVER_EVENTS`（1 条）—— `server.notice`。

五条与本文件有关的性质：

- 事件载荷只装**事实**（阶段 kind、工具名、正文字符串），不装文案——渲染成哪种语言由客户端决定。
- `session.delta` 是**文本流**（每片追加），`session.toolCalls` 是**组装态**（每次给「到现在为止是什么」）：语义不同就不合进一条事件，否则客户端得猜哪个字段该接、哪个该替。
- `session.messageAppended` 推的是**一条完整消息**（工具结果：`role: "tool"` + `tool_call_id` + 正文），逐条推、不等快照：工具结果在 core 里是逐个定型的，快照却要等 `session.turnEnd`，长轮次里用户会盯着参数卡片等好几分钟。
- `send` 立刻返回 `turnId`，一轮的后续全部走事件：一轮可能跑几分钟，等它跑完再回，客户端就没有任何东西可渲染。
- 命名空间按**作用对象**分：`workspace.*` 是对容器做事，`session.*` 是对一段会话做事，`events.watch` 是连接级的，`asset.*` 只读（资产是用户的文件系统，改它是另一个动作）。事件同理：`session.*` 是**会话事件**（载荷里有 `sessionId`），`server.notice` 是**服务端自己的通知**（不属于任何会话，切会话也不该消失）—— 前缀就能判断该看哪张表，不必背清单。

每个方法/事件的入参、出参与语义**不在这里抄**——那是 `packages/server/README.md` 的事。这里只给分类与规模。

## 协议包：`@ai-zen/agents-protocol`

契约原来住在服务端包里，开成一个子路径（`@ai-zen/agents-server/protocol`）。它现在是**独立的包**
（`packages/protocol`），`packages/server/package.json` 的 `exports` 因此只剩 `.`。

**为什么搬出去**：契约是**双方的东西**。住在其中一方家里，包依赖图就必然是 `client → server`，
于是「客户端不该拖进服务端实现」只能靠纪律维持（只许走子路径、产物依赖图必须闭合），而
**纪律会腐化，结构不会**。搬出来之后那条边根本不存在：`server` 与 `client` 都只依赖协议包。

**桌面端 main 是打包产物**：import 图上出现 `@ai-zen/agents-server` 的主入口，整套服务端实现
（连带 `@ai-zen/agents-sdk`、MCP SDK、openai）就会被塞进安装包。这是「客户端只许依赖契约」的
现实理由。

判断标准同样硬：协议包里能 export 的东西都必须**零运行期外部依赖**。`index.ts` 只 `export *`
本包的模块（`frames` / `messages` / `daemon` / `sessions` / `config` / `assets` / `discovery` /
`host` / `phase` / `errors` / `model` / `call-once`），这些模块只 import 兄弟模块与 `node:*`；
唯一跨出去的是 `model.ts` 对 `@ai-zen/agents-core` 的一次 `import type`（编译后抹掉）。

三处细节：

- **`discovery` 也在协议里**：`<aiZenDir>/run/server.json` 的形状与读写同样是跨进程契约
  （服务端写、客户端读，决定「要不要连、连哪个端口」）；放进服务端的 `daemon/` 会让人以为
  它属于服务端内部实现。
- **用 `export *` 而不是逐个列符号**：协议每加一条方法就要补一行导出，忘了就是「导出不存在」，
  而这类遗漏不会被任何门禁抓到。`export *` 让这里成为纯透传；代价是符号重名会编译失败——
  那正是想要的提醒。
- **协议现在也转出数据模型的类型**（`Message` / `Usage` / `ToolCall`，见 `model.ts`）。原来的
  口径是「协议刻意不认识消息形状」，代价没被记账：每个客户端都得 `import type … from
  "@ai-zen/agents-core"` 才能读一条消息。落盘格式与线上形状本来就是同一份，所以只声明一次。

`client` 把这个包原样转出（`packages/client/src/index.ts` 末尾 `export * from
"@ai-zen/agents-protocol"`），所以上层只要认一个包：方法名常量、结果类型、帧编解码、
数据模型类型都在手边，且**不是**第二份定义。

## `client` 包的三条纪律

这三条写在 `packages/client/README.md` 里。

### 1. 运行期只依赖协议包

`dependencies` 里只有 `@ai-zen/agents-protocol`。这条现在是**结构**（client 与 server 之间
没有边），不再是纪律：

```bash
node -e 'console.log(Object.keys(require("./packages/client/package.json").dependencies))'
# 只有 [ "@ai-zen/agents-protocol" ]
```

`devDependencies` 里另有三个 workspace 包，都只为类型与用例（不进产物）：`agents-sdk` 给
`config-port.ts` 的 `AppConfig` / `AgentDefinition` / `ReasoningPresets`（`import type`，
产物 `dist/*.js` 里没有它，但 `dist/*.d.ts` 里有）；`agents-server` 给用例的真 `Daemon`；
`agents-core` 给用例的真 `AgentNS.Role`。

### 2. 产物的运行期依赖图必须闭合

`npm run build` 之后 `dist/*.js` 的外部 import 只允许 `@ai-zen/agents-protocol`（其余是同级
相对路径与 `node:*`）。`config-port.ts` 里那句 `import type … from "@ai-zen/agents-sdk"` 只为
「配置 / 定义在两端的共同形状」提供类型，在产物里被整体擦除。

### 3. 不读进程级全局

`aiZenDir`（配置根）与 `clientInfo`（握手时自称的身份）都由**组装根注入**：CLI 在
`src/server-client/index.ts`、桌面端在 main 的启动处各读一次 env / `app.getVersion()`。
两者都是「应用级事实」，而本包是库，拍不了这个板——否则桌面端拉起服务端时会自称是 CLI。

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

## 数据落盘布局

配置根记为 `<aiZenDir>`：`--ai-zen-dir` 参数、否则 `AI_ZEN_DIR`、否则 `<HOME>/.ai-zen`（`packages/server/src/cli.ts` 的 `parseArgs`）。这条路径只由组装根解析一次，之后以参数注入。

| 路径 | 内容 | 出处 |
|------|------|------|
| `<aiZenDir>/config.json` | 全局配置（形状 = SDK 的 `AppConfig`） | `service/agent/agentPaths.ts` 的 `globalAgentPaths` |
| `<aiZenDir>/agents/` | 顶层 Agent 定义（一实体一 JSON） | 同上；`sdk/src/config/constants.ts` 的 `CONFIG_SUB_DIRS` |
| `<aiZenDir>/sub-agents/` | 子 Agent 定义 | `src/cli.ts` 注入 `ConfigService` 的 `subAgentsDir`；同上 `CONFIG_SUB_DIRS` |
| `<aiZenDir>/skills/` | 全局 Skill | `agentPaths.ts` 的 `globalSkillsDirs`；`CONFIG_SUB_DIRS` |
| `<aiZenDir>/tools/` | 全局用户工具 | `agentPaths.ts` 的 `globalToolsDirs`；`CONFIG_SUB_DIRS` |
| `<aiZenDir>/mcp-oauth/` | MCP OAuth 凭据目录 | `sdk/src/config/constants.ts` 的 `CONFIG_SUB_DIRS` |
| `<aiZenDir>/mcp.json` | 全局 MCP 配置 | `src/cli.ts` 注入 `ConfigService` 的 `globalMcpFile`；`agentPaths.ts` 的 `mcpConfigs` 末段 |
| `<aiZenDir>/workspaces/<workspaceId>/workspace.json` | 工作区身份与位置（id 冻结） | `service/workspace/workspace.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.json` | 会话存档（正文 + 元数据，原子写） | `service/store/FileSessionStore.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.meta.json` | 该会话的列表清单（无正文） | 同上 |
| `<aiZenDir>/workspaces/<workspaceId>/last-session.json` | 「本工作区上一轮会话」指针 | 同上 |
| `<aiZenDir>/run/server.json` | 服务发现文件 | `@ai-zen/agents-protocol` 的 `discovery.ts` 中 `descriptorPath` |
| `<aiZenDir>/logs/server.log` | 守护进程日志（追加写） | `src/cli.ts` 的 `openLog` |

`workspaceId` 的形状是 `<目录名规范化>-<sha256(绝对路径) 前 8 位>`，例如 `/home/ubuntu/projects/ai-zen/cli` → `cli-3f9a1c2b`。它只是**首次分配**时的候选，分配之后冻结：`mv` 之后 id 不变，要靠 `workspace.relocate` 显式改记录里的 path，否则历史会「挪个目录就没了」（`workspace.ts` 文件头）。

项目层的资产不在这里，挂在工作区目录上：`<ws>/.ai-zen/skills`、`<ws>/.ai-zen/tools`、`<ws>/.ai-zen/sub-agents`，MCP 配置的优先级链是 `<ws>/.mcp.json` → `<ws>/.ai-zen/mcp.json` → `<ws>/.agents/mcp.json` → `<aiZenDir>/mcp.json` → `~/.agents/mcp.json`（`agentPaths.ts`；顺序就是优先级，项目层在前）。

## 相关文档

- [Core API](core.md) —— 运行时公开 API 与实现细节
- [SDK](sdk.md) —— 能力层公开 API
- [检索与 RAG](rag.md) —— 检索能力现状
- [MCP](mcp.md) —— MCP 接入与生命周期
- [`packages/server/README.md`](../../packages/server/README.md) —— 服务端：方法逐个语义、会话层细节、运维口径
- [`packages/client/README.md`](../../packages/client/README.md) —— 连接层：三条硬约束与 grep 检验
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) —— SDK 设计真相源
