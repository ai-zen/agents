# 目标架构（重构定稿）

> 本文是**重构期间的唯一设计真相源**。实施按本文的分阶段推进；每阶段落地后回来更新本文的「当前状态」，
> 全部完成后本文并入 `architecture.md` 并删除。
>
> 定稿依据：2026-11-10 的一次架构反思（对 `agents` / `cli` 两仓逐文件审计 + 实测复核）。
> 那次反思发现的病，本文逐条给出结构性解法，而不是逐条打补丁。

---

## 0. 这次重构要解决什么

| # | 现状之病 | 证据（实测） |
|---|---|---|
| 1 | **契约住在其中一方家里**：`protocol/` 在 `@ai-zen/agents-server` 内，于是包依赖图是 `client → server` | `client/package.json` 的 `dependencies` 有 `agents-server` / `sdk` / `core` |
| 1b | **「没人在服务就拉一个」让 client 必须认得 server 的 bin** | `ensure-server.ts` 用 `require.resolve("@ai-zen/agents-server/package.json")` 定位 bin |
| 2 | **契约反向依赖实现**：线上载荷形状由服务端内部状态机定义 | `server/src/protocol/sessions.ts:20` `import type { PhaseInfo } from "../service/progress/PhaseTracker.js"` |
| 3 | **一个意图三种表达**：`session.close`（零调用方）、一条由客户端上报的「保活声明」、断连接 | 三仓 `session.close` 仅一处测试在调 |
| 4 | **错误码是 19 个裸字符串**，客户端靠字面量匹配；而 notice code 有表 | `protocol/` 无 `ERROR_CODES`；`SESSION_NOTICE_CODES` 有 |
| 5 | **`codedError` 六份逐字相同** | SessionManager / AssetService / ConfigService / workspace / SessionAgentFactory / params |
| 6 | **事件命名不齐 + 表里装错东西** | `message.delta`、`turn.end` 无命名空间；`global.notice` 在 `SESSION_EVENTS` 里 |
| 7 | **协议把数据模型当 `unknown`**，于是每个客户端都得 import `agents-core` 才能读消息 | `messages: unknown[]`、`modelParams: unknown`、`message: unknown` |
| 8 | **门面不全**（会话覆盖 16/22、工作区 2/6；会话级动作挂在配置面），客户端只好裸调协议 | `RemoteSessions` vs `SESSION_METHODS` |
| 9 | **一轮状态机写了两遍**（CLI 应用层 + 桌面端 main），能复用的只有传输与 merge | `cli/tui/remote-chat-session.ts` 1276 行 / `desktop/main/src/server/events.ts` 773 行 |
| 10 | **分离靠"记得注入"维持**：客户端里留着服务端数据的本地读写缺省 | `cli/reasoning-effort.ts:264-267` 的 `??` 兜底写 `~/.ai-zen/agents/*.json` |
| 11 | **一个进程一条连接**没有归属，两个前端各写一遍，且两种实现都有漏洞 | `cli/tui/index.tsx` 手传 `configPort`；桌面 `connection.ts` 不查 `closed` |
| 12 | **`SessionManager` 2671 行 = 12 个并列职责**；`service/` 平铺了三种不同性质的东西 | 见审计 |
| 13 | **三份"连上服务端调一个方法"** | server 的 `cli.ts` / client 的 `status.ts` / `ensure-server` 的 ping |
| 14 | **死代码留在公开面** | `legacyMigration`（agents，零调用）、`format-time.ts` + `types.ts`（cli，零引用）、`packages/cli/` 空壳 |

**一句话诊断**：这个项目的**分层方向**是干净的（单向、可 grep、产物闭合），问题全在**契约的归属**和**边界的维持方式**上 —— 契约住在服务端包里，边界靠纪律维持而不是靠结构维持。

---

## 1. 包图谱（目标）

```
@ai-zen/agents-core                对话运行时
      ↑
@ai-zen/agents-sdk                 业务能力
      ↑
@ai-zen/agents-protocol   ★新      两进程之间：怎么找到对方 / 怎么说话 / 说什么形状
      ↑            ↑
@ai-zen/agents-server   @ai-zen/agents-client
      ↑                    ↑
   bin: agents-server   bin: ai (cli) / desktop main
```

三条硬性质（每条都能用命令证伪）：

1. **`client` 与 `server` 之间没有边** —— 两侧都只依赖 `protocol`，谁都不依赖谁；
2. **`protocol` 运行期零第三方依赖** —— 只 import 本包兄弟模块与 `node:*`；
3. **`protocol` 是数据模型的唯一出口** —— `Message` / `ModelParams` 等形状从 `protocol` 转出，
   客户端不再直接 `import type … from "@ai-zen/agents-core"`。

