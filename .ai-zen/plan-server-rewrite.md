# 服务端重写 — 实施计划（PM 版）

> 上游：`packages/server/docs/PRD.md`（要什么）+ `packages/server/docs/architecture.md`（怎么搭，A1–A12）。
> 本文只写：拆成哪几块、每块的边界与验收。冲突以 PRD 为准，架构以 architecture.md 为准。
> 实施分支：`feat/server-rewrite`（`main` 不动）。

## 0. 铁律（每个实施者都要遵守）

1. **只在分配给你的目录里写文件**，不碰别人的目录、不碰 `packages/{core,sdk,client,testing}`、不碰 `bad-src/`。
2. **不新增运行时依赖**。允许的既有依赖：`ws`、`@ai-zen/agents-core`、`@ai-zen/agents-sdk`、Node 内置（`node:sqlite`、`node:worker_threads`、`node:crypto`、`node:fs`…）。要加依赖先报 PM。
3. **不在代码注释里立规矩**（`AGENTS.md` 那条）：注释只解释这段代码在做什么、为什么，不写「永不 / 一律 / 只能 / 不支持」这类规定性断言。
4. **产品行为不许自己拍**。拿不准的写进 `docs/plan-questions.md`（新建，按追加行写：`- [你的文件] 问题一句话`），不要自己发明行为。
5. **每块自带测试**，`pnpm --filter @ai-zen/agents-server build` 与 `npx vitest run <你的目录>` 必须全绿才算交付。
6. **不许改 `bad-src/`、不许改 `tsconfig*.json`、`package.json` 的 `scripts`/`deps`**（除了 PM 明确指派的那次）。
7. 中文注释与中文测试描述；代码标识符英文。类型从严，不用 `any`（`unknown` + 收窄）。

## 1. 目录与模块契约

```
packages/server/src/
  index.ts          包出口（wire 类型 + createServer）
  app.ts            ServerApp 单根
  cli.ts            命令行：serve / token / version
  config.ts         路径与端口来源
  wire/             契约（方法表 + 帧 + 错误码 + 事件 + 状态形状）
  i18n/             文案（en 基准 / zh）
  storage/          Database(worker) + migrations + Repository
  runtime/          ScopeRegistry / RunRegistry / ConversationStateRegistry / ChatRunner / TransientRunner
  services/         薄服务
  handlers/         方法实现（一域一文件）+ 能力清单 + HandlerTable
  net/              WsHub / 鉴权 / 上传接收 / 发现文件
```

### `config.ts`（PM 已定形状）

```ts
export interface ServerPaths {
  dataRoot: string;   // AI_ZEN_DIR，缺省 ~/.ai-zen
  dbFile: string;     // <dataRoot>/ai-zen.db
  assetsDir: string;  // <dataRoot>/assets
  runDir: string;     // <dataRoot>/run
  serverFile: string; // <dataRoot>/run/server.json
  tokenFile: string;  // <dataRoot>/run/token
}
export function resolvePaths(aiZenDir?: string): ServerPaths;
export const DEFAULT_PORT: number;                 // 8790
export interface ListenTarget { host: string; port: number }
export function resolveListenTarget(input: { port?: number; configPort?: number; local: boolean }): ListenTarget;
```

`local: true` → `host: "127.0.0.1"`；`local: false` → `host: "0.0.0.0"`。端口优先级：参数 > 配置文件 > 默认（PRD D25）。

> 实现现状：`config.ts` 里没有 `configFile` 字段，`config.json` 由 `app.ts` 按 `<dataRoot>/config.json` 拼好交给 SDK 的 `ConfigManager`（R13 的落点没落在 `ServerPaths` 上，见 §9）。

### `wire/`（契约；只有服务端有，客户端照抄形状）

