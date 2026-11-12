# 服务端架构

> **本文边界**：PRD 说「要为用户做到什么」，本文说「这些事怎么搭起来」。
> 本文没写的，按 PRD 办；两者冲突，以 PRD 为准，并回头改本文。
>
> 骨架参照 `ai-zen/desktop` 分离前那份本地实现（分支 `ref/pre-separation`，提交 `5498691`，13 个文件 1,524 行），**不从 `packages/server/bad-src` 继承任何东西**。

- 状态：已按实现复核（W5-B：逐节对照 `packages/server/src/**` 回改；描述的是现在的代码，不是打算）
- 归属：`packages/server`，按推倒重写处理

---

## 1. 已定的架构决定

| # | 定论 | 出处 |
|---|---|---|
| A1 | 一个服务端进程装所有对话；对话之间不做进程隔离 | 本轮 Q1 |
| A2 | 一个监听器、一条 WebSocket，RPC / 推送 / 二进制上传都走它 | 本轮 Q2 |
| A3 | 契约归服务端自己（不独立成包、不叫「约定」），客户端照着用 | 本轮 Q3 |
| A4 | JSON-RPC 2.0 为底，产品形状长在 `params` / `result`；标准里对我们有负担的部分（批量请求、强制错误码空间、通知必须无 id）不用 | 本轮 Q6 |
| A5 | 所有连接都要凭证；本地无感靠「创建时凭证已自动填好」，不靠回环豁免 | 本轮 Q7 / Q8 |
| A6 | 本地实例只监听回环；对外由创建者起、自己配凭证并分发 | 本轮 Q7 |
| A7 | `node:sqlite` + worker 线程 + WAL；全文检索用 FTS5 `trigram` | 本轮 Q4 |
| A8 | 分层照桌面端：单根 + 薄 service + 一层仓储，按需扩展，不预摆空层 | 本轮 Q5 |
| A9 | agent 跑完即弃；Scope 无依赖后空闲 10 分钟回收（与 MCP 同生共死） | PRD D28 |
| A10 | Scope 与对话的回收计时器**只有一处**（见 §4） | 本文 |
| A11 | 上传走同一条 WS 上的**二进制帧**（三段式），不用 base64 字符串 | 本轮 Q9 |
| A12 | `message.list` 按**消息 id 取**：带 `after=<id>` 时，该 id **存在**就返回它**最新的内容**及之后全部；该 id **不存在**就返回全部（断线补拉与删除后重拉共用这一条规则） | 本轮 Q10 |
| A13 | 能力清单的粒度是「契约里每个方法一条」（64 条，与 `METHOD_NAMES` 一一对应）；同一条 PRD 能力号下有多个方法时，`id` 用 `<编号>#<动作>` 区分 | `src/handlers/capabilities.ts` |

## 2. 进程与接线

**启动方式决定监听范围**，不是运行时判断：

| 启动方式 | 监听 | 凭证 |
|---|---|---|
| 被本地客户端拉起（本地实例，`local: true`） | 只监听回环（`127.0.0.1`） | 服务端首次启动时生成，客户端自动取 |
| 创建者手动起、要给别人连（对外实例，`--public`） | 监听创建者指定的地址（缺省 `0.0.0.0`） | 创建者在自己的入口里创建凭证（带备注），手动分发给对方 |

端口按 PRD D25，优先级是启动参数 > 配置文件 > 默认端口 8790，落点是 `src/config.ts` 的 `resolveListenTarget`。两种边界情形按代码现在的样子记着：

- 端口给 `0` 表示由系统分配（`--port 0`，`app.ts` 的 `resolveTarget` 对它单独放行）；用例与冒烟都用这个写法。
- **显式给出但不合法的端口报 `config_invalid`，不静默回落**（裁定 R67）：非整数、越界都拒；`0` 只认启动参数那一档（“让系统分配”这件事在配置文件里说不清）。只有完全没给才落到下一顺位。端口被占用时 `WsHub.listen` 把错误抛给启动流程，进程以失败退出 —— 自动改监听端口的路径没有实现，要换端口就显式写 `--port 0`。