### 各包的一句话职责（"管什么 / 不管什么"）

| 包 | 管 | 不管 |
|---|---|---|
| `core` | 对话运行时（Agent / Message / Tool / 插件 / 事件） | 权限、文件系统、配置、持久化（`src/` 无 `node:*`） |
| `sdk` | 业务能力（能力管线、权限、MCP、交接迁移、内置工具、ConfigManager） | 进程与连接、会话存档、工作区、任何"客户端长什么样" |
| `protocol` | 线上契约：方法名表、事件名表、载荷形状、错误码表、帧编解码、发现文件形状、`callOnce` | 任何业务判断、任何状态机、任何 UI 概念 |
| `server` | 会话编排、存档、工作区、配置与定义的服务端读写、资产、事件出口、`Daemon` | UI 栈、进程级全局（除组装根）、**任何"客户端怎么想"** |
| `client` | 传输（连/重连/订阅）、门面（**100% 覆盖**协议方法）、**会话流状态机**（前端必须一致的那部分"想"） | 渲染、本地化、进程级全局、任何服务端数据的本地读写 |

---

## 2. 十二条设计决定

### D1 — 新增包 `@ai-zen/agents-protocol`，把 `protocol/` 从 server 搬出去

**为什么**：契约是**双方的东西**，住在其中一方家里，就必然让另一方依赖它。搬出来之后
`client → server` 这个箭头根本不存在，也就不需要靠"只走子路径""产物依赖图必须闭合"这类
纪律去维持一个本可以靠结构保证的性质。

**怎么做**：
- 新包 `packages/protocol`，`src/` 从 `packages/server/src/protocol/` 整目录搬来；
- `packages/server/package.json` 的 `exports` **只留 `.`**，删掉 `./protocol`；
- `packages/server/src/protocol/` 与 `protocol/index.ts` 一并删除；
- `server` 的 `dependencies` 加 `@ai-zen/agents-protocol`；
- `client` 的 `dependencies` **只剩** `@ai-zen/agents-protocol`（`agents-server`/`sdk`/`core` 全删）。

**验收**：
```bash
node -e 'console.log(Object.keys(require("./packages/client/package.json").dependencies))'
# 必须只有 ["@ai-zen/agents-protocol"]
```

**已知例外（不隐瞒）**：`ensure-server.ts` 要 spawn 一个 `agents-server serve`，就得知道那个 bin 在哪，
只能 `require.resolve("@ai-zen/agents-server/package.json")`。所以：
- `@ai-zen/agents-server` 声明为 **可选 peerDependency**（`peerDependenciesMeta.optional`），**不是** `dependencies`；
- 消费点**只有 `ensure-server.ts` 一个文件**，文件头写清「这是部署策略，不是分层」；
- 因此 `grep 'agents-server' packages/client/src` **永远不可能是空的** —— 那条断言改成
  `grep -rn 'agents-server' packages/client/src --include=*.ts | grep -v '\.test\.' | grep -v 'ensure-server\.ts'` 必须为空。
- 宿主应用（CLI / 桌面端）本来就装了服务端包；没装的应用要用 client，就得自己注入 launcher。

> **为什么不动「客户端依赖 core」那条**：`packages/client` 的 `dependencies` 确实只剩 protocol；但
> **应用**（CLI / 桌面端）依赖 `agents-core` 是正当的 —— CLI 还要 sdk 的业务类型（`AgentDefinition` /
> `ConfigManager`），而 `sdk → core` 是所有路径的必经之路。所以「客户端只依赖 protocol」这句话的
> **作用域是 `packages/client`，不是应用**。别再把它当成应用的约束去执行。

### D2 — `PhaseInfo` / `PhaseKind` / `ToolCallRef` 归 protocol

**为什么**：它们是**线上载荷的形状**（`SessionListEntry.phase`、`SessionSnapshotResult.phase`、
`SessionPhaseEvent.phase`、`ToolCallState` 的邻居），由 `service/progress/PhaseTracker`（一个服务端状态机）
定义，方向是反的。契约的形状不能由某一侧的内部状态机拥有。

**怎么做**：三者搬进 `protocol/phase.ts`；`PhaseTracker` 反过来 import protocol。
`protocol` 从此**零跨包反向 import** —— 且 `packages/protocol/src` 里**不允许**出现任何指向
`service/`、`daemon/`、`domain/` 的 import。

> 落地状态：P1 时它还在 `server/src/service/progress/PhaseTracker.ts`；P2 的目录重排之后已经是
> `server/src/lib/phase.ts`（`PhaseTracker` 这个类名不变，类里只留实现，形状仍在 protocol）。