- `errors.ts`：`export type BizCode = ...`（13 个稳定业务码：`"unauthorized"`、`"invalid_params"`、`"not_found"`、`"busy"`、`"payload_too_large"`、`"unsupported"`、`"internal"`、`"config_invalid"`、`"mcp_unavailable"`、`"model_unsupported"`、`"handoff_declined"`、`"question_pending"`、`"context_guard"`）；`export class ServerError extends Error { code: BizCode; messageKey: MessageKey; params?: Record<string, unknown>; detail?: unknown }`。
- `methods.ts`：`MethodMap`（方法名 → `{ params; result }`）与 `METHOD_NAMES`（63 个），方法名 `<域>.<动作>`。
- `states.ts`：非消息事实的形状（`RunState` / `GenerationState` 六态 / `UsageSnapshot` / `NoticeView` / `QuestionView` / `ConversationState` / `AssetRef` …）。
- `events.ts`：`EventMap`（事件名 → payload）：`run.state`、`message.delta`、`conversation.changed`、`notice`、`question`、`usage`。
- `frames.ts`：JSON-RPC 2.0 帧的类型与守卫（request / response / notification），`parseFrame`、`okResponse`、`errResponse`、`notification`（事件名放 `method`、载荷放 `params`）。
- `index.ts`：全部再导出。

### `i18n/`

`en.ts` 为基准（键的真相），`zh.ts` 必须键完全一致（用类型约束保证）；`render(lang, key, params)`。`MessageKey = keyof typeof en`。
语言值：`"en" | "zh"`；未知语言回落 `"en"`。

### `storage/`

- `Database.ts`：worker 线程访问 `node:sqlite`，方法 `all<T>(sql, params)`, `get<T>`, `run(sql, params)`, `tx(fn)`, `close()`。开启 `PRAGMA journal_mode=WAL`、`PRAGMA foreign_keys=ON`。`tx` 是**声明式批次**（R19 / R31）：回调里的 `all` / `get` / `run` 只登记语句并把凭据返回，回调返回后整批在同一事务里按登记顺序执行，结果按凭据对回调用方；读到的值回不到 JS 里决定下一条写什么。
- `dbWorker.ts`：`parentPort` 侧执行器。
- `migrations.ts`：`migrate(db)`，建表 + `meta.schemaVersion`，表结构见 architecture.md §5（`workspaces`/`conversations`/`messages`/`assets`/`notices`/`questions`/`credentials`/`meta` + FTS5 虚表 `messages_fts`，`tokenize='trigram'`）。**建表语句由 storage 负责人落定并在测试里断言。**
- `*Repository.ts`：只做 SQL，一表一文件；行类型放 `types.ts`。`MessageRepository` 负责 FTS 同步与 `< 3 字符` 时退化 `LIKE`。

### `runtime/`

- `ScopeRegistry.ts`：`acquire(workspaceId): Promise<Scope>`（懒创建、依赖 +1）、`release(workspaceId)`（依赖 −1，归零起 10 分钟计时）、`peek(workspaceId)`、`recycleAll()`、`disposeWorkspace(workspaceId)`（删项目时回收，R43）、`onAllRecycled(cb)`（全部回收后通知根对象判退出；R53 定的名字）。
- `RunRegistry.ts`：`start(conversationId): RunHandle`（已在跑则抛 `ServerError("busy")`）、`finish(conversationId)`、`isRunning(conversationId)`、`abort(conversationId)`。
- `ChatRunner.ts`：一轮的执行者（借 Scope → 装配 agent → 流式 → 增量落库 → 发事件 → 结束时写一次 → 释放 agent + Scope release）。**agent 用完即弃（D28）。**
- `ConversationStateRegistry.ts`：进程内状态（临时模型 / 临时思考档 / `forget`），R51 的落点。
- `TransientRunner.ts`：临时对话的一轮（不落库、不推流式事件、一次返回，R49）。

### `net/`

- `discovery.ts`：`writeServerFile(paths, info)`、`readServerFile(paths)`、`clearServerFile(paths)`；`server.json` 形状 `{ pid, host, port, version, local, startedAt }`。
- `auth.ts`：凭证校验（库里存哈希，`node:crypto`），`createCredential(db, note)` 返回明文一次、`revoke(id)`、`list()`。
- `UploadReceiver.ts`：`asset.begin/chunk/end` 的状态机，分帧写 `assets/` 临时文件，校验总长与摘要。
- `WsHub.ts`：`ws` 服务器、连接集合、首帧 `hello` 鉴权、语言挂连接、方法分发（`MethodMap` → handler）、`push(event)` / `pushTo(conn)`、断开清理。

## 2. 分工与波次