**配置文件那一档的真实来源是 `<数据根>/server.json`**（形状 `{ "port": 8790 }`，见 `src/config.ts` 的 `readServerSettings`）：文件不在或没写 `port` 就算“这一档没说话”；写坏了（不是 JSON 对象）或端口不合法按 `config_invalid` 拒绝。`cli.ts` 的 `serve` 与 `ServerApp.create()` 都读它 —— 前者读了随 `configPort` 传下去，后者在不给 `configPort` 且启动参数没给端口时自己读。

**单实例靠发现文件**：`<数据根>/run/server.json` 是「这台机器上谁在服务」的唯一真相（`pid`、`host`、`port`、`version`、`local`、`startedAt`，见 `src/net/discovery.ts` 的 `ServerFileInfo`）。启动时 `ServerApp.detectRunningInstance` 读它：pid 活着就挂靠那个地址、不重复监听；pid 已死或文件坏了就清掉再起。客户端探活也读它。

**凭证交付**：凭证自身一份真相在库里（可列出、带备注、可单独吊销）；`<数据根>/run/token` 只是个交付口，内容只有「本地那串」，本地实例启动时由 `createLocalCredential` 生成、由 `writeLocalToken` 写入。对外实例不写这个文件，只提示用 `token create` 自己建再分发。交付文件的权限是**尽力而为**地设成 `0600`（POSIX 上挡住同机其他用户；**Windows 上 `mode` / `chmod` 不改变 ACL**，那里的保护来自用户目录本身）—— 文档和文案都不把它当安全保证。

**升级**（PRD D4）：`server.upgrade` 比磁盘上的版本（`readDiskVersion` 读本包 `package.json`）与运行版本，确认新版本真的落盘了才安排一次收尾，进程退出后由启动方式重新拉起；服务端不自己装包，也不 `exec` 回自己。**启动后还有一道低频自检**（裁定 R66 / `app.ts` 的 `checkDiskVersion`）：每 30 秒（`unref()` 的定时器，`stop()` 里清掉）比一次磁盘版本，磁盘上的那个更新就推一条 `notice.upgradeRestarting` 再走同一条收尾；回退不算升级，不重启。

**数据根**（`AI_ZEN_DIR`，缺省 `~/.ai-zen`，可被环境变量改）。`ServerPaths`（`src/config.ts`）给出数据根与它下面的库、附件、运行期目录、发现文件、凭证文件、两份配置文件与日志目录；`config.json` 交给 SDK 的 `ConfigManager`（`ServerPaths.configFile`），`server.json` 是服务端自己的设置（`ServerPaths.serverConfigFile`）；`agents/ sub-agents/ skills/ tools/ mcp-oauth/` 与 `mcp.json`、`reasoning-presets.json` 由 SDK 的 `ConfigManager` 在其 `basePath`（= 数据根）下推导与释放：

```
<数据根>/
├── ai-zen.db              # 全机一个库（ServerPaths.dbFile）
├── assets/                # 上传临时文件与正式素材（ServerPaths.assetsDir）
├── config.json            # 配置唯一真相（ServerPaths.configFile；ConfigManager 以它为边界）
├── server.json            # 服务端自己的设置：端口那一档（ServerPaths.serverConfigFile）
├── logs/                  # 服务端日志（ServerPaths.logsDir；server.log + 轮转出的 .1…）
├── reasoning-presets.json # 思考策略表（ConfigManager）
├── mcp.json               # 用户级 MCP 配置（ConfigManager）
├── agents/                # 助手定义（一实体一文件）
├── sub-agents/            # 子 Agent 定义
├── skills/                # 出厂与用户 Skill
├── tools/                 # 用户工具
├── mcp-oauth/             # MCP 的 OAuth 凭据
└── run/
    ├── server.json        # 发现文件（ServerPaths.serverFile）
    └── token              # 本地凭证交付文件（ServerPaths.tokenFile）
```