### D3 — `ERROR_CODES` 与 `codedError` 归 protocol

**为什么**：错误码是**线上契约**（客户端据 code 分支：`session-missing` / `unknown-session` / `turn-busy` …），
却散成 19 个裸字符串、`codedError` 六份拷贝。而 notice code 早就有表 —— 同一个问题，一半有答案一半没有。

**怎么做**：`protocol/errors.ts` 导出
```ts
export const ERROR_CODES = { noStore: "no-store", unknownWorkspace: "unknown-workspace", ... } as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export function codedError(code: ErrorCode, message: string): CodedError;
export function isCodedError(value: unknown): value is CodedError;
export function codeOf(value: unknown): ErrorCode | undefined;
```
服务端六处删除本地拷贝，全改 import；客户端与桌面端不再写 `"session-missing"` 字面量。

### D4 — 事件命名统一 `namespace.action`，表按作用域拆开

**为什么**：`SESSION_EVENTS` 文件头说"命名空间写的是作用域"，可 `message.delta` / `turn.end` 无命名空间
（它们都带 `sessionId` + `turnId`），而 `global.notice` 压根不是会话事件。

**怎么做**：
- 改名：`message.delta → session.delta`、`turn.end → session.turnEnd`、`global.notice → server.notice`；
- 拆表：`SESSION_EVENTS`（11 条，全部 `session.*`）+ `SERVER_EVENTS`（1 条 `server.notice`）；
- `ServerEvent = SessionEvent | ServerNoticeEvent`（与 `SESSION_METHODS` / `DAEMON_METHODS` 的拆法对称）。
- **连带改名**（否则会出现「表叫 `SERVER_EVENTS`、码叫 `GLOBAL_NOTICE_CODES`」的错位）：
  `GLOBAL_NOTICE_CODES` → `SERVER_NOTICE_CODES`、`GlobalNoticeCode` → `ServerNoticeCode`、
  `GlobalNoticeEvent` → `ServerNoticeEvent`。

> 实现状态：P1 只改了事件值与拆表，**码表改名留给 P2**（`GLOBAL_NOTICE_CODES` 目前仍在，名字是历史叫法）。

### D5 — 删掉那条「保活声明」方法：会话寿命只留一条规则

> **实现状态：P2 已落地。** 协议里那条保活方法、`SessionManager` 的保活字段与方法、客户端的
> 门面方法与 handler 接线全部删除；`grep -rn keepAlive packages/{server,protocol,client}/src`
> 为空。本文从此不再写出那个方法名 —— 文档里一个已经被删掉的方法名，是下一个人「以为它还在」
> 的唯一来源。

**为什么**：现在"我不再看这段会话了"有三种表达，其中 `session.close` **零调用方**（只有测试在调），
那条保活声明则把"服务端要不要占内存"这件**服务端内政**写进了客户端契约，还要求客户端在崩溃前
记得发一帧（发不出就永久泄漏）。

**怎么做**：
- 会话寿命规则变成：**连接上有持有者 → 活着；持有者没了 → 宽限期后回收；`session.close` → 立刻回收。**
  服务端自己维护"最近用过"的活会话表（复用现有 `DEFAULT_SESSION_IDLE_TIMEOUT_MS` 作为宽限期）。
- 协议删那条方法；`SessionManager` 删保活字段、保活方法与 `scheduleReclaim` 里的保活判据。
- 客户端删 `RemoteSessions` 上的保活方法与 `releaseKeepAlive`、`dispose()` 里的那条"不等回执"的分支。

**判据为什么从合取降成一个**：两个事实里只有一个在「最难的情况」下还成立（崩溃的进程发不出帧，
而 socket 消失是内核保证的），那就不该要两个 —— 取合取只是把不可靠的那个当成了必要条件。
这条理由写在 `SessionManager` 文件头（那也是这一决定唯一的「为什么」现场）。

**`session.close` 不是死的，它要重新获得调用方。** 今天 `stdio-runner` 的一次性调用结束时靠那帧
「我不要了」让服务端**当场回收**（它的注释写明了「所以不需要 `session.close`」）。删掉它之后，
`ai "…"` 每跑一次就往常驻服务端留一段活会话直到宽限期 —— 对 shell 里高频调用是真泄漏。
所以 **D5 的配套动作是：`stdio`（原 `stdio-runner.ts`）的 `finally` 里 `await session.close()`。**

**两处行为变化，必须记账（不许说成「行为不变」）**：
1. `ai "…"` 结束时由「立刻回收」变成「宽限期后回收」——除非按上面接上 `session.close`；
2. TUI 的 `reset()`（`/new`）原本 `await releaseKeepAlive(...)`，删掉后**连按 `/new` 十次会同时养着
   十段活会话直到宽限期**。内存峰值变高，可接受，但不是「机制少一个、行为不变」。