| 波次 | 负责块 | 目录 | 依赖 | 交付 |
|---|---|---|---|---|
| W1-A | 存储 | `src/storage/**` | 无 | `Database`（worker）/ `dbWorker` / 迁移 v1（8 表 + `messages_fts`）/ 各表 Repository |
| W1-B | 契约 + 文案 + 路径配置 | `src/wire/**`、`src/i18n/**`、`src/config.ts` | 无 | `MethodMap` / `EventMap` / 帧与守卫 / 业务码 / `en`+`zh` 文案 / `resolvePaths` / `resolveListenTarget` |
| W1-R | 契约纠偏（R21–R29） | `src/wire/**` | W1-A、W1-B | 消息、内容段、工具调用、消息状态、流式增量、用量换成 core 的导出；删掉自造形状；`message.delta` 不带状态快照 |
| W2-S | 存储补漏（R19 / R31 / R32 / R34 / R35 / R37） | `src/storage/**` | W1-A | `tx` 声明式批次；`workspaces.cwd` 唯一（R14）、`conversations.agentId/modelId` NOT NULL（R18）、`nameIsAuto`（R35）、`parentToolCallId`（R37）落进 v1 建表；不加 `workspaces.updatedAt`（R34） |
| W2-C | 服务层：workspace / conversation / message / search / credential | `src/services/{Workspace,Conversation,Message,Search,Credential}Service.ts` | W1 | 五个薄服务的 CRUD 与搜索（含 `< 3 字符` 退化 `LIKE`） |
| W2-D | 运行时：ScopeRegistry / RunRegistry / ChatRunner | `src/runtime/**` | W1 | Scope 依赖计数与 10 分钟空闲回收、忙即拒、一轮的流式执行（`ChatRunner`） |
| W3-X | 存储换代 core 类型（R30）+ 素材层与会话内存态补齐（R44 / R51） | `src/storage/**`、`src/services/AssetService.ts`、`src/runtime/ConversationStateRegistry.ts` | W2 | storage 行类型改用 `AgentNS.MessageContent`、`MessageService` 透传；`AssetService`（上传落定 + `assetIds` → 内容段）；临时模型 / 临时思考 / `forget` 的持有者 |
| W3-E | 接线：WsHub / auth / 上传 / 发现文件 | `src/net/**` | W1、W2 | `WsHub`（握手、分发、推送与 R47 缓冲）、`auth`、`UploadReceiver`（二进制分帧）、`discovery` |
| W3-F | 单根 `ServerApp` + `cli.ts` + `index.ts` + 端到端冒烟 | `src/app.ts`、`src/cli.ts`、`src/index.ts` | W1–W3 | 单根组装与启停、退出判据、`handlers/index.ts`（`HandlerTable` + `BRIDGED_METHODS`）、命令行三组子命令 |
| W4-G | 配置与发现：ConfigService / AgentService / ModelService / 能力清单 / `@` 补全 | `src/services/{Config,Agent,Model,Completion,Discovery}Service.ts` | W1–W3 | 端点 / 模型 / 默认项 / MCP 读写、助手增删改、`@` 补全、能力清单（63 条） |
| W4-H | 通知 / 问题对象 / 交接 / 撤回 / 自动命名 / 升级 | `src/services/{Notice,Question,Handoff}*.ts`、`AutoNaming.ts`、`src/runtime/TransientRunner.ts` | W1–W3 | 通知持久化与按连接本地化、问题对象、交接文档与开新对话、撤回、首轮后自动命名、临时对话 |
| W4-X | 总装 | `src/handlers/**`、`src/app.ts`、`src/i18n/**`、`src/storage/migrations.ts` | W1–W4 | 全部域接进同一张 handler 表、能力清单与 i18n 键对齐、`notices.conversationId` 成列、退出判据补 `onConnectionsChanged` 触发源、配置生效的 Scope 回收、端到端集成用例 |
| W5 | 集成验收（PM 自己跑）+ 文档对齐 | —、`packages/server/docs/architecture.md`、本文 | 全部 | 验收四条全绿；W5-B 把 `architecture.md` 与本文按实现回改 |

**波次与提交的对应**（`git log --oneline`）：`66fe88d` W1 → `bf2419a` W1-R → `b40edee` W2（W2-S / W2-C / W2-D）→ `3dcb95a` W3（W3-E / W3-X）→ `28b8aeb` W3-F + W4（W4-G / W4-H）→ `d9ce164` W4-X。