## 3. 对象图

**单根 + 构造函数显式注入**，同桌面端 `DesktopApp`：不用模块级单例、不用反射扫描。依赖从根出发，跨服务协作（删对话 → 释放运行中的轮次）用显式钩子声明，不靠事件总线兜。

```
ServerApp（根：组装、启动、退出）
├─ 基础设施
│  ├─ ConfigManager        (SDK)  ← 配置唯一入口（basePath = 数据根）
│  ├─ Database             SQLite worker（all / get / run / tx / close）
│  ├─ *Repository          只做 SQL，不含业务（一表一文件）
│  ├─ i18n                 render / normalizeLanguage（en 基准、zh；未知语言回落 en）
│  └─ Logger               日志落 `logs/server.log`（按大小轮转）、warn / error 同时上通知
├─ 服务（一服务一文件，薄，共 15 个）
│  ├─ WorkspaceService、ConversationService、MessageService、AgentService
│  ├─ ModelService、ConfigService、AssetService、SearchService、CredentialService
│  └─ CompletionService、DiscoveryService、HandoffService、NoticeService、QuestionService、AutoNaming
├─ 运行时（有状态，比 service 更长寿）
│  ├─ ScopeRegistry             workspaceId → Scope + 依赖计数 + 空闲计时
│  ├─ RunRegistry               conversationId → 运行中的那一轮
│  ├─ ConversationStateRegistry 进程内状态：临时模型 / 临时思考档 / forget
│  ├─ ChatRunner                一轮的流式循环（借 Scope、产出事件、落库）
│  └─ TransientRunner           临时对话的一轮（不落库、不推流式事件）
├─ 接入
│  ├─ WsHub                连接集合、鉴权、语言、JSON-RPC 分发、推送缓冲
│  ├─ UploadReceiver       同一条 WS 上的二进制分帧落盘
│  ├─ auth / discovery     凭证校验、发现文件与本地凭证交付
│  └─ handlers/            方法实现（一域一文件）→ HandlerTable；能力清单也在这一层
```

目录（`packages/server/src/`）：

```
app.ts        单根：组装、启动、退出
cli.ts        命令行：serve / token / version
config.ts     路径与端口来源
index.ts      包出口（wire 类型 + createServer）
wire/         契约：methods（方法表）、frames（帧）、errors（业务码）、events（事件）、states（状态形状）
net/          WsHub、auth、discovery、UploadReceiver
handlers/     方法实现（一域一文件）+ capabilities（能力清单）+ index（HandlerTable 与桥接名单）
services/     薄服务 + Logger（日志文件与轮转）
runtime/      ScopeRegistry、RunRegistry、ConversationStateRegistry、ChatRunner、TransientRunner
storage/      Database、dbWorker、Repository、migrations
i18n/         文案（en 基准 / zh）
```

## 4. 生命周期

**一轮对话**：

```
请求到达 → RunRegistry.start（该对话已在跑则抛 ServerError("busy")，PRD D14）
        → 借 Scope（ScopeRegistry.acquire：懒创建或复用，依赖 +1）
        → 装配 agent（模型/助手/权限来自 SDK，跑完即弃）
        → 流式：增量推事件；同一条消息边流边写
        → 内循环结束：写一次（D15）→ agent 释放 → ScopeRegistry.release（依赖 −1，归零则起 10 分钟计时）
```

**计时器只有一处**：`ScopeRegistry` 持有唯一那份空闲计时。L4 说的「10 分钟无活动」和 D28 说的「Scope 空闲 10 分钟」，是同一个计时器的两个说法，不各写一份。全部 Scope 都回收完时它回调 `onAllRecycled(cb)`（`src/runtime/ScopeRegistry.ts`），单根据此重算退出判据。

