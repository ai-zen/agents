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
| A13 | 能力清单的粒度是「契约里每个方法一条」（65 条，与 `METHOD_NAMES` 一一对应）；同一条 PRD 能力号下有多个方法时，`id` 用 `<编号>#<动作>` 区分 | `src/handlers/capabilities.ts` |

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
runtime/      ScopeRegistry、RunRegistry、ChatRunner、TransientRunner
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

**一段对话的模型与思考档位存在会话行上**（`conversations.modelId` / `conversations.thinkingLevel`，PRD L7 / F-B4 / F-B6）：改了就落库，重开重连、重启都还是它。装配 agent 时从这里取：`modelId` 直接给 SDK 的三级解析（会话级那一档），`thinkingLevel` 按该模型引用的思考策略表展开成参数补丁、叠在助手定义的 `modelParams` 之上（同一模型才叠：会话把模型换掉之后，定义上那份参数是给旧模型的）。展开发生在 `ChatRunner.createSdkAgentFactory`（`conversationModelParams`），档位名本身不进请求。换模型时档位被清空（它是模型的档位）。服务层要的运行时接口因此只剩两件事：忙不忙（`RunRegistry.isRunning`）与删掉之后的中止（`ChatRunner.forget`）。

**一段对话的诞生（R56）**：`conversation.create` 只定身份（`workspaceId` / `agentId` / `modelId`）并发一个 id，不写库；首次 `conversation.send` 时 `ConversationService.ensurePersisted` 才把这一行写进 `conversations`。**落行那一刻同时写这段对话的第一条消息**：一条 `role: user`、`hidden: true` 的消息，正文告诉模型这段对话对应的 cwd（PRD F-D9，正文由 `injectedContextOf` 拼）。它最先写，所以 `seq` 在真实用户消息之前；之后每一轮都不再写、也不再往用户消息里拼任何东西。cwd 取这段对话所属 `workspaces.cwd`（不读进程工作目录），`workspaceId` 创建即定死，没有任何方法能改它。

**`hidden` 的含义就是「这条不给人看」**（core `AgentNS.Message.hidden`）：它仍参与模型上下文（`ChatRunner.reconcile` 取历史时显式带上），但 `message.list` 默认不返回、侧栏条数与删除代价都不数它；客户端按这个字段决定不展示。临时对话（`TransientRunner`）不落库，同一条 cwd 消息只拼在内存的发送内容里（`agent.append` 一条 `hidden` 消息）。

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
| `conversations` | `id`、`workspaceId`（级联删）、`name`、`nameIsAuto`（0/1，DEFAULT 1，R35）、`pinned`、`agentId`（NOT NULL）、`modelId`（NOT NULL，R18，可改）、`thinkingLevel`（可空：空 = 跟随助手定义）、`createdAt`、`updatedAt`；索引 `(workspaceId, pinned DESC, createdAt DESC)` |
| `messages` | `id`（服务端分配，请求发出前就有）、`conversationId`（级联删）、`seq`（与对话内唯一）、`role`、`status`、`omit`、`content`(json)、`data`(json)、`searchText`、`parentToolCallId`（可空，R37）、`createdAt`、`updatedAt`；索引 `(conversationId, seq)`、`(parentToolCallId)` |
| `assets` | `id`、`name`、`path`、`mime`、`bytes`、`sha256`（`NOT NULL`、**`UNIQUE` = 全局去重**）、`width` / `height`（可空：本波不解码图片就是 `NULL`）、`createdAt`。**没有** `conversationId` / `messageId` 两列：归属在 `conversation_assets`，一张图可以被好几段对话引用 |
| `conversation_assets` | `conversationId`（级联删）、`messageId`（级联删）、`assetId`（**`ON DELETE RESTRICT`**：还有引用时物理删不掉）、`createdAt`；`UNIQUE (messageId, assetId)`，索引 `(assetId)`、`(conversationId)`。「几张会话引用了它」= `COUNT(DISTINCT conversationId)` |
| `asset_vendor_files` | `assetId`（指向 `assets`，级联删）、`endpointId`、`vendorFileId`、`createdAt`、`lastUsedAt`；`UNIQUE (assetId, endpointId)`，索引 `(lastUsedAt)`。**可失效的缓存**：删光能从 `assets` 重建 |
| `notices` | `id`、`level`、`code`、`params`(json)、`durationMs`（null = 永久）、`conversationId`（可空、级联删）、`createdAt`（L3：持久化，手动清或到点消失） |
| `questions` | `id`、`conversationId`（可空、级联删）、`kind`、`payload`(json)、`state`、`answer`(json)、`createdAt`、`updatedAt`、`answeredAt` |
| `credentials` | `id`、`note`、`hash`（唯一索引）、`createdAt`、`revokedAt` |
| `meta` | 单行表（`id` 固定 1）：`schemaVersion`、`createdAt` |