**并行规则**：同波次里两个 agent 的目录不重叠才能同时派。跨目录要改别人的文件 → 先报 PM。

## 3. 验收标准（PM 亲自跑，每波都要）

1. `pnpm --filter @ai-zen/agents-server build` 通过（`tsc` 严格模式）。
2. `npx tsc --noEmit -p tsconfig.test.json`（服务端目录内）通过。
3. `npx vitest run` 全绿。
4. 抽样读代码：无 `any`、无模块级可变单例、无「注释立规矩」、无 `process.cwd()`。
5. 最终端到端：真起一个服务端进程 → 真 WS 连上 → 建 workspace / 建对话 → 发一轮（用假模型）→ 拉消息 → 杀进程 → 重启 → 拉回同一条消息。

## 4. 里程碑

- **M1**：存储 + 契约 + 文案 + 路径（W1）→ 可 `Database` 读写、FTS 中文可搜。
- **M2**：CRUD + 运行时（W2）→ 不接网也能跑一轮（用假 agent）。
- **M3**：接线 + 单根（W3）→ 真 WS 可连、可建对话、可发消息。
- **M4**：配置 / 发现 / 通知 / 问题 / 交接 / 撤回 / 命名 / 升级（W4）。
- **M5**：集成验收 + 文档对齐（`architecture.md` 与实际不符处回改）。

## 5. PM 裁定（W1 结束后）

W1 交付者提的问题，按下列裁定执行；**实施者不要重开这些**。

| # | 问题 | 裁定 |
|---|---|---|
| R1 | 临时对话的流式事件如何标识（D3 无 id，事件载荷 `conversationId` 必填） | 临时对话**不推流式事件**：`conversation.transient` 一次调用同步返回结果（PRD F-A2「一次请求跑一轮、结果返回后内存清空」）。事件里的 `conversationId` 保持必填，不为临时对话破例 |
| R2 | 「取名模型」在 SDK `AppConfig` 里没有字段 | **加 `AppConfig.namingModel?: string` 到 SDK**（由 PM 统一改，实施者不许动 `packages/sdk`）。未配时回落 `defaultModel`；都拿不到就保持原名（D2） |
| R3 | F-B1「配置层不另存默认模型」与 SDK `defaultModel` | 契约保留 `defaultModel`：它是 SDK 三级解析的**兜底层**，不是真相源；注释写清「真相在 Agent 定义上」 |
| R4 | 通知三档语气是哪三档 | `info \| warning \| error`。「已保存」这类一秒提示归 `info` + 短 duration，不新增 success 档 |
| R5 | 默认助手的「默认」是全局还是每 Workspace | **全局一份**（SDK `AppConfig.defaultAgent`）。Workspace 是项目，不承载助手默认 |
| R6 | 能力清单要独立方法还是塞进 hello | 两者都要：`server.capabilities` 给完整清单（帮助页渲染用它）；`server.hello` 只回能力 id 列表 |
| R7 | 二次确认做成 `dryRun` 两步 | 接受 `dryRun`：先取代价（服务端算），客户端展示后真调 |
| R8 | `conversation.get` 与 `conversation.state` 是否合并 | 不合并：前者是元信息，后者是现场快照（L5 重连先拉状态） |
| R9 | 子 Agent 消息回看是否独立方法 | 不加新方法，走 `message.list` 的 `toolCallId` |
| R10 | 撤回是硬删，要不要「曾有消息」的痕迹 | 不要（D24）。契约不返回任何删除占位 |
| R11 | 批量请求拒的码 | `unsupported`（我们明确不支持，不是参数错） |
| R12 | 非法端口是静默回落还是报错 | **报 `config_invalid`**。静默回落会造成「我配了 9000 却在 8790 上」 |
| R13 | `agents/ skills/ tools/ sub-agents/ mcp.json` 路径归谁 | 归 SDK：`ConfigManager.basePath` 已经推导并创建了它们。`ServerPaths` 只加 `configFile`（`<dataRoot>/config.json`） |
| R14 | `workspaces.cwd` 是否唯一 | **唯一**。同一 cwd 登记两次会出现两个 Scope 抢同一目录 |
| R15 | 通知 duration 单位 | 契约用**秒**（用户语义），库里存毫秒；换算只在 wire 层 |
| R16 | `assets.messageId` 用 `SET NULL` | 接受（上传早于消息落库；删消息后保留素材行以便按引用清文件） |
| R17 | `questions.conversationId` 可空 | 可空（D10 的「要不要登记为项目」由 cwd 触发，没有对话可挂） |
| R18 | `conversations.agentId/modelId` 可空 | **都改成 NOT NULL**：L7 说身份创建时定死；解析不出助手/模型就在创建时报错，不写半成品行 |
| R19 | `tx` 内不能读中间结果 | **放开**：`tx` 的回调里要能 `all/get/run`（同一 worker 消息内串行执行） |
| R20 | Workspace 列表顺序 | 按 `createdAt DESC`（D13 只定对话侧栏） |