**进程退出**：判据是「连接数 0、已经握过手（`served`）、没有在跑的轮次、`ScopeRegistry.size()` 为 0」。触发源有四个，都不另起计时器：`ScopeRegistry.onAllRecycled`、每轮结算（`onTurnSettled`）、`WsHub.onConnectionsChanged`、`server.shutdown`。进程退出连带断开所有 MCP 连接，这是已知代价（MCP 服务器自己拉起的外部进程可能随之结束，取决于那个 MCP server 的实现）。

**收尾（`stop()`）的顺序**：摘发现文件 → 回收 Scope → 断连接 → 清理上传 → 关库 → 关日志（先写最后一笔，再 flush 并关流，PRD F-J2）。同一次收尾还负责清掉升级自检的定时器（裁定 R66）。

**Scope 被销毁的三个原因**：(1) 空闲 10 分钟（`release` 后计时到点）；(2) Workspace 被删（`disposeWorkspace(id)`）；(3) 配置变更需要重连 MCP（PRD F-E2，`recycleAll()`，正被持有的 Scope 打标记、等最后一次 `release` 再销毁）。

## 5. 存储

`node:sqlite`（SQLite 3.53.4，实测支持 WAL / json1 / FTS5 / `trigram`）跑在 worker 线程里，主线程只发消息。`Database` 对外五个方法：`all` / `get` / `run` / `tx` / `close`；worker 侧开 `PRAGMA journal_mode=WAL` 与 `PRAGMA foreign_keys=ON`。

**`tx` 是声明式批次，不是「在事务里跑一段 JS」**：

```ts
const [found, written] = await db.tx((q) => [
  q.get<{ n: number }>("SELECT n FROM t WHERE id = ?", [id]),
  q.run("UPDATE t SET n = n + 1 WHERE id = ?", [id]),
]);
```

回调里的 `all` / `get` / `run` 只**登记**语句（拿到的是带下标的凭据），回调返回后整批一次性送进 worker：`BEGIN IMMEDIATE` → 按登记顺序逐条执行 → `COMMIT`，任一条失败整批 `ROLLBACK`。结果按回调返回的凭据（数组或单条）对回调用方。这个形状的边界是：**读到的值回不到 JS 里去决定下一条写什么**（那需要 worker 等主线程）；需要按读到的值分支的场合，把条件写进 SQL（裁定 R31）。回调自己抛错时批次还没发出去，库里没有改动。

表骨架（`src/storage/migrations.ts`，眼下只有 v1）：

| 表 | 关键列 |
|---|---|
| `workspaces` | `id`、`name`、`cwd`（不可变、`UNIQUE`）、`createdAt` —— 没有 `updatedAt` 列（R34） |
| `conversations` | `id`、`workspaceId`（级联删）、`name`、`nameIsAuto`（0/1，DEFAULT 1，R35）、`pinned`、`agentId`（NOT NULL）、`modelId`（NOT NULL，R18）、`createdAt`、`updatedAt`；索引 `(workspaceId, pinned DESC, createdAt DESC)` |
| `messages` | `id`（服务端分配，请求发出前就有）、`conversationId`（级联删）、`seq`（与对话内唯一）、`role`、`status`、`omit`、`content`(json)、`data`(json)、`searchText`、`parentToolCallId`（可空，R37）、`createdAt`、`updatedAt`；索引 `(conversationId, seq)`、`(parentToolCallId)` |
| `assets` | `id`、`conversationId`（级联删）、`messageId`（`ON DELETE SET NULL`，R16）、`name`、`path`、`mime`、`bytes`、`sha256`、`createdAt` |
| `notices` | `id`、`level`、`code`、`params`(json)、`durationMs`（null = 永久）、`conversationId`（可空、级联删）、`createdAt`（L3：持久化，手动清或到点消失） |
| `questions` | `id`、`conversationId`（可空、级联删）、`kind`、`payload`(json)、`state`、`answer`(json)、`createdAt`、`updatedAt`、`answeredAt` |
| `credentials` | `id`、`note`、`hash`（唯一索引）、`createdAt`、`revokedAt` |
| `meta` | 单行表（`id` 固定 1）：`schemaVersion`、`createdAt` |