**素材的表分三层：真相、引用关系、缓存**：

| 表 | 是什么 | 谁写它 |
|---|---|---|
| `assets` | **资源的唯一真相**：一份字节 + 类型、大小、内容摘要、像素尺寸（未知为 `NULL`）。`sha256` 全库唯一，所以同一份字节在整台机器上只有一行、一份磁盘。消息里只记段上的 `__asset_id`，任何模型重放历史图都从这一份取（`asset.get`） | 上传落定（`AssetService.finalizeUpload`，走 `upsert`：同摘要撞上唯一约束时删掉刚写的文件、回既有行） |
| `conversation_assets` | **谁引用了它**：消息 × 素材的关系行。归属、「几张会话引用了它」（`COUNT(DISTINCT conversationId)`）与「还能不能删字节」都问这张表 | 消息落库那一刻（`ChatRunner` 的 `linkMessageAssets` → `AssetService.linkMessageAssets`，扫落库内容里的 `__asset_id`；同一 message+asset 只一行） |
| `asset_vendor_files` | **可失效的缓存**：这个素材在这个端点上对应厂商的哪个 `file_id`。`file_id` 是端点维度资源且会过期，所以命中就省一次上传、miss 就重传；一次请求因「file 不存在/无效」失败时按「这段对话 + 这个端点」整批作废（`ChatRunner` 随后重试一次） | `AssetService` 的 `upload` 注入点（查表 → 上传 → 写回，命中只 `touch` `lastUsedAt`） |

撤回 / 删对话 / 删项目都由外键把关系行级联删掉，没有谁去减计数。素材行与磁盘文件则在**消息清理完之后**按引用数判：`COUNT(*)` 为 0 才走 `AssetRepository.deleteIfUnreferenced`（`NOT EXISTS` 与 `ON DELETE RESTRICT` 是同一件事的两道写法）再删文件 —— 这一步落在 `AssetService.sweepUnreferenced`，由 `ConversationService.delete` / `revert` 与 `WorkspaceService.remove` 在删完之后调（它们只交出「受影响的素材 id」）。

厂商的 `file_id`、base64、绝对路径**都不进 `messages.content`**：那一列存的是段上的本地扩展字段 `__asset_id`（`image_url.url` / `file.file_id` 留空），发送前才按当时的模型/端点还原成内容段（`AssetService.resolveHistory`），并顺手按 core 的字段白名单重建一遍（`wire/states.ts` 的 `stripLocalExtensions`）—— `__` 开头的键一律不出网。于是「换模型 / 换端点 / 重启」都不需要改历史，只需要重算一次；同一个 `(素材, 端点)` 每轮算出来的段逐字节相同（`asset_vendor_files` 命中持久缓存、内联的 base64 由同一份字节得出）。

**消息条数的两个口径（读路径的事，不是两张表）**：同一个问题「这段对话有多少条消息」在库里有两个答案，因为两条读数问的不是同一样东西 —— `messages` 一张表里既有主线的消息，也有子 Agent 的消息（它们带非空的 `parentToolCallId`，R37）；另外 `hidden` 的消息（会话创建时的 cwd 消息、交接摘要）在两条读数里都不算。