## 6. 追加铁律（用户当场纠偏，2026-11-12）

**R21：聊天消息内容不许发明新数据类型，一律原样用 `@ai-zen/agents-core` 的导出。**

- 消息本体 = `AgentNS.Message`（含 `id` / `role` / `content` / `tool_calls` / `reasoning_content` / `tool_call_id` / `status` / `finish_reason` / `usage` / `subAgentUsage` / `omit` / `hidden` …）
- 消息内容段 = `AgentNS.MessageContent` / `AgentNS.MessageContentSection`（`text` / `image_url` / `file`）
- 工具调用 = `AgentNS.ToolCall` / `AgentNS.FunctionCall`
- 状态与角色 = `AgentNS.MessageStatus` / `AgentNS.Role` / `AgentNS.FinishReason`（**不要**自己再造一套 `streaming/done/aborted/error`）
- 流式增量 = `AgentNS.Delta`（`applyChunk` 吃它）
- 用量 = core 的 `Usage` / `sumUsage()`

wire 层**只能包一层薄外壳**（哪个对话、哪个工作站、六态运行状态、通知、问题、能力清单这些「非消息事实」可以自定义），**不得重新定义消息、消息段、工具调用、消息状态、用量的形状**。凡是 core 已经有的，字段名与取值照抄。

## 7. PM 裁定（W1-R 纠偏后）

| # | 问题 | 裁定 |
|---|---|---|
| R22 | `message.list` 里的消息时间戳（core `Message` 没有时间字段） | **不加外壳**：消息原样 `AgentNS.Message[]`。顺序由服务端给，客户端不显示每条时间（PRD 没有这条需求）。真要加时再加外壳，现在不留预备字段 |
| R23 | 素材 id（core 内容段没有 assetId） | 认 `MessageInput.assetIds?: string[]`：它是「已上传待转段」的定位，进消息前由服务端按实发模型转成 `image_url` / `file` 段（F-H7） |
| R24 | 工具失败的文案键（原挂在自造的段上） | 不要单独承载字段：失败事实就在那条 `role: tool` 消息的 `content` + `status`（`AgentNS.MessageStatus.Error`）上。文案键已删，保持删掉 |
| R25 | `message.delta` 是否带消息状态快照 | 不带。状态只有 `run.state` 一处给（L8 的六态），增量事件只搬 `AgentNS.Delta` |
| R26 | `ContextState` 用 `usage: AgentNS.Usage` | 接受，界面取 `usage.prompt_tokens` 与两条阈值比较 |
| R27 | `conversation.transient` 不再单独给 `text` | 接受（内容从 `message.content` 取），不留重复字段 |
| R28 | `SubAgentStatus` 仍是自造四态 | 保留：core 只有消息状态，没有「子 Agent 这个对象」。但取值命名不得与 `AgentNS.MessageStatus` 混用同名同义 |
| R29 | plan 文档把 core 字段写成 `omitted` | 已改正为 `omit`（core 事实以 `packages/core/src/AgentNS.ts` 为准） |

## 8. PM 裁定（W2 之后）

