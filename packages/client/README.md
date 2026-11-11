# @ai-zen/agents-client

到 `agents-server` 的**连接层**：服务发现与拉起、消息编解码、会话与配置门面。
CLI（TUI）与 Desktop（main）共用同一份实现：两个前端各写一份，就会在 `hello` 握手、
重连、错误码上慢慢分叉。

## 包里有什么

按「脏 / 纯」分层 —— 凡是能纯的都不碰 I/O，这样状态机可以被直接单测。

| 文件 | 脏/纯 | 职责 |
|---|---|---|
| `transport/connection.ts` | 脏 | **一个进程一条连接**（`ServerConnection`）：每次取用都判活、断了就重建、重建后在新连接上重新订阅 `events.watch`、断线与就绪都往上说 |
| `socket-server-client.ts` | 脏 | 一条 WebSocket + JSON-RPC 2.0 连接：`hello` 握手、在飞调用（可带一块二进制帧载荷）、事件分发、断开通知 |
| `ensure-server.ts` | 脏 | 读 `<aiZenDir>/run/server.json`；探活（`callOnce` 问一句 `ping`）失败就 detached 拉起 `agents-server serve`，轮询到 `ping` 通。**给了显式地址时只连、绝不拉起** |
| `resolve-target.ts` | 脏 | 「连哪儿 + 拿什么进门」的**唯一解析点**：地址优先级（显式 > 发现文件）、凭证优先级（显式 > `run/token`）、`unauthorized` 的对症说法。地址能指向远端，凭证就不能只从本地文件读 —— 两件事必须同源 |
| `session/channel.ts` | 脏 | **一条会话的 I/O**（`SessionChannel`）：订阅、请求、重连（三条不变式）、重新 `attach`、`close` 当场回收 |
| `session/stream.ts` | 纯 | **一轮之内的状态机**（`SessionStream`）：消息 / 阶段 / 模型 / 用量 / 子 Agent / 失败终态 |
| `stream-merge.ts` | 纯 | 「本地流式增量」与「服务端快照」的合并规则（`mergeStreamedSnapshot`，唯一实现） |
| `session/errors.ts` | 纯 | 「这段会话还在不在」的唯一判据（`isSessionGone`；`session-missing` 与 `unknown-session` **两个都算**） |
| `tsconfig.pure.json` + `session/pure-boundary.test.ts` | 门禁 | 纯边界**是机制而不是约定**：`stream.ts` 的 import 图只许 `agents-server/protocol`（类型）+ `stream-merge`，进 `agents-server` **包根** / `agents-sdk` 就编译不过 |
| `facade/sessions.ts` | 纯 | `session.*`(21) + `workspace.*`(6) + `content.*`(1) 的类型化门面（`RemoteSessions`），100% 覆盖 |
| `facade/config.ts` | 纯 | `config.*`(7) + `agent.*`(5) + `asset.*`(1) 的类型化门面（`RemoteConfig`），100% 覆盖 |
| `facade/coverage.test-d.ts` | 类型 | 门面方法集合 === 协议方法表 key 集合（少一条、多一条都编译不过） |
| `config-port.ts` | 应用端口 | 配置面（`ConfigPort`）：把线上形状兑现成 `AppConfig` / `AgentStore` 这些应用类型，实现建在 `RemoteConfig` 上 |
| `status.ts` | 脏 | `--server-status` 背后的只读诊断（不拉起，`callOnce` 问一句 `status`） |
| `local-host.ts` | 纯 | 「服务端是不是在这台机器上」→ 决定要不要把客户端 cwd 当工作区递上去 |
| `mcp.ts` | 类型 | `mcp.json` 的形状（读写归服务端） |
| 协议 | 类型 | `@ai-zen/agents-server/protocol` 原样**类型转出**：方法/事件名的字面量联合、载荷类型、错误码联合、数据模型类型（只 `import type`，编译后不剩） |
| `wire/` | 脏 | **本包自己那一份运行期实现**：消息编码与体积上限（`frames.ts`）、错误码判据（`errors.ts`）、回环判据（`host.ts`）、版本号（`messages.ts`）、发现文件读（`discovery.ts`）、一次性问话（`call-once.ts`）、地址形状与 URL 拼法（`server-url.ts`）、凭证读端（`token.ts`）。协议只共享类型，代码各写各的 |

## 地址与凭证：一个解析点

服务端可以不在本机。这一层要回答的两个问题是「连哪儿」与「拿什么进门」，而它们必须**同源**：

| 什么 | 优先级（左高右低） | 归一在 |
|---|---|---|
| 地址 | `--server <url>` > `AI_ZEN_SERVER_URL` > `<aiZenDir>/run/server.json` | `resolve-target.ts`（`readExplicitTarget`）+ `wire/server-url.ts`（`parseServerUrl`） |
| 凭证 | `AI_ZEN_SERVER_TOKEN` > `<aiZenDir>/run/token` > 无 | `resolve-target.ts`（`resolveToken`）+ `wire/token.ts`（`readToken`） |