| 读数（`src/storage/MessageRepository.ts`） | 数的是什么 | 谁在用 |
|---|---|---|
| `listByConversation` | 只数**主线**（`parentToolCallId IS NULL`），子 Agent 的消息不在结果里；`hidden` 的默认不返回（要就传 `includeHidden`） | 侧栏摘要 `ConversationSummary.messageCount`（`ConversationService.toSummary`）、`conversation.changed.messageCount`、`conversation.state` 的用量与上下文（`usage` / `context` 都从这份消息列表算）、`message.list` |
| `countByConversation` | 数 `messages` 表里这段对话的**全部行**，只筛 `hidden` 一列 | 删除代价 `consequences.messages`（`conversation.delete` 与 `workspace.remove` 的 `dryRun` 与非 `dryRun` 都用它） |

所以一段跑过子 Agent 的对话，「侧栏显示几条」会小于「删掉它会少多少行」，两个数不互相换算，也不互为校验：一处是读路径的主线视图，一处是删除的代价。`hidden` 的消息两边都不算（它在界面上从来没出现过）。两处代码（`MessageRepository` 与两个服务）各自有注释说明「这里是哪个数、为什么与另一处不同」。

**全文检索**：`messages_fts` 是挂在 `messages` 上的 FTS5 外部内容表，只索引 `searchText` 一列，`tokenize='trigram'`，用三个触发器（insert / delete / update of `searchText`）同步。两条实测约束落在实现里：(1) `unicode61` 下整段中文是一个 token，用错就搜不到；(2) `trigram` 的查询词至少 3 个字符，少于 3 个字符时 `MessageRepository.search` 走 `LIKE` 子串（D16 的「成本接受」就落在这）。

**边流边写**：运行时以内存里的消息为真相，同一条消息行按节流 upsert；装载/崩溃恢复复用 core 的 `reconcileAbortedToolRounds(fill)` + `reconcileAbortedMessages(keep)`，所以 `status` / `omit` 两列必须落盘（PRD D15）。

**迁移**：`meta.schemaVersion` + 顺序迁移脚本，启动时逐级在事务里跑（结构改动与版本号同一次提交）；不识别任何旧数据（L1）。R14/R18 等结构裁定直接落在 v1 的建表语句里，没有追加 v2（这套表结构还没随版本发出去，R32）。

**库之外的两份文件**：`config.json`（配置唯一真相，`ServerPaths.configFile`）与 `server.json`（服务端自己的设置：端口那一档，`ServerPaths.serverConfigFile`）；日志的落点由 `ServerPaths.logsDir` 给出，详见 §2。

## 6. 接线：一条 WS 上的 JSON-RPC

**首帧 `hello`**：`{ token, language?, clientInfo: { name, version, platform? } }`（`src/wire/methods.ts` 的 `ServerHelloParams`）。凭证不放在 URL 查询串里（会进日志与进程表）；未 `hello` 成功的连接只放行 `hello`，其余方法与二进制帧都回 `unauthorized`。`language` 挂在连接上，断开即忘；没带时用 `config.json` 的 `language`（缺省英文，裁定 R58）。`hello` 成功时一并回：协商出的 `language`、`serverVersion`、`protocolVersion`、`startedAt`、**能力 id 列表 `capabilities`（`string[]`，裁定 R57）**、附件上限 `limits`。完整的清单（标题、说明、属性）走 `server.capabilities`。

**方法名**：`<域>.<动作>`。契约里共 65 个方法（`src/wire/methods.ts` 的 `METHOD_NAMES`，14 个域）：

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
| `asset` | 3 | `begin` `end` `get` |
| `completion` | 1 | `files` |
| `handoff` | 2 | `start` `listDocuments` |
| `search` | 2 | `conversations` `messages` |

**桥接名单（4 条不在 handler 表里）**：`server.hello`、`server.setLanguage`、`asset.begin`、`asset.end` 由 `WsHub` 自己处理（`src/handlers/index.ts` 的 `BRIDGED_METHODS`），其余 60 条进注入的 `HandlerTable`。为什么是这四条：