**保留的等价性**：TUI「切走一段会话，它留在内存里」由服务端宽限期继续提供，且不再依赖客户端「记得说」。

### D6 — 门面必须 100% 覆盖，且由类型保证

**为什么**：`RemoteSessions` 只覆盖 16/22 个会话方法、2/6 个工作区方法，会话级模型动作还挂在
"配置面"上。后果是桌面端**放弃门面、裸调协议**（它的注释自己写了理由），于是"同一件事只有一个
定义"破了 —— 方法名、参数拼装在两个地方各写一遍。

**怎么做**：
- `RemoteSessions` 覆盖 `SESSION_METHODS`(22) + `WORKSPACE_METHODS`(6)；
- `RemoteConfig` 覆盖 `CONFIG_METHODS`(7) + `AGENT_METHODS`(5) + `ASSET_METHODS`(1)；
- 会话级模型动作（`modelSet` / `modelParamsSet`）从 `RemoteConfig` **挪回** `RemoteSessions`；
- 加一个类型级用例：门面对象的 key 集合必须**等于**方法表 key 集合 —— 少一条编译不过，多一条也编译不过。

### D7 — 客户端新增「会话流状态机」`SessionStream`（纯）与 `SessionChannel`（脏）

**为什么**：审计的核心结论是 —— **"一轮之内前端必须持有的状态"不是展示**，它决定
"屏幕上的答案会不会凭空短一截""子任务失败会不会被显示成成功""这一轮到底结束没有"。
三个前端都会错、且会错得一样。现在这套逻辑写了两遍（CLI 1276 行 / 桌面 773 行），
能复用的只有 126 行的 `stream-merge`。

**怎么做**：`agents-client/src/session/`
- `stream.ts` → `SessionStream`：**零 I/O、零 UI 框架**的纯状态机
  ```ts
  class SessionStream {
    readonly state: SessionStreamState;      // messages / phase / subAgents / turnId / model / usage / status
    beginTurn(turnId): void;
    applyDelta(d): void;                      // 正文增量累积
    applyToolCalls(calls): void;              // 组装态整份替换
    applyMessageAppended(msg): void;
    subAgentStarted / subAgentDelta / subAgentEnded / clearSubAgents
    settle(snapshot): void;                   // 收尾：mergeStreamedSnapshot 整份对账
    applyIdChanged(id): void;
    resolveQuestion(event, policy): string | null;   // policy 由应用注入
    readonly changed: () => void;             // 单一变更通知（合帧由调用方决定）
  }
  ```
- `channel.ts` → `SessionChannel`：一条会话的订阅/请求/重连 + 重新 `attach`（**唯一有 I/O 的那一半**）。
- `merge-stream.ts`、`agent-view.ts`、`error-category.ts` 同目录，全部纯函数。

**为什么拆两个**：一纯一脏。纯的那个可以直接单测（现在 TUI 的状态机只能靠 ink 渲染反推），
脏的那个只做接线。同一条理由适用于 `PhaseTracker`（纯）与 `SessionManager`（脏）。

**`SessionChannel` 必须继承的三条不变式**（来自 `remote-chat-session.ts`，丢掉任何一条都是回归）：
1. **在飞的那一轮不能永远挂着**：重连后拿到快照，若 `phase === null` 说明那一轮在断线期间已结束，
   必须走**与 `turn.end` 完全相同**的收尾路径（不是另写一条）；
2. 重连**最多 3 次、递增退避**；
3. **单飞**（正在重连就不再起第二个）。
若这三条不进包，P4 不许删 CLI 自己的那份实现。

**`SessionStream` 不给 `send()`**：它只有 `beginTurn` / `settle` / `changed`。但**应用侧的「等这一轮」
必须留在会话层**（`session.ts` 的 `waitForTurn(turnId)`）：TUI 的 `busy`、输入禁用、`/clear` 的时机全靠它，
而 `turn.end` 有可能先于 `send()` 的回执落地。**别把它删掉让界面自己等。**

**`drafts`（输入框的 ↑ 历史）不进 `SessionStream`**：它是 `messages` 的纯派生，由界面自己算。

### D8 — `ServerConnection` 进 client 包：一个进程一条连接

**为什么**：CLI 靠"在 `tui/index.tsx` 里先建一个 `configPort` 往下传"解决（注释写"不传就变成两条连接"），
桌面靠 `pending ??=` 缓存（且建成后永不复查 `closed` → daemon 重启即永久失能）。同一个问题两套土办法。