四条理由，每条都是一个具体的错：

- **地址能指向远端，凭证就不可能只来自本地文件。** `--server https://your.domain/ai-zen` 那台机器上的 `<aiZenDir>/run/token` 与它手里那把锁毫无关系。反过来，只把地址做成可配、凭证仍然就地读文件，得到的是最难查的半远程状态 —— 连得上、握手被拒，而错误信息不说为什么。所以 `unauthorized` 的措辞也在这里定，且按「地址是谁给的 × 凭证从哪来」分成几句对症的话：只给一句「重启服务端」，在对面是隧道时指的就是错的机器。
- **地址的 URL 与拼法全包只准有一份。** `wire/server-url.ts` 既解析（`parseServerUrl`：接受 `ws` / `wss` / `http` / `https`，后两个按 `http → ws`、`https → wss` 映射；可带 path，nginx 子路径挂载需要它）也拼装（`webSocketUrl`：IPv6 加方括号、按 `secure` 出 `ws`/`wss`）。两份逐字相同的拼法，就有一份会先被改对。
- **显式地址永不拉起本地服务端。** 本地 `npx` 起的进程一定不在那个地址上，拉起只会白等一轮然后报一个指向错误方向的超时。所以 `ensure-server` 在拿到显式地址时只连。
- **没有 `--token`，这是有意的。** 地址不是秘密，可以进 argv；凭证是秘密，进了 argv 就会留在 `ps` 的输出与 shell 历史里。凭证只有环境变量与文件两个来源。

`wire/token.ts` 是**只读**的：写端只有服务端一个（客户端也生成的话，两个进程会各写一份、各自认为自己是那把锁，症状是「刚连上就被 `unauthorized`」）。部署侧怎么填这几个值见[部署与远程访问](../../docs/zh/deploy.md)。

## 三条硬约束（都能用命令检验）

### 1. 运行期依赖只有 `@ai-zen/agents-core`

运行期只有一条边，另有两个 peer 只为类型面：

- **协议不是依赖，是类型**：线上形状来自 `@ai-zen/agents-server/protocol`（服务端的类型文件），
  只做 `import type`；运行期那几件（消息编码与体积上限、错误码判据、回环判据）是本包 `src/wire/` 里
  自己的一份实现。`@ai-zen/agents-server` 因此只是 **peerDependency**（宿主必须提供它：
  类型面来自它）+ devDependency（本仓用例要起真 Daemon）。拉起服务端不走它 ——
  `ensure-server` 默认用 `npx` 现下现起，宿主的依赖表里不需要这一项；
- **SDK 同理，只是纯类型**：`ConfigPort` 的公开签名要 `AppConfig` / `AgentDefinition` /
  `ReasoningPresets`，而线上刻意把它们写成 `unknown`（契约不认识 SDK），兑现成类型正是这一层
  的职责。所以 `@ai-zen/agents-sdk` 也是 **peer + dev** —— 副本会随 sdk 的落盘格式各自漂，
  那是第二份定义；
- **`core`**：折 chunk（`applyChunk`）、用量求和（`sumUsage`）、角色枚举（`AgentNS.Role`）
  都是 core 的**唯一实现**。客户端要么引它，要么抄一份 —— 而抄一份就是给同一个概念立第二
  个定义（`{Assistant:"assistant"}` 镜像、重写一遍的求和函数），两边各自演化，症状只在某个
  角色的消息或某个子 Agent 的用量上显形。引它才是唯一不出第二份的选择。

```bash
# 依赖表：只许 core —— server / sdk 出现在 dependencies 里就是失败
node -e 'const p=require("./packages/client/package.json"); const bad=Object.keys(p.dependencies).filter(k=>/agents-(server|sdk)$/.test(k)); if(bad.length) throw new Error(bad.join()); console.log(Object.keys(p.dependencies), Object.keys(p.peerDependencies))'
# [ "@ai-zen/agents-core" ] [ "@ai-zen/agents-sdk", "@ai-zen/agents-server" ]
```

core 的运行期依赖只有 `@ai-zen/event-bus`（`openai` 在 core 里只出现在**类型位置**，
`packages/core/dist/*.js` 里没有它），所以这条边不会把 `openai` 拖进客户端产物。

`devDependencies` 里另有三个 workspace 包，只为**类型与用例**，不进产物（其中两个同时是 peer）：

| 包 | 为什么还在 |
|---|---|
| `@ai-zen/agents-sdk` | **peer + dev**：`config-port.ts` 的公开签名要 `AppConfig` / `AgentDefinition` / `ReasoningPresets`（线上传的是 `unknown`，客户端兑现成类型）。**只在 `import type` 里出现**，产物 `dist/*.js` 里没有它 —— 但 `dist/*.d.ts` 里有，所以宿主必须提供它，和 `server` 同理 |
| `@ai-zen/agents-server` | **peer + dev**：类型面（`protocol`）与用例（真 Daemon）都要它。运行期产物里一行都没有 —— 拉起服务端走 `npx`，不解析它的 `bin` |
| `@ai-zen/agents-testing` | 用例要一个**真讲协议**的假模型端点（`startFakeLlm`，`turn-and-resume.test.ts`），否则「一轮跑完再续接」只能靠手发帧凑 |