**全文检索**：`messages_fts` 是挂在 `messages` 上的 FTS5 外部内容表，只索引 `searchText` 一列，`tokenize='trigram'`，用三个触发器（insert / delete / update of `searchText`）同步。两条实测约束落在实现里：(1) `unicode61` 下整段中文是一个 token，用错就搜不到；(2) `trigram` 的查询词至少 3 个字符，少于 3 个字符时 `MessageRepository.search` 走 `LIKE` 子串（D16 的「成本接受」就落在这）。

**边流边写**：运行时以内存里的消息为真相，同一条消息行按节流 upsert；装载/崩溃恢复复用 core 的 `reconcileAbortedToolRounds(fill)` + `reconcileAbortedMessages(keep)`，所以 `status` / `omit` 两列必须落盘（PRD D15）。

**迁移**：`meta.schemaVersion` + 顺序迁移脚本，启动时逐级在事务里跑（结构改动与版本号同一次提交）；不识别任何旧数据（L1）。R14/R18 等结构裁定直接落在 v1 的建表语句里，没有追加 v2（这套表结构还没随版本发出去，R32）。

**库之外的两份文件**：`config.json`（配置唯一真相，`ServerPaths.configFile`）与 `server.json`（服务端自己的设置：端口那一档，`ServerPaths.serverConfigFile`）；日志的落点由 `ServerPaths.logsDir` 给出，详见 §2。

## 6. 接线：一条 WS 上的 JSON-RPC

**首帧 `hello`**：`{ token, language?, clientInfo: { name, version, platform? } }`（`src/wire/methods.ts` 的 `ServerHelloParams`）。凭证不放在 URL 查询串里（会进日志与进程表）；未 `hello` 成功的连接只放行 `hello`，其余方法与二进制帧都回 `unauthorized`。`language` 挂在连接上，断开即忘；没带时用 `config.json` 的 `language`（缺省英文，裁定 R58）。`hello` 成功时一并回：协商出的 `language`、`serverVersion`、`protocolVersion`、`startedAt`、**能力 id 列表 `capabilities`（`string[]`，裁定 R57）**、附件上限 `limits`。完整的清单（标题、说明、属性）走 `server.capabilities`。

**方法名**：`<域>.<动作>`。契约里共 64 个方法（`src/wire/methods.ts` 的 `METHOD_NAMES`，14 个域）：

| 域 | 个数 | 方法 |
|---|---|---|
| `server` | 8 | `hello` `version` `upgrade` `shutdown` `usage` `capabilities` `reload` `setLanguage` |
| `workspace` | 5 | `list` `create` `get` `rename` `remove` |
| `conversation` | 13 | `list` `create` `get` `state` `rename` `pin` `delete` `send` `abort` `revert` `setModel` `setThinking` `transient` |
| `message` | 1 | `list` |
| `question` | 2 | `list` `answer` |
| `notice` | 3 | `list` `dismiss` `clear` |
| `config` | 7 | `get` `patch` `setDefaults` `getDiscovery` `patchMcps` `saveEndpoint` `deleteEndpoint` |
| `agent` | 7 | `list` `get` `create` `update` `delete` `setModel` `setThinking` |
| `model` | 8 | `list` `listImages` `create` `update` `delete` `restoreFactory` `saveImage` `deleteImage` |
| `credential` | 3 | `list` `create` `revoke` |
| `asset` | 2 | `begin` `end` |
| `completion` | 1 | `files` |
| `handoff` | 2 | `start` `listDocuments` |
| `search` | 2 | `conversations` `messages` |

**桥接名单（4 条不在 handler 表里）**：`server.hello`、`server.setLanguage`、`asset.begin`、`asset.end` 由 `WsHub` 自己处理（`src/handlers/index.ts` 的 `BRIDGED_METHODS`），其余 59 条进注入的 `HandlerTable`。为什么是这四条：