**怎么做**：`transport/connection.ts` 导出 `ServerConnection`：
- `client()`：注入优先 → `ensureServer` → 缓存；**查 `closed`，断了就重建并重新 `events.watch`**；
- 订阅者（`SessionChannel`）通过它拿连接，不自己建。

### D9 — `protocol` 提供 `callOnce`，三份重复收敛成一份

**为什么**：`server/src/cli.ts` 的 `status`/`stop`、`client/status.ts`、`ensure-server` 的 ping，
是三份"连上 → 握手 → 发一帧 → 等回执"的实现。

**怎么做**：`protocol/call-once.ts` 导出
`callOnce(address, method, params, { timeoutMs }): Promise<unknown>`。
它是**契约的人体工学**（"怎么说话"的最小可用形态），只用 `frames`/`messages` + `node:net`，
因此 `protocol` 的运行期零第三方依赖不变。

### D10 — server 包重排：目录按"东西的性质"分，`SessionManager` 按"字段归属"拆

**为什么**：`service/` 下九个子目录平铺了三种不同性质的东西（领域服务 / 端口+适配 / 机理件），
而 `SessionManager` 2671 行里装 12 个并列职责。注意：**它的复杂度是挣来的**（每块都有真实规则与
注释记着踩过的坑），错的是聚合，不是内涵。

**目录目标**：
```
packages/server/src/
  domain/      业务对象，每个子目录一个
    session/     SessionManager + EventBridge + Persistence + QuestionBroker
                 （+ LiveSession 形状、AutoTitle、store/ 存档端口与实现）
    workspace/  agent/  config/  asset/  handoff/
  lib/         无业务语义的通用零件
    phase.ts     PhaseTracker（状态机；形状在 protocol）
    events.ts    EventHub（连接扇出）
  daemon/      传输与接线：Daemon / wire / params / *Handlers
  cli.ts       组装根（唯一读 env/argv 的地方）
  index.ts     包对外桶（改成 export *）
```

**落地记录（P2）**：拆完是四个类 + 一份形状文件，全部靠构造参数拿协作者（互不 import）：

| 文件 | 行数（拆前 `SessionManager.ts` 2694） | 职责 |
|---|---|---|
| `LiveSession.ts` | 281 | 那段会话的形状，以及 `AgentLike` / `SubAgentLike` / `AskQuestionSpec`；四边都只依赖它 |
| `EventBridge.ts` | 504 | SDK 事件 → 协议事件（含 `ToolCallReporter` 与流式影子） |
| `Persistence.ts` | 213 | 存档形状（`recordOf`）与全部写盘路径 |
| `QuestionBroker.ts` | 186 | 提问 / 认领 / 超时 / 放行 |
| `SessionManager.ts` | 1815（含 `closeWorkspace` 与全部选项注释） | 注册表、holder 与回收、turn 生命周期、目录、交接、create/attach/close/dispose |

用例也按归属**搬**（不复制）成四个文件：`SessionManager.test.ts` 108 例 / `EventBridge.test.ts`
22 例 / `Persistence.test.ts` 24 例 / `QuestionBroker.test.ts` 6 例，合计 160 例 —— 与拆之前
逐条对齐。共用脚手架（假 Agent、假存档、假时钟、按真件形状 fire 事件的几个函数）提成了
`SessionTestSupport.ts`：它们是**同一份知识**，抄成四份的那天，改一处假件形状就可能漏掉三处。
该文件只被 `*.test.ts` import，所以 `tsconfig.json` 的 `exclude` 里也加了 `**/*TestSupport.ts`
（否则 `dist` 里会带上一份测试代码）。

两处**没有硬拆**（报告里也记了）：
- `adopt` / `saveAs` 的「换 id」被拆成两半：写新档 / 挪指针 / 删旧档在 `Persistence`，
  注册表换键 + 清子 Agent + 发 `session.idChanged` 在 `SessionManager.rekey`。硬把注册表塞进
  `Persistence` 会让它拥有会话表，那正是「拆了但还在一个团里」。
- `list` / `last` / `rename` / `remove` / `rollback` / `create` / `attach` 仍只**借** `Persistence`
  的 `store()` / `recordOf()`：它们是「注册表视角下的目录操作」，不是存档规则。

**`SessionManager` 怎么拆** —— 判据是 **"谁拥有 `LiveSession` 的哪些字段"**，不是按行数：
| 拆出 | 拿走的字段 | 为什么是它 |
|---|---|---|
| `EventBridge` | `toolCalls`(ToolCallReporter) / `pushedMessages` / 流式影子 | 只依赖 `agent.events` + `hub`，**不需要 sessions 表、不需要 store** —— 最干净的一块 |
| `Persistence` | `store` / `record` / `persistOnSettle` / `autoPersist` | `recordOf` 是"存档形状唯一定义处"，埋在 2671 行里没人找得到 |
| `QuestionBroker` | `questions` / `questionSeq` | 唯一需要 `hub.watcherCount()` 的组件，自带超时 |
| 留下的 `SessionManager` | 注册表 / holders / 回收 / turn 生命周期 / 目录（list·last）/ 交接 | 这些是"我正在管的那批会话"，本来就是一件事 |