### 2. 产物的运行期依赖图必须闭合

```bash
cd packages/client && npm run build
grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u
```

期望输出只有 `@ai-zen/agents-core`、同级相对路径、`node:*` 三类 —— **没有 `@ai-zen/agents-server`**。
`@ai-zen/agents-sdk`（`AppConfig` / `AgentDefinition` / `ReasoningPresets`）只以 `import type`
出现在 `dist/*.d.ts` 里，产物运行期不加载它。

> 检查命令必须锚在行首的 `^import`。不锚的话，本包文档注释里那句 `import type … from
> "@ai-zen/agents-sdk"` 会被自己 grep 到，得出「拖了 sdk」的错误结论 —— 这一步实际踩过。

### 3. 不读进程级全局

`aiZenDir`（配置根）与 `clientInfo`（握手自称的身份）都由**组装根**注入：CLI 在
`src/server-client/index.ts`、桌面端在 main 的启动处各读一次 env / `app.getVersion()`。
显式地址与显式凭证（`--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN`）同理由组装根读
环境后以 `serverUrl` / `serverToken` 注入 —— 本包不读 `process.env`。
它们都是「应用级事实」，本包是库，拍不了这个板 —— 否则桌面端拉起服务端时会自称是 CLI。

## 用法

```ts
import {
  ServerConnection,
  SessionChannel,
  createRemoteConfigPort,
} from "@ai-zen/agents-client";

const clientInfo = { name: "@ai-zen/desktop", version: app.getVersion() };

// 一个进程一条连接：会话与配置面共用它，谁也不自己建
const connection = new ServerConnection({ aiZenDir, clientInfo });
// 服务端在另一台机器上时，同一个构造器多给两个字段（照旧是一个进程一条）：
//   new ServerConnection({ aiZenDir, clientInfo, serverUrl: "wss://your.domain/ai-zen",
//                          serverToken: process.env.AI_ZEN_SERVER_TOKEN })
const config = createRemoteConfigPort({ connection }); // ← 必须递同一个 connection

const channel = new SessionChannel({ connection, policy: { onChange, onNotice } });
await channel.open({ agentId: "default" }); // 内部会 events.watch + attach/open + 拉快照
const turnId = await channel.send("你好");
await channel.waitForTurn(turnId); // 界面靠它管 busy / 输入禁用
await channel.close(); // 显式回收这一段（服务端当场收）

// 断线重连由 channel 自己处理：重连到 3 次、递增退避、单飞，成功后重新 attach 并拉快照
connection.onClose(() => {
  /* 只是告知；重连不用你操心 */
});
```

### `SessionChannel` 与 `createRemoteConfigPort` **必须共用同一个 `ServerConnection` 实例**

为什么：连接是**进程级**的资源（D8）—— 一个进程一条。各建一条的后果不是「多占一个 socket」，
而是两份不同的连接视图：哪一条断了、`events.watch` 订在了谁身上、重连之后谁是新连接，
全部会分叉；而 `createRemoteConfigPort` 还会把工作区 id 缓存在自己的连接上（换连接才作废），
于是「会话开在 A 项目、项目级 `mcp.json` 读的却是别处」。

可 grep 的判据（每个进程的**组装根**里 `new ServerConnection(` 恰好一处，其余位置只把实例传下去）。
**注意路径**：CLI 与桌面端是两个独立仓，与本仓同级（`agents/` 的兄弟目录），所以从
`packages/client` 出发是 `../../../cli` 与 `../../../desktop`：

```bash
# 应用侧（CLI / 桌面端 main）里造连接的地方 —— 应当各只有组装根那一行
grep -rn 'new ServerConnection(' ../../../cli/src ../../../desktop/packages/main/src | grep -v '\.test\.'
# 期望：**恰好两行**，各是本进程的组装根（`cli/src/server-client/index.ts` 与
# `desktop/packages/main/src/server/index.ts`），且每个文件里只有这一行。
# 出现第二行就是「某个工具函数自己又建了一条」：配置面与会话各一条 = 两套连接视图。
#
# 库这一侧唯一那一处是 `createRemoteConfigPort` 的**兜底**（不递 `connection` 时它才自己建，
# 供「配置面先于会话」的场景）：应用应当显式递 `connection`，不靠兜底
grep -rn 'new ServerConnection(' src | grep -v '\.test\.'
# 期望：只有 `src/config-port.ts` 那一行（`createRemoteConfigPort` 的兜底）
```

已经有一条连接（或想自己管生命周期）就给 `{ client }` / `{ connect }`，此时
`aiZenDir` + `clientInfo` 可以不给 —— 它们只在**需要自己拉起服务端**时被读。