- `server.hello` / `server.setLanguage`：凭证与语言都是**连接状态**（`ConnectionState.authorized` / `language`），业务层拿不到也不该管；
- `asset.begin` / `asset.end`：上传要按 `connectionId` 分帧落盘、断线按连接清理（`UploadReceiver`），同样只有接线层知道是哪条连接。

分发顺序是 `hello` → 未握手拒绝 → 已知方法名校验 → 上面两条连接级方法 → 注入 `UploadReceiver` 时的两个上传方法 → handler 表；表里没有的名字回 `unsupported`（`detail.reason = handler_not_registered`）。`handlers/index.test.ts` 钉住这件事：契约里的每个方法要么在表里、要么在桥接名单里，且两边不重叠。

**`message.list` 的取法（A12）**：入参 `conversationId`、`after?: <消息 id>`、`toolCallId?`。

| `after` | 返回 |
|---|---|
| 不给 | 该对话全部消息 |
| 给了且该 id 存在 | **从这条消息开始**（含它本身，内容是**最新**的，可能是流式中那条的部分内容 + 还在写的标记，L5）+ 其后全部；出参的 `anchor` 就是这条 id |
| 给了但该 id 不存在（已删除、或库已换） | 全部，`anchor` 为空 |

“从这条开始而不是它的下一条”是故意的：重连的客户端上次拿到的最后一条可能是流式中那条，它的内容已经变了；从它自己重新拿，天然就是“最新内容 + 之后的”。`toolCallId` 是在这条结果集上再按消息自己的 `tool_call_id` 过滤一次（F-I7 的取法，见 §9 的已知缺口）。

**推送**：JSON-RPC 通知（无 id）。事件名放在帧的 `method`，载荷直接放 `params` —— 形状由 `src/wire/frames.ts` 的 `notification(event, payload)` 定：

```json
{ "jsonrpc": "2.0", "method": "run.state", "params": { "conversationId": "...", "run": {}, "at": "..." } }
```

不重放、不需要 ack —— 断线即作废，重连按 D5 自己拉状态与消息。受理即返回的方法（`conversation.send` 这类）会产生「事件早于回包」的顺序问题：`WsHub` 按请求参数里的 `conversationId` 先挂起该对话的推送，回包写完再按序放行（裁定 R47）。事件里的 `LocalizedText` 在产生现场按默认语言渲染一份，出网前由注入的 `localizeEvent`（`NoticeService.createEventLocalizer`）按**这条连接的语言**重渲染（D8）。

**错误**：JSON-RPC `error` 对象；`data.code` 是稳定业务码（13 个，`src/wire/errors.ts` 的 `BizCode`：`unauthorized` / `invalid_params` / `not_found` / `busy` / `payload_too_large` / `unsupported` / `internal` / `config_invalid` / `mcp_unavailable` / `model_unsupported` / `handoff_declined` / `question_pending` / `context_guard`），数字码只做粗分类（`jsonRpcCode` 映射）；`data.message` 是按连接语言渲染好的人话（服务端出文案，D8）；结构性事实（哪个字段不对、还差什么）放 `data.detail`，不让客户端解析句子。批量请求（帧是数组）回 `unsupported`（`detail.reason = batch_not_supported`，R11）。

**推送（含通知）入库存的是「码 + 参数」，不是渲染好的句子**：多语言在读出时按该连接的语言渲染（D8），否则一条通知存死一种语言，换个语言连回来就错了。`notices` 表存 `code` + `params`，`hello` / 出网时才渲染成 `NoticeView.text`。

**上传**：同一条 WS 上走三段式 —— `asset.begin`（JSON：`purpose` / `mime` / `bytes` / `conversationId` / `name?`，返回 `uploadId`）→ 若干二进制帧 → `asset.end`（`uploadId` + `sha256`，服务端校验总长与摘要后落定成正式素材并回 `AssetRef`）。单张 20MB 上限（D5），超限在 `begin` 就拒；中途断开按 `begin` 记的临时文件清理（`UploadReceiver.abortConnection`）。