- `server.hello` / `server.setLanguage`：凭证与语言都是**连接状态**（`ConnectionState.authorized` / `language`），业务层拿不到也不该管；
- `asset.begin` / `asset.end`：上传要按 `connectionId` 分帧落盘、断线按连接清理（`UploadReceiver`），同样只有接线层知道是哪条连接。

分发顺序是 `hello` → 未握手拒绝 → 已知方法名校验 → 上面两条连接级方法 → 注入 `UploadReceiver` 时的两个上传方法 → handler 表；表里没有的名字回 `unsupported`（`detail.reason = handler_not_registered`）。`handlers/index.test.ts` 钉住这件事：契约里的每个方法要么在表里、要么在桥接名单里，且两边不重叠。

**`message.list` 的取法（A12）**：入参 `conversationId`、`after?: <消息 id>`、`toolCallId?`、`includeHidden?`（默认 `false`：`hidden` 的消息不返回）。

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

**上传**：同一条 WS 上走三段式 —— `asset.begin`（JSON：`purpose` / `mime` / `bytes` / `conversationId` / `name?` / `sha256?`，返回 `uploadId` 或「已经有了」）→ 若干二进制帧 → `asset.end`（`uploadId` + `sha256`，服务端校验总长与摘要后落定成正式素材并回 `AssetRef`）。单张 20MB 上限（D5），超限在 `begin` 就拒；中途断开按 `begin` 记的临时文件清理（`UploadReceiver.abortConnection`）。

`begin` 带 `sha256` 时先问一次「库里是不是已经有这份字节」（`UploadReceiver` 注入的 `findExisting` → `AssetRepository.findByDigest`，还要求字节数一致）：命中就直接回 `{ deduped: true, uploadId: null, asset }` —— **不建临时文件、不分配 `uploadId`**，客户端跳过二进制帧与 `asset.end`。去重是全局的（按摘要，不分对话）：同一张图贴两次、或贴到两个对话，都只占一份磁盘、一次上行；两个对话各自在 `conversation_assets` 里留一行引用。没命中（或没带摘要）才照原路走；落定那一步用 `upsert`，两个并发上传撞在唯一约束上时后者删掉自己刚写的文件、回先到的那一行。`begin` 的「让归属的对话落库」排在看去重之前：去重命中并不证明这段对话存在，不存在的对话这一趟一个字节也不收。

**取回**：`asset.get { assetId, variant? }` 回 `{ asset, variant, data }`，`data` 是 base64 编码的内容。客户端按「段上有没有 `__asset_id`」决定要不要走这条路（`packages/client/src/asset.ts` 的 `localAssetIdOf` / `getSectionAsset`），不解析任何 url scheme。`thumb` 这一档目前**等同原图**（本波不引入原生图像库），回包里的 `variant` 说明实际给的是哪一档，客户端按 `asset.width` / `height`（未知为 `null`）自己缩。

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
| `conversation.changed` | `conversationId` + `workspaceId` + `change`（`created` / `renamed` / `pinned` / `messages_persisted` / `message_removed` / `settings_changed` / `deleted`）+ `messageCount`（`hidden` 的消息不算）+ `at` —— 让客户端知道「该去拉了」 |
| `notice` | `notice`（`NoticeView`：三档语气 `info`/`warning`/`error`、`duration` 秒或 null、`conversationId` 或 null、`text`）+ `at` |
| `question` | `question`（`QuestionView`：`id`、`kind`（`handoff`/`workspace_registration`/`confirmation`）、`prompt`、`options`、`state`、`answer`、`blocking`）+ `at`；多端看同一个（D22） |
| `usage` | `conversationId` + `usage`（`UsageSnapshot`：`turn` 本轮 / `total` 累计 / `subAgent` 累计里子 Agent 贡献的那部分 / `rate` 速率）+ `at` |

事件只描述「发生了什么变化」，需要完整对象时客户端回服务端拉（`conversation.state` / `message.list`），这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。