| # | 问题 | 裁定 |
|---|---|---|
| R30 | storage 自造 `MessageContentSection` 与 core 冲突（TS2677），服务层逐段重建绕过 | **storage 的行类型换成 core 的 `AgentNS.MessageContent` / `MessageContentSection`**；`MessageService.toAgentMessage` 改成透传，不许逐段重建 |
| R31 | `tx` 只能声明式登记，不能「读到值再决定写什么」 | 认。需要分支就把条件写进 SQL |
| R32 | R14/R18 直接改进 v1 建表语句（未发布过） | 认。眼下只有 v1，再往后追加 |
| R33 | 删除类方法要「要清哪些素材文件」 | 不进契约。app 层删完对话后问 `AssetService` 要文件清单并清理 |
| R34 | `workspaces` 无 `updatedAt` 列 | 不加列。`WorkspaceView.updatedAt` = 名下对话最近一次活动（没有就创建时间） |
| R35 | `nameIsAuto` 库里没有真值 | **加列** `conversations.nameIsAuto INTEGER NOT NULL DEFAULT 1`（创建时的原名算自动）；用户改名置 0，自动命名置 1 并写入新名。不许靠「名字是否等于原名」猜 |
| R36 | `MessageRepository.search` 无 offset / 计数 | 不扩展。`total` 是下界，注释写清 |
| R37 | 子 Agent 消息怎么关联父工具调用（F-I7） | **加列** `messages.parentToolCallId TEXT`（可空）；本轮只落列，子 Agent 消息的写入与回看归 W4（先记成已知缺口） |
| R38 | `conversation.create` 的「模型解析不出来」借用 `error.configInvalid` 塞英文短语 | 加专键 `error.modelUnresolved`（en/zh 各一条），服务层改用它 |
| R39 | 同一 cwd 再登记 → 报错还是幂等 | 报 `invalid_params` + `detail.reason=already_registered` + 已有 `workspaceId`（不幂等，多端同时点由客户端处理） |
| R40 | 撤回时该对话正在跑 → `busy` | 认 |
| R41 | `setThinking` 的「当前档」靠参数补丁反推 | 认：F-B6 写进去的就是参数，参数即真相，不另外记档位名 |
| R42 | 已吊销的凭证再吊销 → `revoked:false` | 认（本次有没有真改动库） |
| R43 | 删对话只通知 `forget`，删项目的 Scope 回收没人管 | 删项目时由 app 层调 `ScopeRegistry.disposeWorkspace(id)` |
| R44 | `assetIds → 内容段`（F-H7）没人实现 | 归 W3-E 的 `AssetService`：实现并注入 `ChatRunner` 的 `prepareAttachments` |
| R45 | core 把在途 assistant 无条件改 `Error`，D15 要求 `Aborted` 落库 | 认现口径：库里记 `Aborted` + `outcome=aborted`，内存按 core 策略，装载时 `reconcile(keep)` 修回 |
| R46 | `run.state` 不逐片推 | 认。要实时字数就由接线层/客户端累加 `message.delta` |
| R47 | 事件可能早于 `conversation.send` 回包 | 接线层缓冲：该对话的推送等回包写完再放行（W3-E 实现） |
| R48 | `conversation.changed.messageCount` 用内存数 | 认（它只是「去拉一下」的信号，不是计数真相） |
| R49 | 临时对话是否走 `ChatRunner` 的落库路径 | 不走落库路径：同一条执行逻辑，不落库、不推流式事件、一次返回。W4 补（先记缺口） |
| R50 | 未注入交接服务时不装交接插件 | 认，但装配处要推一条 `warning` 通知（不静默） |
| R51 | `ConversationRuntimePort`（临时模型 / 临时思考 / forget）没有实现者 | 放进 `runtime/ConversationStateRegistry.ts`，由 W3 组装时接到服务层 |
| R52 | `recycleAll` 对正被持有的 Scope 等释放后再销毁 | 认 |
| R53 | `onIdle` 还是 `onAllRecycled` | 以 `onAllRecycled` 为准；架构文档回改成这个名字 |
| R54 | MCP 5 层链与 skills / tools / sub-agents 目录 | 归 W4-G 算好传给 `ScopeRegistry` |
| R55 | 用量三口径、id 认领、每轮先 `reconcile`、工具消息先落 `pending` | 全部认 |

## 9. 现状快照

（口径：`feat/server-rewrite` 分支现状，取数日 2026-11-12。每一行都能用 `git log` / `wc -l` / `npx vitest run` / `grep` 复核。文档里提到的回调名、方法名、列名都能在 `packages/server/src` 里 grep 到；两处例外——R53 行里的 `onIdle` 是被否掉的旧名（记录决策用）、R13 与 §9.4 里的 `configFile` 是没落地的名字（它们正是要 PM 处置的对象）。）