二进制帧的格式（`src/net/UploadReceiver.ts` 的 `encodeChunkFrame` / `decodeChunkFrame`，客户端复用同一份）：

```
| 4 字节大端无符号整数 N | N 字节 UTF-8 JSON 头 {"uploadId": "..."} | 若干字节片段 |
```

头里带 `uploadId` 是因为同一条连接上可以并发多个上传（一次拖进四张图就是四个）；头做成「长度前缀 + JSON」是为了抓包与日志里仍然可读。头长度有上限（4096 字节），坏帧回 `invalid_params` 并带 `detail.reason`（`frame_too_short` / `bad_header_length` / `truncated_header` / `header_not_json` / `header_without_upload_id`）。片段按到达顺序串行追加进 `<assetsDir>/.upload-<uploadId>.part`，不攒进内存。

## 7. 事件形状

事件共 6 个（`src/wire/events.ts` 的 `EventMap` / `EVENT_NAMES`），出网形状是 `{ jsonrpc, method: <事件名>, params: <载荷> }`（见 §6）：

| 事件 | 载荷 |
|---|---|
| `run.state` | `conversationId` + 一份 `RunState` 快照（`status` 空闲/在跑/已结束、`generation` 六态：连上 / 等首字 / 在想 / 在输出 / 拼工具调用 / 等工具、`subagents`、`usage`、`outcome`、`problem`）+ `at`；发全量快照而不是差量 |
| `message.delta` | `conversationId` + `messageId` + 消息内递增的 `seq` + core 的 `AgentNS.Delta` 原样（正文 / 思考 / 工具调用由它自己的字段区分）+ `at` |
| `conversation.changed` | `conversationId` + `workspaceId` + `change`（`created` / `renamed` / `pinned` / `messages_persisted` / `message_removed` / `settings_changed` / `deleted`）+ `messageCount` + `at` —— 让客户端知道「该去拉了」 |
| `notice` | `notice`（`NoticeView`：三档语气 `info`/`warning`/`error`、`duration` 秒或 null、`conversationId` 或 null、`text`）+ `at` |
| `question` | `question`（`QuestionView`：`id`、`kind`（`handoff`/`workspace_registration`/`confirmation`）、`prompt`、`options`、`state`、`answer`、`blocking`）+ `at`；多端看同一个（D22） |
| `usage` | `conversationId` + `usage`（`UsageSnapshot`：`turn` 本轮 / `total` 累计 / `subAgent` 累计里子 Agent 贡献的那部分 / `rate` 速率）+ `at` |

事件只描述「发生了什么变化」，需要完整对象时客户端回服务端拉（`conversation.state` / `message.list`），这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。

**能力清单（A13）**：`server.capabilities` 回完整清单、`hello` 只回 id 列表（裁定 R57），粒度是**每个契约方法一条**（64 条），每项带 `id`（PRD 能力号；同号多方法时为 `<编号>#<动作>`，如 `F-F2#deleteEndpoint`）、`domain`、`title` / `description`（`LocalizedText`，键为 `capability.<方法名>` / `capability.<方法名>.detail`）、`method`、`blocking`（执行期间占住这段对话，F-E6）、`destructive`（不可撤销，F-F9 的二次确认）。`workspace.*` 那几条在 PRD §4 没有单列能力号，`id` 用契约注释里记的决定号（`D9` / `D10` / `D11`）。清单与 `METHOD_NAMES` 一一对应（id 与顺序与语言无关），标题与说明按**连接的语言**渲染（裁定 R58：存码不存句子，出网前重渲染）；用例钉住这两条。

## 8. 与 core / SDK 的边界