### D11 — CLI 重排：会话层与命令层移出 `tui/`，删死代码

**为什么**：
- `stdio-runner.ts`（非 TUI 的管道模式）**反过来 import `./tui/remote-chat-session.js`** —— `tui/` 不是叶子。
  而这条依赖的性质是"`ai "…"` 会不会 OOM"取决于那个文件的 import 图里今天恰好没有 React，
  **只由一句注释保证**。
- `session-commands/registry.ts`（命令元数据）与 `tui/screens/chat-commands.ts`（命令执行体）都不是 TUI。
- 死代码：`format-time.ts`（零引用）、`types.ts`（零引用）、`reasoning-effort.ts` 的本地写入兜底、
  `agents-store.ts` 的 `createAgentStore()`（自述"只给测试用"却在生产 `src/` 里）。

**目标**：
```
cli/src/
  index.ts        分发器
  mode.ts         调用形态判定（纯）
  stdio.ts        管道模式（瘦客户端）
  session.ts      会话层（连接 + 命令族 + 把 SessionStream 的状态交给界面）★从 tui/ 搬出
  commands/       斜杠命令：registry.ts（元数据）+ handlers.ts（执行体）★从 tui/screens/ 搬出
  session-rate.ts        token 速率（纯）★从 tui/ 搬出
  session-notice.ts      notice code → 文案 ★从 tui/ 搬出
  session-phase.ts       PhaseInfo → 文案 ★从 tui/ 搬出
  text.ts          纯文本度量（stripCwdNote / displayWidth / truncate）★从 tui/text.ts + tui/screens/render.tsx 提出
  i18n/
  config-editor.ts  配置纯函数层
  tui/            只管渲染与输入（ink）
```

**必须一起离开 `tui/` 的还有 4 个纯模块**（原文档漏了，照原样搬会让门禁第一天就红）：
| 模块 | 为什么必须走 |
|---|---|
| `tui/token-rate.ts`（206 行，纯） | `session.ts` 的 `rateSample` 运行期依赖它 |
| `tui/notice-text.ts`（76 行，纯） | `session.ts` 处理 `session.notice` 要用 |
| `tui/phase-label.ts`（38 行，纯） | 「阶段事实→文案」的唯一出口，与 notice 同性质 |
| `tui/text.ts` 的 `stripCwdNote` / `displayWidth`，`tui/screens/render.tsx` 的 `truncate` | 会话层与命令层都要用；**`truncate` 尤其必须先搬** —— 它现在在 `render.tsx` 里，而那个文件第一行就 `import { Text } from "ink"`，于是 `chat-commands.ts` 为了一个 6 行纯函数把 ink 拖进了命令层 |

**门禁必须是「产物 import 图」检查，不能是路径 grep**。理由：`commands/` 只要还 `import { truncate } from "./render.js"`，改个路径 grep 就绿了，ink 却仍在图里。所以：
```bash
# 从 dist/commands/index.js 与 dist/session.js 出发遍历 import，断言无 ink / react
node scripts/check-imports.mjs dist/commands/index.js dist/session.js dist/stdio.js \
     --forbid ink --forbid react --forbid react/jsx-runtime --forbid ./tui/
```
（`scripts/check-imports.mjs` 需要新写；它同时也是本条门禁自己的护栏。）

**`tui/` 不是叶子这条病的实际面积**：运行期越界只有 `stdio-runner.ts:51` 一处，测试越界只有
`session-commands/registry.test.ts:15`（`displayWidth`）一处 —— 后者随 `text.ts` 上提自然消失。

### D12 — 消灭协议里的 `unknown`

**为什么**：`messages: unknown[]` / `modelParams: unknown` / `message: unknown` 让"客户端只认协议"
这句话在数据模型这一层不成立 —— 每个客户端都必须 `import type … from "@ai-zen/agents-core"` 才能读消息。

**怎么做**：`protocol` 从 `agents-core` **类型级**转出 `Message` / `Role` / `Usage` 等，
协议载荷里所有 `unknown` 换成具名类型。`protocol` 的 `package.json` 依赖 `agents-core`
（`import type` 在产物里擦除，运行期仍零第三方依赖）。
**客户端从此只依赖 protocol**，不再直接依赖 core。