### 9.1 规模

| 项 | 数 |
|---|---|
| 实现代码（`packages/server/src/**` 的非用例 `.ts`，含两个 `TestSupport.ts`） | 73 个文件、20,486 行 |
| 用例（`*.test.ts`） | 57 个文件、14,733 行、616 条 |
| `npx vitest run` | 57 个文件 / 616 条全绿 |
| `npx tsc --noEmit` | 零错误 |

### 9.2 已实现

| 块 | 落点 | 现状 |
|---|---|---|
| 契约 | `src/wire/**` | 63 个方法（14 个域）、6 个事件、13 个业务码、帧解析与守卫、`PROTOCOL_VERSION = "1"`、非消息事实的形状（`states.ts`） |
| 存储 | `src/storage/**` | 8 张表 + `messages_fts`（trigram，三触发器同步）+ v1 迁移；`Database`（worker 线程、`tx` 声明式批次、WAL、外键） |
| 服务 | `src/services/**` | Workspace / Conversation / Message / Search / Credential / Asset / Config / Agent / Model / Completion / Discovery / Notice / Question / Handoff / AutoNaming 共 15 个文件 |
| 运行时 | `src/runtime/**` | `ScopeRegistry`（依赖计数、10 分钟空闲回收、`recycleAll`、`disposeWorkspace`、`onAllRecycled`）、`RunRegistry`（忙即拒 / abort）、`ConversationStateRegistry`、`ChatRunner`（一轮的流式 + 落库 + 事件）、`TransientRunner`（临时对话） |
| 接线 | `src/net/**` | `WsHub`（握手 / 分发 / 推送与 R47 缓冲 / 二进制帧转交）、`auth`、`UploadReceiver`（三段式上传）、`discovery`（发现文件与本地凭证交付）；桥接名单 4 条 |
| handler 表 | `src/handlers/**` | 除 4 条桥接外的 59 个方法全部注册（`handlers/index.test.ts` 钉住全表覆盖）+ 能力清单 63 条 |
| 单根与命令行 | `src/app.ts`、`src/cli.ts`、`src/index.ts` | 组装、启停、发现文件、退出判据（四个触发源）；`serve` / `token`（create / list / revoke）/ `version` |
| 端到端 | `src/e2e.test.ts`、`src/server.integration.test.ts`、`src/cli.process.test.ts` | 假 agent 跑完整一轮、跨进程读写同一库、真起进程（`--port 0` + 发现文件） |

### 9.3 未实现（与 `architecture.md` §9 同源）

| 缺口 | 现状 |
|---|---|
| 子 Agent 消息回看（F-I7） | `messages.parentToolCallId` 列与 `MessageRepository.listByParentToolCallId` 都在，但生产路径没有写入方；`message.list(toolCallId)` 取到的是那次委派的工具结果消息 |
| `statusBlocks`（F-I6） | `conversation.state` 里恒为空数组，块切分留给呈现层 |
| 客户端自造问题 | 契约只有 `question.list` / `question.answer`，问题的产生方在服务端内部（交接线 / 登记项目 / 二次确认） |
| 日志落文件（F-J2） | 只有注入式 `HubLogger`（`warn` / `error`），落文件与轮转没有实现者 |
| 配置文件的端口（D25 第二顺位） | `configPort` 注入这条路通，CLI 没有从 `config.json` 读端口的来源 |

### 9.4 与裁定 / PRD 对不上的地方（文档按实现记，等 PM 定）

| 出处 | 现象 | 建议 |
|---|---|---|
| R6 | `server.hello` 回的是完整 `CapabilityView[]`（与 `server.capabilities` 同一份），不是「只回能力 id 列表」 | 认实现（清单只有一份），把 R6 的措辞改成「hello 与 capabilities 回同一份清单」 |
| R12 | 端口值不合法时 `resolveListenTarget` 按「没给」回落下一顺位，不报 `config_invalid` | 要么改裁定（回落 + 日志），要么改 `config.ts` 报错 |
| R13 | `ServerPaths` 没有 `configFile` 字段，`config.json` 由 `app.ts` 拼 `<dataRoot>/config.json` | 认实现并把 R13 的落点写对，或给 `config.ts` 补字段 |
| PRD D25 | D25 写「不做发现文件」，实现有 `<dataRoot>/run/server.json`（`net/discovery.ts` + `ServerApp.detectRunningInstance`，架构 §2 的 A 级事实） | 由 PM 裁定：要么改 D25 的措辞（承认发现文件），要么拆掉单实例发现这条路 |
| PRD F-A5 | F-A5 把「查帮助与版本」判给客户端（C），而契约里有 `server.version` / `server.capabilities`（F-E3 / F-E5 需要服务端报这两样） | 两条不互斥（服务端给事实、客户端出界面），建议保留现状 |
| PRD F-C7 | 「开新会话；旧的有内容则先归档」在契约里没有对应动作（`conversation.create` 只建新行，旧对话本来就边流边写、无需归档） | 由 PM 确认这条是否已被 D15 的边流边写取代 |