**能力清单（A13）**：`server.capabilities` 回完整清单、`hello` 只回 id 列表（裁定 R57），粒度是**每个契约方法一条**（65 条），每项带 `id`（PRD 能力号；同号多方法时为 `<编号>#<动作>`，如 `F-F2#deleteEndpoint`）、`domain`、`title` / `description`（`LocalizedText`，键为 `capability.<方法名>` / `capability.<方法名>.detail`）、`method`、`blocking`（执行期间占住这段对话，F-E6）、`destructive`（不可撤销，F-F9 的二次确认）。`workspace.*` 那几条在 PRD §4 没有单列能力号，`id` 用契约注释里记的决定号（`D9` / `D10` / `D11`）。清单与 `METHOD_NAMES` 一一对应（id 与顺序与语言无关），标题与说明按**连接的语言**渲染（裁定 R58：存码不存句子，出网前重渲染）；用例钉住这两条。

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
| 2026-11-12 | W6-C 补齐两条已知缺口：`DefaultSelection.language` 进契约（§9 那条出列）、状态栏助手块的名字与可用性由 `AgentService.describe` 现读（§9 那条出列）；§5 存储表下方补「消息条数的两个口径」（`listByConversation` 主线 / `countByConversation` 全部行，侧栏 vs 删除代价） |
| 2026-11-12 | W7-A：cwd 注入改成**会话创建时一条独立的 `hidden` 消息**（PRD F-D9 改口径），每轮不再往用户消息末尾拼注入段；§4 补「一段对话的诞生」与 `hidden` 的含义，§5 两个条数口径都改成不含 `hidden`，§6 `message.list` 加 `includeHidden?`，§7 `conversation.changed.messageCount` 注明不含 `hidden` |
| 2026-11-12 | W7-C：模型与思考档位改成**会话级、持久化**（PRD L7 / F-B4 / F-B6）：§5 `conversations` 加 `thinkingLevel`（可空）且 `modelId` 变成可改；§4 补「一段对话的模型与档位存在会话行上」与装配口径（档位名 → 参数补丁在 `ChatRunner.createSdkAgentFactory` 展开）；§3 删掉 `ConversationStateRegistry`（进程内临时覆盖作废），服务层要的运行时接口只剩 `isRunning` / `forget` |
| 2026-11-13 | W10：资源表与厂商关联表。`assets` 补 `sha256`（`NOT NULL`）+ `width`/`height`（可空）+ `UNIQUE(conversationId, sha256)`（对话内去重）；新增可失效缓存表 `asset_vendor_files`（`UNIQUE(assetId, endpointId)`、索引 `lastUsedAt`、级联删）。消息里持久化的只有 `asset://<assetId>`，发送前由 `AssetService.resolveHistory` 按当前模型还原；厂商 `file_id` 由 `upload` 注入点查表/写表（命中零上传），失效时按「这段对话 + 这个端点」作废并由 `ChatRunner` 重试一次。新增方法 `asset.get`（65 个方法；走 JSON + base64 回包，不进桥接名单）；§5 补两张表的分工，§6 补去重与取回。 |
| 2026-11-13 | W11：引用方式改成**内容段上的本地扩展字段 `__asset_id`**（不再往 `image_url.url` / `file.file_id` 里塞 `asset://`）。`assets` 去掉 `conversationId` / `messageId` 两列，`sha256` 改成全局 `UNIQUE`（去重从「对话内」改成「全局」）；新增关系表 `conversation_assets`（`UNIQUE(messageId, assetId)`、`assetId` 为 `ON DELETE RESTRICT`、索引 `assetId` / `conversationId`），消息落库那一刻扫 `content` 里的 `__asset_id` 写行，撤回 / 删对话由外键级联删行，删完之后 `COUNT(*)` 归零才删素材行与文件（`AssetService.sweepUnreferenced`）。「所有 `__` 开头的字段都是本地扩展、发送前一概剥离」落成 `wire/states.ts` 的两个纯函数 `stripLocalExtensions` / `localAssetIdOf`，`resolveHistory` 出的每一段都过白名单，且同一 `(素材, 端点)` 两轮算出来的段逐字节相同。客户端加 `localAssetIdOf` / `getSectionAsset`（按扩展字段取字节，不解析 scheme）。§5 补第三张表与「归零才删」的落点，§6 补全局去重与取回口径。 |