> 判断依据：消息形状**是** core 的数据模型，而且它是落盘格式（存档 JSON）。给它再造一份
> "线上镜像"就是第二份定义 —— 正是本项目最忌讳的事。诚实的做法是承认它、并在一个地方（protocol）
> 声明它，而不是让每个客户端各自去 core 里捞。

**这条的作用域必须说清楚（原文档写错了）**：约束的是 **`packages/client` 这一个包**，不是应用。
实测 `AgentNS.Role` / `AgentNS.MessageStatus` 是 **TypeScript `enum`（运行期值，不是纯类型）**，
所以**任何要渲染消息状态的代码都必须在运行期拿到它们**。CLI 有 8 个文件在用（`chat-commands` /
`messages-view` / `chat-history` / `stdio` / `config-editor` …）。而 CLI 本来就依赖 `agents-sdk`
（`AgentDefinition` / `ConfigManager`），`sdk → core` 是必经之路 —— **应用依赖 core 不是问题，也不是本轮要解决的问题**。

> 记账（本轮**不做**）：把 `Role` / `MessageStatus` 从 enum 改成 `as const` 字符串联合，或把数据词汇
> （`Message` / `Role` / `Status` / `Usage`）落到一个最底层的 `@ai-zen/agents-model` 包，是更彻底的做法。
> 但它会动 core 的公开面（1300+ 用例全压在它上面），收益只是让「应用也能只依赖 protocol」。
> **本轮不做，理由是不划算，不是没想到。**

---

## 3. 迁移阶段

> 约束：**同一仓不并行**（共享工作树 + `dist`）；跨仓可并行。每阶段必须 `agents` 仓门禁全绿才进下一阶段。

| 阶段 | 仓 | 内容 | 门禁 |
|---|---|---|---|
| **P1** | agents | D1+D2+D3+D4+D9+D12：新建 `agents-protocol` 包，搬 `protocol/`，`PhaseInfo`/`ERROR_CODES`/事件改名/`callOnce`/具名类型；`server` 与 `client` 全部改指新包；`client` 依赖收敛到只剩 protocol | `pnpm build-server && pnpm build-client && pnpm test`；D1 的两条 grep |
| **P2** | agents | D5+D10：删 `keepAlive`、会话寿命收敛；目录 `service→domain`+`lib`；`SessionManager` 拆四件；删 `legacyMigration`；`index.ts` 改 `export *` | 同上 + `store.list()` 路径性能不回退 |
| **P3** | agents | D6+D7+D8：门面 100% 覆盖 + 类型级完整性用例；`SessionStream`/`SessionChannel`/`ServerConnection`；删 `config-port` 里越界的会话动作 | 新增纯状态机用例（不依赖 daemon）；门面完整性用例 |
| **P4** | cli | D11：会话层与命令层移出 `tui/`、改用 `SessionStream`、删死代码与本地写入兜底、门禁 | `npm run test:all`（789 例）+ `tsc --noEmit` + 两条 grep |
| **P5** | desktop | **机械跟随**（只改 `packages/main/src/server/`，不动 render）：事件改名、删 `keepAlive`、改用 `ServerConnection`/`SessionStream` | `pnpm build` + main 用例 |
| **P6** | agents+cli | 文档收口：`architecture.md` 并入本文、依赖图与 45/12 口径更新、README 门禁命令更新；本文删除 | 文档与代码一致（口径实测） |

**P5 之前不动 desktop**：它的 render 层本轮不碰；协议改名只在 `main/src/server/` 一处机械替换。

---

## 4. 总验收判据（可执行）

```bash
# 1. client 不依赖 server（D1；ensure-server 是唯一例外，见 D1）
test -z "$(grep -rn 'agents-server' packages/client/src --include=*.ts | grep -v '\.test\.' | grep -v 'ensure-server\.ts')"
node -e 'const d=require("./packages/client/package.json").dependencies; if(Object.keys(d).join()!=="@ai-zen/agents-protocol") throw new Error(Object.keys(d).join())'

# 2. protocol 运行期零第三方依赖（D1）：滤掉相对路径后必须为空
#    （原写法会把协议包内部的相对 import 也列出来，永远不为空）
grep -rn 'from "[^.]' packages/protocol/src --include=*.ts | grep -v 'node:' | grep -v '\.test\.'
#    + 产物侧再验一次（真正的裁决）：
(cd packages/protocol && grep -hoE 'from "[^"]+"' dist/*.js | sed 's/from "//;s/"//' | sort -u)
#    期望只有 ./xxx.js 与 node:*

# 3. protocol 不反向依赖任何包（D2）
test -z "$(grep -rn 'service/\|daemon/\|domain/' packages/protocol/src)"

# 4. 六份 codedError 已消失（D3）
test "$(grep -rn 'function codedError' packages/server/src | wc -l)" -eq 0

# 5. 事件全部带命名空间（D4）
node -e '…遍历两张事件表，断言每个 value 都以 "session." 或 "server." 开头…'

# 6. 全仓没有 unknown 载荷（D12）
test -z "$(grep -rn 'messages: unknown\|modelParams: unknown\|message: unknown' packages/protocol/src)"
```