## 10. PM 裁定（W5-A 审计后）

| # | 问题 | 裁定 |
|---|---|---|
| R56 | F-C2 空会话：`conversation.create` 立刻落库 | **不落库**：create 只发一个 id + 定死身份，首次 `send` 时才写行（PRD 原文「没有用户消息就不写，否则一堆空会话」）。没发消息就断线重连的会话自然消失，这是对的 |
| R57 | `server.hello` 回完整能力清单 | 按 R6：`hello` 只回**能力 id 列表**（`string[]`），细节走 `server.capabilities`；后者按连接语言渲染 |
| R58 | D8 缺「配置的默认语言」 | SDK `AppConfig` 加 `language?: "en" \| "zh"`，可经 `config.setDefaults` 写；`hello` 缺省语言取它（再缺省 `en`） |
| R59 | F-D2 的触发归属 | **服务端自己触发**：`ChatRunner` 一轮结算后回调 `onTurnSettled({promptTokens, handoffTokens, language})` → `QuestionService.askHandoff`。`AutoMigratePlugin` 必须传 `resolveMode: () => null`（永不自动迁移，§5 明令） |
| R60 | D10 拿不到 cwd | `conversation.create` 的 `workspaceId` 变得可选、新增可选 `cwd`：cwd 未登记时**不建对话**，建一个 `conversationId` 为空的 `workspace_registration` 问题并回 `{requiresRegistration:true, questionId}` |
| R61 | `question.list` 要 conversationId | 放开：`conversationId` 可选，不给就按 `state` 查全库（含 `conversationId` 为空的问题） |
| R62 | D24 回填同时给 content 与 assetIds（图片会重复两遍） | 回填只给**纯文本 + `assetIds`**，图片靠 assetIds 复原 |
| R63 | F-E1 缺「重载」 | 新增 `server.reload { scope?: "config"\|"agents"\|"tools"\|"skills"\|"mcp" }`，复用配置生效那条路，返回同一份报告 |
| R64 | F-J2 日志 | 补真实现：`<dataRoot>/logs/server.log` + 轮转；warn/error 同时上通知（永久） |
| R65 | F-I6 `statusBlocks` 恒空 | 按 `STATUS_BLOCK_IDS` 拼装 8 块，纯拼装、不新增状态 |
| R66 | D4 没有自检 | 启动后低频（30s、`unref`）比对磁盘版本，变了就收尾退出（由启动方式重拉） |
| R67 | D25 的「配置文件」一档 + R12 非法端口静默回落 | 配置文件端口要有真实来源；**显式给出但非法的端口报 `config_invalid`**，只有完全没给才回落默认 |

## 11. 用户裁定（2026-11-13，会话级模型与思考档位）

- **R70**：`/model` 与 `/think` 只改**这一段会话**的模型与思考档位，**持久化在会话行上**（`conversations.modelId` + 新增 `conversations.thinkingLevel`）；改全局一律去改 **agent 定义**（`agent.setModel` / `agent.setThinking`），不用命令临时指定。
- **R71**：模型与思考档位的持久化级别**必须对称** —— 两个都在会话级，不存在「一个进库一个只在内存」。
- **R72**：**换模型必须同步清掉思考档位**（档位名是旧模型策略表里的键）。
- **作废**：L7 里「临时换模型只在内存、不进库、重开回默认」这半句；`ConversationStateRegistry` 的「临时覆盖」概念（文件已删）；**§5 的 R41**（「当前档靠参数补丁反推」）现在只对助手定义那一侧成立，会话级是**记档位名**。