| 归谁 | 内容 |
|---|---|
| `@ai-zen/agents-core` | `Agent`、流式 `applyChunk`、消息与工具调用结构（`AgentNS.Message` / `MessageContent` / `ToolCall` / `Delta` / `Usage`）、中止修复（`reconcileAbortedToolRounds` / `reconcileAbortedMessages`） |
| `@ai-zen/agents-sdk` | `Scope`（能力装配）、`allInOne` 五类插件（内置工具 / 用户工具 / Skill / MCP / 子 Agent）、`ConfigManager`、`createAgent` / `SdkAgent`、`HandoffService`、各插件的 `discover*`、出厂 Skill 与思考策略表、`fileToContentSection` |
| 服务端 | 进程与接线、凭证、Workspace 与对话的生命周期、Scope 的持有与回收、持久化、i18n 文案、通知与问题对象、上传 |

原则：**agent 循环不重写**，服务端只做「装配 + 持久化 + 接线」。

## 9. 已知缺口

登记的是「代码里确实还没有的那部分」，不是待办计划：

| 缺口 | 现状 |
|---|---|
| 子 Agent 消息回看（PRD F-I7） | `messages.parentToolCallId` 列已落库（R37），`MessageRepository.listByParentToolCallId(conversationId, parentToolCallId)` 也有了；但生产路径里没有写入该列的调用方（只有用例在用），也没有方法把它暴露出去。眼下 `message.list(toolCallId)` 按消息自己的 `tool_call_id` 过滤，取到的是那次委派的工具结果消息 |
| 状态栏块里的助手名字与可用性（PRD F-I6） | `conversation.state` 的 `statusBlocks` 按八块给出，但 `agent` 块的 `name` / `available` 恒为 `null`：这两项在助手定义那一层（`AgentService`），而 `conversation.state` 这一跳只看得见对话自己存的 `agentId` |
| `config.setDefaults` 写缺省语言的契约形状 | 服务端收下 `defaults.language`（`ConfigService` 的 `DefaultsInput`），但 `wire/methods.ts` 的 `DefaultSelection` 还没有这一项，`config.get` 的 `defaults` 也还不回它 |
| 「客户端自造问题」 | 契约里只有 `question.list` / `question.answer`。问题对象由服务端内部产生（交接线、cwd 登记、不可撤销动作的二次确认），没有让客户端或脚本提问的方法（`server.integration.test.ts` 的 `seedQuestion` 因此绕开契约，直开库调 `QuestionService.ask` 造一行） |

## 10. 待拍板

（已清空：上一条“`message.list` 怎么取”已由 A12 定下。）

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 初稿：定 A1–A10；进程与接线、对象图、生命周期、存储、接线、事件形状、SDK 边界 |
| 2026-11-12 | 上传定为二进制帧（A11）；§9 待拍板只剩一条 |
| 2026-11-12 | `message.list` 取法定下（A12）：按 id 取、含自身最新内容、id 不存在则全量；§9 清空 |
| 2026-11-12 | 按实现复核（W5-B）：回调名改 `onAllRecycled`；补桥接名单与二进制帧格式；推送的事件名在 `method`；表骨架按实际列重写；`tx` 的声明式批次边界写清；方法表 63 个 / 事件 6 个 / 能力清单粒度（A13）落文；数据根目录树按 `ConfigManager` 实际推导；新增 §9 已知缺口，原 §9/§10 顺延 |
| 2026-11-12 | W6-B 运维与展示面：方法表 63 → 64（`server.reload` 进表，A13 的能力条数同步）；§6/§7 改正「`hello` 回完整清单」为**只回能力 id 列表**（R57）；§2 端口那一档补真实来源 `<数据根>/server.json` 与「显式非法端口报 `config_invalid`」（R67）、补升级自检（R66）、数据根目录树与 §5 补 `server.json` 与 `logs/`（F-J2）、§3 的日志口子由 `HubLogger` 改为 `Logger`、§4 补收尾顺序；§9 已知缺口按本轮实现改写（状态栏块、日志、端口三条出列，补助手名字与 `DefaultSelection.language` 两条） |