**分阶段验收**（原文档把不同阶段的判据混在一张单子里，跑起来必然假红）：

| 判据 | 阶段 |
|---|---|
| 1、2、3、4、5、6 | **P1 已完成**（实测见提交 `e9e15c5`） |
| `keepAlive` 消失（`grep -rn keepAlive packages/{server,protocol}/src`）+ 方法数 45→44 | **P2 已完成** |
| CLI 侧 `core` 依赖只剩 `version.ts` 的字符串解析 | **P4** |
| 门面 key == 方法表 key（类型级用例） | **P3** |
| 产物 import 图：`session`/`commands`/`stdio` 无 ink/react/`./tui/` | **P4** |

外加三条**结构保证**（不是 grep，是编译期）：
- 门面 key 集合 == 方法表 key 集合（D6 的类型级用例）；
- `SessionStream` 的全部用例不 import 任何 daemon / socket（纯）；
- CLI 的 `session/`、`commands/` 不 import `tui/`（D11，可用 tsconfig `paths` + 一条 import 检查用例）。

---

## 5. 本次重构**推翻**的旧决定

记录它们，是因为"为什么不那样做"比"为什么这样做"更容易被后人重新踩。

1. **推翻「协议留在服务端包、只开子路径」**。旧理由：搬包会让"改协议要先 build 一个新包"变慢。
   代价被高估了 —— 新包在 workspace 里，`pnpm build` 一条命令；而收益是**依赖箭头从此不必靠纪律维持**。
2. **推翻「`CLIENT_INFO` 留在应用侧、包里只放形状」** —— 这条**保留**，不受影响（它答"我是谁"，只有应用能答）。
3. **推翻「一帧 `keepAlive.set` 表达客户端意图」**。理由见 D5：它把服务端内政写进了契约。
4. **推翻「协议刻意不认识消息形状」**。它的初衷（避免镜像类型漂移）是对的，但代价（每个客户端都得
   认识 core）没被记账。D12 用"从 core 类型级转出"同时满足两个目标。
5. **推翻「会话级模型动作挂在配置面」**。理由见 D6。
6. **P1 落地后推翻/修正的措辞**（反思的第二轮，来自 CLI 侧实测调研）：
   - 「客户端只依赖 protocol」→ **作用域是 `packages/client`，不是应用**；`AgentNS.Role`/`MessageStatus`
     是 enum（运行期值），应用依赖 core 是正当的；
   - 「`createAgentStore()` 只给测试用」→ **错**。`tui/config-wizard/engine.ts:77` 的 `props.agentStore ?? createAgentStore([], [])`
     让它在**首启凭据屏**（`tui/index.tsx:125` 的 `CredentialGate` 没传 `agentStore`）上是**可达的生产路径**,
     会往客户端本机写 `~/.ai-zen/agents/*.json`。修法是先注入、再删；
   - 「`setAgentEffort` 的缺省写入是分离靠纪律的例子」→ **CLI 这侧纪律其实守住了**（唯一生产调用点
     已注入、注释还解释了原因）。删缺省值零风险，但它是「防未来」而不是「修现在」；
   - 「`session.close` 零调用方」→ 删掉 keepAlive 之后 **stdio 必须接上它**（见 D5）；
   - 「`commands/` 搬顶层会造成循环依赖」→ **不会**。`chat.tsx → chat-commands.ts` 是单向的，
     `chat.tsx` 只用 `runCommand` 一个导出；真正的阻塞是 `truncate` 把 ink 拖进了命令层（见 D11）。
7. **保留**（看起来可疑、其实是刻意的，**别动**）：
   - `Wire` 接口只有一种生产实现 —— 它的第二种实现在 `wire.test.ts`（内存双工），是"不是 `net.Socket`
     也能驱动 `Daemon`"的证明；
   - `EventHub` 48 行别合并 —— `watcherCount()` 承担一条真实业务判定（没人在看就别向客户端提问）；
   - 子 Agent 的事件监听永不解绑 —— core 每次委派都 `new Agent(...)`，实例随本轮回收；
   - `toolCalls` 发全量而非增片、`messageAppended` 只推已定型的 `role:"tool"` —— 语义不同就不合进一条事件；
   - `attach` 与 `create` 分开、`attach` 不要求工作区路径存在 —— 历史与目录在不在无关。
