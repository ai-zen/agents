# 宿主架构

> **本文边界**：PRD 说「要为用户做到什么」，本文说「这些事怎么搭起来」。
> 本文没写的，按 PRD 办；两者冲突，以 PRD 为准，并回头改本文。
>
> 骨架参照 `ai-zen/desktop` 分离前那份本地实现（分支 `ref/pre-separation`，提交 `5498691`，13 个文件 1,524 行），**不从 `packages/host/bad-src` 继承任何东西**。

- 状态：已按实现复核（W5-B：逐节对照 `packages/host/src/**` 回改；描述的是现在的代码，不是打算）
- 归属：`packages/host`，按推倒重写处理

---

## 1. 已定的架构决定

| # | 定论 | 出处 |
|---|---|---|
| A1 | 一个宿主进程装所有对话；对话之间不做进程隔离 | 本轮 Q1 |
| A2 | 一个监听器、一条 WebSocket，RPC / 推送 / 二进制上传都走它 | 本轮 Q2 |
| A3 | 契约归宿主自己（不独立成包、不叫「约定」），客户端照着用 | 本轮 Q3 |
| A4 | JSON-RPC 2.0 为底，产品形状长在 `params` / `result`；标准里对我们有负担的部分（批量请求、强制错误码空间、通知必须无 id）不用 | 本轮 Q6 |
| A5 | 所有连接都要凭证；本地无感靠「创建时凭证已自动填好」，不靠回环豁免 | 本轮 Q7 / Q8 |
| A6 | 本地实例只监听回环；对外由创建者起、自己配凭证并分发 | 本轮 Q7 |
| A7 | `node:sqlite` + worker 线程 + WAL；全文检索用 FTS5 `trigram` | 本轮 Q4 |
| A8 | 分层照桌面端：单根 + 薄 service + 一层仓储，按需扩展，不预摆空层 | 本轮 Q5 |
| A9 | agent 跑完即弃；Scope 无依赖后空闲 10 分钟回收（与 MCP 同生共死） | PRD D28 |
| A10 | Scope 与对话的回收计时器**只有一处**（见 §4） | 本文 |
| A11 | 上传走同一条 WS 上的**二进制帧**（三段式），不用 base64 字符串 | 本轮 Q9 |
| A12 | `message.list` 有**两种按 id 的取法**：① `after=<id>` —— 该 id **存在**就返回它**最新的内容**及之后全部；该 id **不存在**就返回全部（断线补拉与删除后重拉共用这一条规则）。② `around=<id>`（F-C6 定位）—— 该 id 在本次可见集里就**以它为中心取一窗**（40 条，前后尽量均分，命中那条一定在里面）且 `anchor` 报成它；**不在**可见集里（已撤回 / 换过库 / 是 `hidden` 而这次没要）就回**空页 + `anchor: null`**，**不报错**（消息可能刚被撤回，那不是一次失败的请求）。两者同时给时 `around` 优先、`after` 被忽略；`toolCallId` 决定读哪一段（子 Agent 自己那一段），两个定位参数都只在那一堆里生效 | 本轮 Q10 + W1-8 |
| A13 | ~~能力清单的粒度是「契约里每个方法一条」~~ **已废（2026-11-14）**：`host.capabilities`、`hello.capabilities`、`handlers/capabilities.ts` 与 `CapabilityView` 都删了 —— 两端一个消费者都没有；清单里剩下的 `blocking` / `destructive` 也没人读（阻塞判断在客户端命令表，二次确认在各端的确认框） | — |

## 2. 进程与接线

**启动方式决定监听范围**，不是运行时判断：

| 启动方式 | 监听 | 凭证 |
|---|---|---|
| 被本地客户端拉起（本地实例，`local: true`） | 只监听回环（`127.0.0.1`） | 宿主首次启动时生成，客户端自动取 |
| 创建者手动起、要给别人连（对外实例，`--public`） | 监听创建者指定的地址（缺省 `0.0.0.0`） | 创建者在自己的入口里创建凭证（带备注），手动分发给对方 |

端口按 PRD D25，优先级是启动参数 > 配置文件 > 默认端口 8790，落点是 `src/config.ts` 的 `resolveListenTarget`。两种边界情形按代码现在的样子记着：

- 端口给 `0` 表示由系统分配（`--port 0`，`app.ts` 的 `resolveTarget` 对它单独放行）；用例与冒烟都用这个写法。
- **显式给出但不合法的端口报 `config_invalid`，不静默回落**（裁定 R67）：非整数、越界都拒；`0` 只认启动参数那一档（“让系统分配”这件事在配置文件里说不清）。只有完全没给才落到下一顺位。端口被占用时 `WsHub.listen` 把错误抛给启动流程，进程以失败退出 —— 自动改监听端口的路径没有实现，要换端口就显式写 `--port 0`。

**配置文件那一档的真实来源是 `<数据根>/host.json`**（形状 `{ "port": 8790 }`，见 `src/config.ts` 的 `readHostSettings`）：文件不在或没写 `port` 就算“这一档没说话”；写坏了（不是 JSON 对象）或端口不合法按 `config_invalid` 拒绝。`cli.ts` 的 `serve` 与 `HostApp.create()` 都读它 —— 前者读了随 `configPort` 传下去，后者在不给 `configPort` 且启动参数没给端口时自己读。

**单实例靠发现文件**：`<数据根>/run/host.json` 是「这台机器上谁在服务」的唯一真相（`pid`、`host`、`port`、`version`、`local`、`startedAt`，见 `src/net/discovery.ts` 的 `HostFileInfo`）。启动时 `HostApp.detectRunningInstance` 读它：pid 活着就挂靠那个地址、不重复监听；pid 已死或文件坏了就清掉再起。客户端探活也读它。

**凭证交付**：凭证自身一份真相在库里（可列出、带备注、可单独吊销）；`<数据根>/run/token` 只是个交付口，内容只有「本地那串」，本地实例启动时由 `createLocalCredential` 生成、由 `writeLocalToken` 写入。对外实例不写这个文件，只提示用 `token create` 自己建再分发。交付文件的权限是**尽力而为**地设成 `0600`（POSIX 上挡住同机其他用户；**Windows 上 `mode` / `chmod` 不改变 ACL**，那里的保护来自用户目录本身）—— 文档和文案都不把它当安全保证。

**升级**（PRD D4）：`host.upgrade` 比磁盘上的版本（`readDiskVersion` 读本包 `package.json`）与运行版本，确认新版本真的落盘了才安排一次收尾，进程退出后由启动方式重新拉起；宿主不自己装包，也不 `exec` 回自己。**启动后还有一道低频自检**（裁定 R66 / `app.ts` 的 `checkDiskVersion`）：每 30 秒（`unref()` 的定时器，`stop()` 里清掉）比一次磁盘版本，磁盘上的那个更新就推一条 `notice.upgradeRestarting` 再走同一条收尾；回退不算升级，不重启。

**数据根**（`AI_ZEN_DIR`，缺省 `~/.ai-zen`，可被环境变量改）。`HostPaths`（`src/config.ts`）给出数据根与它下面的库、附件、运行期目录、发现文件、凭证文件、两份配置文件与日志目录；`config.json` 交给 SDK 的 `ConfigManager`（`HostPaths.configFile`），`host.json` 是宿主自己的设置（`HostPaths.hostConfigFile`）；`agents/ sub-agents/ skills/ tools/ mcp-oauth/` 与 `mcp.json`、`reasoning-presets.json` 由 SDK 的 `ConfigManager` 在其 `basePath`（= 数据根）下推导与释放：

```
<数据根>/
├── ai-zen.db              # 全机一个库（HostPaths.dbFile）
├── assets/                # 上传临时文件与正式素材（HostPaths.assetsDir）
├── config.json            # 配置唯一真相（HostPaths.configFile；ConfigManager 以它为边界）
├── host.json            # 宿主自己的设置：端口那一档（HostPaths.hostConfigFile）
├── logs/                  # 宿主日志（HostPaths.logsDir；host.log + 轮转出的 .1…）
├── reasoning-presets.json # 思考策略表（ConfigManager）
├── mcp.json               # 用户级 MCP 配置（ConfigManager）
├── agents/                # 助手定义（一实体一文件）
├── sub-agents/            # 子 Agent 定义
├── skills/                # 出厂与用户 Skill
├── tools/                 # 用户工具
├── mcp-oauth/             # MCP 的 OAuth 凭据
└── run/
    ├── host.json        # 发现文件（HostPaths.hostFile）
    └── token              # 本地凭证交付文件（HostPaths.tokenFile）
```

## 3. 对象图

**单根 + 构造函数显式注入**，同桌面端 `DesktopApp`：不用模块级单例、不用反射扫描。依赖从根出发，跨服务协作（删对话 → 释放运行中的轮次）用显式钩子声明，不靠事件总线兜。

```
HostApp（根：组装、启动、退出）
├─ 基础设施
│  ├─ ConfigManager        (SDK)  ← 配置唯一入口（basePath = 数据根）
│  ├─ Database             SQLite worker（all / get / run / tx / close）
│  ├─ *Repository          只做 SQL，不含业务（一表一文件）
│  ├─ i18n                 render / normalizeLanguage（en 基准、zh；未知语言回落 en）
│  └─ Logger               日志落 `logs/host.log`（按大小轮转）、warn / error 同时上通知
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

目录（`packages/host/src/`）：

```
app.ts        单根：组装、启动、退出
cli.ts        命令行：serve / token / version
config.ts     路径与端口来源
index.ts      包出口（wire 类型 + createHost）
wire/         契约：methods（方法表）、frames（帧）、errors（业务码）、events（事件）、states（状态形状）
net/          WsHub、auth、discovery、UploadReceiver
handlers/     方法实现（一域一文件）+ capabilities（能力清单）+ index（HandlerTable 与桥接名单）
services/     薄服务 + Logger（日志文件与轮转）
runtime/      ScopeRegistry、RunRegistry、ChatRunner、TransientRunner
storage/      Database、dbWorker、Repository、migrations
i18n/         文案（en 基准 / zh）
```

**视图与入参的几处形状（这一轮补齐的；每条都写「谁产生 → 客户端拿它做什么」）**

| 形状 | 谁产生 | 客户端拿它做什么 |
|---|---|---|
| `AgentView.messages` / `AgentView.function` | `AgentService.toView`，原样转出 SDK 的 `AgentDefinition["messages"]` / `["function"]`；定义文件读不出来时两者都是 `null`，非子 Agent 的 `function` 恒为 `null` | 「能写就能读」：客户端先看得到提示词与子 Agent 定义，才有可编辑的对象（F-F5）；`agent.update` 收到的 `messages` 原样交回等于没改 |
| `DiscoveryEntryView` 的传输字段（`transport` / `command` / `args` / `env` / `url` / `headers`）与 `extra` | `DiscoveryService.discover`：MCP 条目把「这条服务器是怎么起的」整份摊开；`extra` 收留这一版不认识的键 | 编辑屏不必凭 `id` 重建一条就能改它；回写时 `extra` 逐字带回（F-F6 未知字段原样保留）。非 MCP 的三类这几格恒为 `null` / 空对象 |
| `DiscoveryLayerView.scope`（`user` / `workspace` / `null`） | 同上：MCP 5 层里只有 2 层非空 | 客户端直接认「哪一层可写」，不再按 `editable` + `depth` 反推；skill / tool / subagent 三类恒 `null` |
| `McpOauthView` 的掩码口径（`clientSecret` → `clientSecretMasked` + `clientSecretSet`） | `DiscoveryService`，掩码由 `services/secretMask.ts` 的 `maskSecret` 生成 | 与 `EndpointView` 的 `apiKeyMasked` / `apiKeySet` 同一套（F-F2：明文不出网）；回写时省略 `clientSecret` = 保留磁盘原值（把掩码当密钥存回去是另一类错） |
| `ModelInput.tokenThresholds` 可选 | `ModelService`：`model.create` 省略时套出厂默认，`model.update` 省略时不动 | 客户端建模型不必自己抄两个数 —— 「没有阈值」既不会触发交接也没有硬线保护，所以默认值的持有者必须是宿主 |

## 4. 生命周期

**一轮对话**：

```
请求到达 → RunRegistry.start（该对话已在跑则抛 HostError("busy")，PRD D14）
        → 借 Scope（ScopeRegistry.acquire：懒创建或复用，依赖 +1）
        → 装配 agent（模型/助手/权限来自 SDK，跑完即弃）
        → 流式：增量推事件；同一条消息边流边写
        → 内循环结束：写一次（D15）→ agent 释放 → ScopeRegistry.release（依赖 −1，归零则起 10 分钟计时）
```

**一段对话的模型与思考档位存在会话行上**（`conversations.modelId` / `conversations.thinkingLevel`，PRD L7 / F-B4 / F-B6）：改了就落库，重开重连、重启都还是它。装配 agent 时从这里取：`modelId` 直接给 SDK 的三级解析（会话级那一档），`thinkingLevel` 按该模型引用的思考策略表展开成参数补丁、叠在助手定义的 `modelParams` 之上（同一模型才叠：会话把模型换掉之后，定义上那份参数是给旧模型的）。展开发生在 `ChatRunner.createSdkAgentFactory`（`conversationModelParams`），档位名本身不进请求。换模型时档位被清空（它是模型的档位）。服务层要的运行时接口因此只剩两件事：忙不忙（`RunRegistry.isRunning`）与删掉之后的中止（`ChatRunner.forget`）。

**一段对话的诞生（R56）**：`conversation.create` 只定身份（`workspaceId` / `agentId` / `modelId`）并发一个 id，不写库；首次 `conversation.send` 时 `ConversationService.ensurePersisted` 才把这一行写进 `conversations`。**落行那一刻同时写这段对话的第一条消息**：一条 `role: user`、`hidden: true` 的消息，正文告诉模型这段对话对应的 cwd（PRD F-D9，正文由 `injectedContextOf` 拼）。它最先写，所以 `seq` 在真实用户消息之前；之后每一轮都不再写、也不再往用户消息里拼任何东西。cwd 取这段对话所属 `workspaces.cwd`（不读进程工作目录），`workspaceId` 创建即定死，没有任何方法能改它。

**`hidden` 的含义就是「这条不给人看」**（core `AgentNS.Message.hidden`）：它仍参与模型上下文（`ChatRunner.reconcile` 取历史时显式带上），但 `message.list` 默认不返回、侧栏条数与删除代价都不数它；客户端按这个字段决定不展示。临时对话（`TransientRunner`）不落库，同一条 cwd 消息只拼在内存的发送内容里（`agent.append` 一条 `hidden` 消息）。

**计时器只有一处**：`ScopeRegistry` 持有唯一那份空闲计时。L4 说的「10 分钟无活动」和 D28 说的「Scope 空闲 10 分钟」，是同一个计时器的两个说法，不各写一份。全部 Scope 都回收完时它回调 `onAllRecycled(cb)`（`src/runtime/ScopeRegistry.ts`），单根据此重算退出判据。

**进程退出**：判据是「连接数 0、已经握过手（`served`）、没有在跑的轮次、`ScopeRegistry.size()` 为 0」。触发源有四个，都不另起计时器：`ScopeRegistry.onAllRecycled`、每轮结算（`onTurnSettled`）、`WsHub.onConnectionsChanged`、`host.shutdown`。进程退出连带断开所有 MCP 连接，这是已知代价（MCP 服务器自己拉起的外部进程可能随之结束，取决于那个 MCP server 的实现）。

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
| `messages` | `id`（宿主分配，请求发出前就有）、`conversationId`（级联删）、`seq`（与对话内唯一）、`role`、`status`、`omit`、`content`(json)、`data`(json)、`searchText`、`parentToolCallId`（可空，R37）、`createdAt`、`updatedAt`；索引 `(conversationId, seq)`、`(parentToolCallId)` |
| `assets` | `id`、`name`、`path`、`mime`、`bytes`、`sha256`（`NOT NULL`、**`UNIQUE` = 全局去重**）、`width` / `height`（可空：落定时按 PNG（IHDR）/ JPEG（SOF 段）的文件头解出，量不到为 `NULL`）、`createdAt`。**没有** `conversationId` / `messageId` 两列：归属在 `conversation_assets`，一张图可以被好几段对话引用 |
| `conversation_assets` | `conversationId`（级联删）、`messageId`（级联删）、`assetId`（**`ON DELETE RESTRICT`**：还有引用时物理删不掉）、`createdAt`；`UNIQUE (messageId, assetId)`，索引 `(assetId)`、`(conversationId)`。「几张会话引用了它」= `COUNT(DISTINCT conversationId)` |
| `asset_vendor_files` | `assetId`（指向 `assets`，级联删）、`endpointId`、`vendorFileId`、`createdAt`；`UNIQUE (assetId, endpointId)`。**缓存**：删光能从 `assets` 重建 |
| `notices` | `id`、`level`、`code`、`params`(json)、`durationMs`（null = 永久）、`conversationId`（可空、级联删）、`createdAt`（L3：持久化，手动清或到点消失） |
| `questions` | `id`、`conversationId`（可空、级联删）、`kind`、`payload`(json)、`state`、`answer`(json)、`createdAt`、`updatedAt`、`answeredAt` |
| `credentials` | `id`、`note`、`hash`（唯一索引）、`createdAt`、`revokedAt` |
| `meta` | 单行表（`id` 固定 1）：`schemaVersion`、`createdAt` |

**素材的表分三层：真相、引用关系、缓存**：

| 表 | 是什么 | 谁写它 |
|---|---|---|
| `assets` | **资源的唯一真相**：一份字节 + 类型、大小、内容摘要、像素尺寸（未知为 `NULL`）。`sha256` 全库唯一，所以同一份字节在整台机器上只有一行、一份磁盘。消息里只记段上的 `__asset_id`，任何模型重放历史图都从这一份取（`asset.get`） | 上传落定（`AssetService.finalizeUpload`，走 `upsert`：同摘要撞上唯一约束时删掉刚写的文件、回既有行） |
| `conversation_assets` | **谁引用了它**：消息 × 素材的关系行。归属、「几张会话引用了它」（`COUNT(DISTINCT conversationId)`）与「还能不能删字节」都问这张表 | 消息落库那一刻（`ChatRunner` 的 `linkMessageAssets` → `AssetService.linkMessageAssets`，扫落库内容里的 `__asset_id`；同一 message+asset 只一行） |
| `asset_vendor_files` | **缓存**：这个素材在这个端点上对应厂商的哪个 `file_id`。三条规则 —— 这个端点上有缓存行就直接用那个 `file_id`；这个端点上没有、别的端点上有（换厂商 / 换端点）就内联 base64，不往新端点重传；哪个端点上都没有才上传一次并写回。发送失败就报失败，不自动重试、不判失效、不做过期清理 | `AssetService` 的 `upload` 注入点（查表 → 上传 → 写回）与 `vendorEndpoint`（换端点时把端点换成 `null`，SDK 因此走内联） |

撤回 / 删对话 / 删项目都由外键把关系行级联删掉，没有谁去减计数。素材行与磁盘文件则在**消息清理完之后**按引用数判：`COUNT(*)` 为 0 才走 `AssetRepository.deleteIfUnreferenced`（`NOT EXISTS` 与 `ON DELETE RESTRICT` 是同一件事的两道写法）再删文件 —— 这一步落在 `AssetService.sweepUnreferenced`，由 `ConversationService.delete` / `revert` 与 `WorkspaceService.remove` 在删完之后调（它们只交出「受影响的素材 id」）。

厂商的 `file_id`、base64、绝对路径**都不进 `messages.content`**：那一列存的是段上的本地扩展字段 `__asset_id`（`image_url.url` / `file.file_id` 留空），发送前才按当时的模型/端点还原成内容段（`AssetService.resolveHistory`），并顺手过一遍 core 的 `formatContent`（按 core 的类型取字段重建）—— `__` 开头的键因此不出网。宿主自己不再留一份字段清单（`wire/states.ts` 只剩认 `__asset_id` 的 `localAssetIdOf`）。于是「换模型 / 换端点 / 重启」都不需要改历史，只需要重算一次；同一个 `(素材, 端点)` 每轮算出来的段逐字节相同（`asset_vendor_files` 命中持久缓存、内联的 base64 由同一份字节得出）。

**消息条数的两个口径（读路径的事，不是两张表）**：同一个问题「这段对话有多少条消息」在库里有两个答案，因为两条读数问的不是同一样东西 —— `messages` 一张表里既有主线的消息，也有子 Agent 的消息（它们带非空的 `parentToolCallId`，R37）；另外 `hidden` 的消息（会话创建时的 cwd 消息、交接摘要）在两条读数里都不算。

| 读数（`src/storage/MessageRepository.ts`） | 数的是什么 | 谁在用 |
|---|---|---|
| `listByConversation` | 只数**主线**（`parentToolCallId IS NULL`），子 Agent 的消息不在结果里；`hidden` 的默认不返回（要就传 `includeHidden`） | 侧栏摘要 `ConversationSummary.messageCount`（`ConversationService.toSummary`）、`conversation.changed.messageCount`、`conversation.state` 的用量与上下文（`usage` / `context` 都从这份消息列表算）、`message.list` |
| `countByConversation` | 数 `messages` 表里这段对话的**全部行**，只筛 `hidden` 一列 | 删除代价 `consequences.messages`（`conversation.delete` 与 `workspace.remove` 的 `dryRun` 与非 `dryRun` 都用它） |

所以一段跑过子 Agent 的对话，「侧栏显示几条」会小于「删掉它会少多少行」，两个数不互相换算，也不互为校验：一处是读路径的主线视图，一处是删除的代价。`hidden` 的消息两边都不算（它在界面上从来没出现过）。两处代码（`MessageRepository` 与两个服务）各自有注释说明「这里是哪个数、为什么与另一处不同」。

**全文检索**：`messages_fts` 是挂在 `messages` 上的 FTS5 外部内容表，只索引 `searchText` 一列，`tokenize='trigram'`，用三个触发器（insert / delete / update of `searchText`）同步。两条实测约束落在实现里：(1) `unicode61` 下整段中文是一个 token，用错就搜不到；(2) `trigram` 的查询词至少 3 个字符，少于 3 个字符时 `MessageRepository.search` 走 `LIKE` 子串（D16 的「成本接受」就落在这）。

**边流边写**：运行时以内存里的消息为真相，同一条消息行按节流 upsert；装载/崩溃恢复复用 core 的 `reconcileAbortedToolRounds(fill)` + `reconcileAbortedMessages(keep)`，所以 `status` / `omit` 两列必须落盘（PRD D15）。

**迁移**：`meta.schemaVersion` + 顺序迁移脚本，启动时逐级在事务里跑（结构改动与版本号同一次提交）；不识别任何旧数据（L1）。R14/R18 等结构裁定直接落在 v1 的建表语句里，没有追加 v2（这套表结构还没随版本发出去，R32）。

**库之外的两份文件**：`config.json`（配置唯一真相，`HostPaths.configFile`）与 `host.json`（宿主自己的设置：端口那一档，`HostPaths.hostConfigFile`）；日志的落点由 `HostPaths.logsDir` 给出，详见 §2。

## 6. 接线：一条 WS 上的 JSON-RPC

**首帧 `hello`**：`{ token, language?, clientInfo: { name, version, platform? } }`（`src/wire/methods.ts` 的 `HostHelloParams`）。凭证不放在 URL 查询串里（会进日志与进程表）；未 `hello` 成功的连接只放行 `hello`，其余方法与二进制帧都回 `unauthorized`。`language` 挂在连接上，断开即忘；没带时用 `config.json` 的 `language`（缺省英文，裁定 R58）。`hello` 成功时一并回：协商出的 `language`、`hostVersion`、`protocolVersion`、`startedAt`、**能力 id 列表 `capabilities`（`string[]`，裁定 R57）**、附件上限 `limits`。~~完整的清单走 `host.capabilities`~~（2026-11-14 起这个方法与 `hello` 里的 `capabilities` 都已删除，没有消费者）。

**方法名**：`<域>.<动作>`。契约里共 **62** 个方法（`src/wire/methods.ts` 的 `METHOD_NAMES`，13 个域；2026-11-14 删掉 `host.capabilities` 后 63 → 62）：

| 域 | 个数 | 方法 |
|---|---|---|
| `host` | 6 | `hello` `version` `upgrade` `shutdown` `reload` `setLanguage` |
| `workspace` | 5 | `list` `create` `get` `rename` `remove` |
| `conversation` | 13 | `list` `create` `get` `state` `rename` `pin` `delete` `send` `abort` `revert` `setModel` `setThinking` `transient` |
| `message` | 1 | `list` |
| `question` | 2 | `list` `answer` |
| `notice` | 3 | `list` `dismiss` `clear` |
| `config` | 8 | `get` `patch` `setDefaults` `getDiscovery` `saveMcp` `deleteMcp` `saveEndpoint` `deleteEndpoint` |
| `agent` | 8 | `list` `get` `create` `update` `delete` `setModel` `setThinking` `restoreFactory` |
| `model` | 8 | `list` `listImages` `create` `update` `delete` `restoreFactory` `saveImage` `deleteImage` |
| `asset` | 3 | `begin` `end` `get` |
| `completion` | 1 | `files` |
| `handoff` | 2 | `start` `listDocuments` |
| `search` | 2 | `conversations` `messages` |

**65 → 63 的账：新增 3 个方法、删 5 个方法。** 每一行都写「它为什么落在契约面上」：

| 变化 | 理由 |
|---|---|
| + `agent.restoreFactory { agentId, dryRun? }` | 与 `model.restoreFactory` 对称：改过的助手要能回到出厂那份（提示词 / 模型 / 权限 / 思考参数一起回），`dryRun` 只算代价、不落盘（与删除类方法的成本先行同一套写法） |
| + `config.saveMcp` / `config.deleteMcp`（**取代** `config.patchMcps` 的整层替换） | 整层替换要求客户端「先读整层、再拼回去」，中间有一处不认识就丢配置；按 id 改只动这一条，形状与 `config.saveEndpoint` / `deleteEndpoint` 同一套写法 |
| − `host.usage` | 它想要的三样（本轮 / 累计含子 Agent / 速率）`conversation.state.usage` 已经全覆盖；「项目 / 整机」聚合没有任何客户端需要 |
| − `credential.list` / `credential.create` / `credential.revoke` | **删的是契约面，不是能力**（见下段） |

**`credential.*` 的「删了但没有消失」必须分清**：凭证这件事仍然完整地在宿主里 —— 服务层 `CredentialService`、仓储 `CredentialRepository`、`<数据根>/run/token` 的本地交付、以及 `agents-host token create|list|revoke` 三个子命令全都没动（`CredentialView` / `CredentialListResult` / `CredentialCreateResult` 等形状也留着，供那三个子命令的返回值用，只是不再进 `MethodMap` / `METHOD_NAMES`）。删掉的是「客户端能通过契约列出 / 创建 / 吊销凭证」这条通道：客户端的职责只有「连接管理 + 记住密码」（PRD L13），而凭证由宿主自己管、自己决定哪些能进来。两者不是一回事，下一个人不该因为 `grep credential.*` 在 `wire/methods.ts` 里找不到方法名就以为能力没了。

**桥接名单（4 条不在 handler 表里）**：`host.hello`、`host.setLanguage`、`asset.begin`、`asset.end` 由 `WsHub` 自己处理（`src/handlers/index.ts` 的 `BRIDGED_METHODS`），其余 **59** 条进注入的 `HandlerTable`。为什么是这四条：

- `host.hello` / `host.setLanguage`：凭证与语言都是**连接状态**（`ConnectionState.authorized` / `language`），业务层拿不到也不该管；
- `asset.begin` / `asset.end`：上传要按 `connectionId` 分帧落盘、断线按连接清理（`UploadReceiver`），同样只有接线层知道是哪条连接。

分发顺序是 `hello` → 未握手拒绝 → 已知方法名校验 → 上面两条连接级方法 → 注入 `UploadReceiver` 时的两个上传方法 → handler 表；表里没有的名字回 `unsupported`（`detail.reason = handler_not_registered`）。`handlers/index.test.ts` 钉住这件事：契约里的每个方法要么在表里、要么在桥接名单里，且两边不重叠。

**`message.list` 的取法（A12）**：入参 `conversationId`、`after?: <消息 id>`、`around?: <消息 id>`、`toolCallId?`、`includeHidden?`（默认 `false`：`hidden` 的消息不返回）。

| 入参 | 返回 |
|---|---|
| 都不给 | 该对话全部消息 |
| `after` 给了且该 id 存在 | **从这条消息开始**（含它本身，内容是**最新**的，可能是流式中那条的部分内容 + 还在写的标记，L5）+ 其后全部；出参的 `anchor` 就是这条 id |
| `after` 给了但该 id 不存在（已删除、或库已换） | 全部，`anchor` 为空 |
| `around` 给了且该 id 在本次可见集里 | 以它为中心一窗（`MessageService` 的 `AROUND_WINDOW` = **40** 条，前后尽量均分、命中那条一定在里面），`anchor` 就是这条 id |
| `around` 给了但该 id 不在可见集里（已撤回 / 换过库 / 是 `hidden` 而这次没要） | **空页**（`messages: []`、`anchor: null`），**不报错** |
| `around` 与 `after` 同时给 | 只认 `around`（`after` 被忽略）：一个「从这里往下」、一个「围绕这里」，混在一起没有唯一答案 |

“从这条开始而不是它的下一条”是故意的：重连的客户端上次拿到的最后一条可能是流式中那条，它的内容已经变了；从它自己重新拿，天然就是“最新内容 + 之后的”。`toolCallId` 是在这条结果集上再按消息自己的 `tool_call_id` 过滤一次（F-I7 的取法，见 §9 的已知缺口）；`around` 只在那一堆里定位，不改“读哪一段”。

**`around` 的消费者只有桌面端**：`search.messages` 给一条命中，桌面端拿它的 `messageId` 调 `message.list({ around })` 把命中那条摆到眼前（W4 的搜索定位）。CLI 不消费它 —— 一阶段不做搜索。

**推送**：JSON-RPC 通知（无 id）。事件名放在帧的 `method`，载荷直接放 `params` —— 形状由 `src/wire/frames.ts` 的 `notification(event, payload)` 定：

```json
{ "jsonrpc": "2.0", "method": "run.state", "params": { "conversationId": "...", "run": {}, "at": "..." } }
```

不重放、不需要 ack —— 断线即作废，重连按 D5 自己拉状态与消息。受理即返回的方法（`conversation.send` 这类）会产生「事件早于回包」的顺序问题：`WsHub` 按请求参数里的 `conversationId` 先挂起该对话的推送，回包写完再按序放行（裁定 R47）。事件里的 `LocalizedText` 在产生现场按默认语言渲染一份，出网前由注入的 `localizeEvent`（`NoticeService.createEventLocalizer`）按**这条连接的语言**重渲染（D8）。

**错误**：JSON-RPC `error` 对象；`data.code` 是稳定业务码（13 个，`src/wire/errors.ts` 的 `BizCode`：`unauthorized` / `invalid_params` / `not_found` / `busy` / `payload_too_large` / `unsupported` / `internal` / `config_invalid` / `mcp_unavailable` / `model_unsupported` / `handoff_declined` / `question_pending` / `context_guard`），数字码只做粗分类（`jsonRpcCode` 映射）；`data.message` 是按连接语言渲染好的人话（宿主出文案，D8）；结构性事实（哪个字段不对、还差什么）放 `data.detail`，不让客户端解析句子。批量请求（帧是数组）回 `unsupported`（`detail.reason = batch_not_supported`，R11）。

**推送（含通知）入库存的是「码 + 参数」，不是渲染好的句子**：多语言在读出时按该连接的语言渲染（D8），否则一条通知存死一种语言，换个语言连回来就错了。`notices` 表存 `code` + `params`，`hello` / 出网时才渲染成 `NoticeView.text`。

**上传**：同一条 WS 上走三段式 —— `asset.begin`（JSON：`purpose` / `mime` / `bytes` / `conversationId` / `name?` / `sha256?`，返回 `uploadId` 或「已经有了」）→ 若干二进制帧 → `asset.end`（`uploadId` + `sha256`，宿主校验总长与摘要后落定成正式素材并回 `AssetRef`）。单张 20MB 上限（D5），超限在 `begin` 就拒；中途断开按 `begin` 记的临时文件清理（`UploadReceiver.abortConnection`）。

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
| `question` | `question`（`QuestionView`：`id`、`kind`（`handoff`/`confirmation`）、`prompt`、`options`、`state`、`answer`、`blocking`）+ `at`；多端看同一个（D22） |
| `usage` | `conversationId` + `usage`（`UsageSnapshot`：`turn` 本轮 / `total` 累计 / `subAgent` 累计里子 Agent 贡献的那部分 / `rate` 速率）+ `at` |

事件只描述「发生了什么变化」，需要完整对象时客户端回宿主拉（`conversation.state` / `message.list`），这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。

**能力清单已删（2026-11-14）**：`host.capabilities`、`hello.capabilities`、`handlers/capabilities.ts`（63 条 FACTS）、`CapabilityView` 与那 252 条 `capability.*` 文案一起从契约面删除（方法表 63 → 62）。原因：两端**一个消费者都没有** —— CLI 的 `/help` 改成用自己的命令表（PRD F-E5 订正），桌面端从握手回执里就把这个字段丢掉；清单里剩下的 `blocking` / `destructive` 同样没人读（「这一轮会占住对话」由客户端命令表的 `blocksInput` 决定，「不可撤销」由各端的确认框自己问）。要恢复时按 F-E6 重新设计：**属性归宿主、界面归客户端**，别再把两句界面文案塞进契约。

## 8. 与 core / SDK 的边界

| 归谁 | 内容 |
|---|---|
| `@ai-zen/agents-core` | `Agent`、流式 `applyChunk`、消息与工具调用结构（`AgentNS.Message` / `MessageContent` / `ToolCall` / `Delta` / `Usage`）、中止修复（`reconcileAbortedToolRounds` / `reconcileAbortedMessages`） |
| `@ai-zen/agents-sdk` | `Scope`（能力装配）、`allInOne` 五类插件（内置工具 / 用户工具 / Skill / MCP / 子 Agent）、`ConfigManager`、`createAgent` / `SdkAgent`、`HandoffService`、各插件的 `discover*`、出厂 Skill 与思考策略表、`fileToContentSection` |
| `@ai-zen/agents-client`（共享连接层） | 「确保有一个能连的宿主」：`ensureHost`（有就上、没有就拉一个）、`spawnHostViaNpx`（现下现起）、`Client`（连接 / 调用 / 事件分派 / 补拉 / 重连）、`settings`、`resume`、`upload`。它不知道自己被谁用，也不画任何界面 |
| 宿主 | 进程与接线、凭证、Workspace 与对话的生命周期、Scope 的持有与回收、持久化、i18n 文案、通知与问题对象、上传 |

原则：**agent 循环不重写**，宿主只做「装配 + 持久化 + 接线」。

**共享连接层（`packages/client`）这一轮定的三件事，在它而不是在两端**（同一个包里两份实现就不是“共享”了）：

| 职责 | 做到哪一步为止 |
|---|---|
| **npx 拉起**（`spawnHostViaNpx`） | 判据只有一句 `context.entry === undefined`：调用方给了宿主入口（桌面端把宿主捆进产物随包分发）就起那个入口，没给就让 npx 现下现起（`npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`）。两条路之后是同一段「轮询发现文件 + 握手」，包里没有第二套语义 |
| **阶段回调**（`onStage`） | 报 `resolving`（让 npx 解版本）/ `installing`（下载 + 安装，两步分不开）/ `starting`（子进程起来了、等发现文件与握手）/ `connected`。**只报走到哪一步**，不解析 npm 输出、不报百分比；怎么画是 CLI 的事（`tui/screens/host-download.tsx`），桌面端根本不给回调 |
| **取消**（`signal: AbortSignal`） | 中止正在拉起的那个子进程（Ctrl+C / Esc）：拉起的动作归连接层，“按了这个键以后回哪块屏、退不退出程序”归前端（CLI 回连接屏、不退出） |

拉起的两条路里，宿主这边的义务只有一条：把“我起来了”写成 `<数据根>/run/host.json` 并接住 `host.hello` —— 连接层不认端口而认这两件事实（端口可能被占而退回临时端口，也可能根本没人监听）。

## 9. 已知缺口

登记的是「代码里确实还没有的那部分」，不是待办计划：

| 缺口 | 现状 |
|---|---|
| 子 Agent 消息回看（PRD F-I7） | `messages.parentToolCallId` 列已落库（R37），`MessageRepository.listByParentToolCallId(conversationId, parentToolCallId)` 也有了；但生产路径里没有写入该列的调用方（只有用例在用），也没有方法把它暴露出去。眼下 `message.list(toolCallId)` 按消息自己的 `tool_call_id` 过滤，取到的是那次委派的工具结果消息 |
| 「客户端自造问题」 | 契约里只有 `question.list` / `question.answer`。问题对象由宿主内部产生（交接线、不可撤销动作的二次确认），没有让客户端或脚本提问的方法（`host.integration.test.ts` 的 `seedQuestion` 因此绕开契约，直开库调 `QuestionService.ask` 造一行） |

## 10. 待拍板

（已清空：上一条“`message.list` 怎么取”已由 A12 定下。）

## 11. 测试口径

两条门禁：`npm test`（默认套件，只看仓库内容）与 `npm run test:e2e`（两条真进程用例，各自跑一次 `tsc`、起真子进程 + 真 WebSocket，10 秒出头）。`test:all` = 两者 + 构建。

**规模与成本**（2026-11-14 实测）：默认套件 53 文件 / 761 用例 / **20.3s**。单条用例 1–5ms 到 ~40ms 不等，分界只有一条：**这条用例要不要建库**。

### 11.1 一个测试文件一个数据库

每条用例都 `new Database + migrate` 要付 **55ms**（其中 44.6ms 是起一个 SQLite worker 线程），几百条用例就是几十秒。所以碰库的文件统一按这个形状写：

```ts
beforeAll(async () => {                     // 一次建库、一次迁移
  dir = await mkdtemp(join(tmpdir(), "ai-zen-xxx-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new XRepository(db);
});
beforeEach(async () => {
  await db.tx((tx) => [                     // 一条批次 = 一次往返
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
    tx.run("DELETE FROM workspaces"),       // 级联 conversations → messages → conversation_assets
    tx.run("DELETE FROM assets"),           // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);
  /* 本用例自己的 fixture（内容与顺序照旧） */
});
afterAll(async () => { await db.close(); await rm(dir, { recursive: true, force: true }); });
```

四条硬约束：

1. **`meta` 表不许清** —— `migrate()` 靠 `meta.schemaVersion` 判断跑不跑，清掉等于每用例重跑迁移。
2. **FTS 不用手工同步** —— `DELETE FROM messages`（含级联触发）由 `messages_fts_*` 触发器维护索引。
3. **清表顺序** —— `workspaces` 必须在 `assets` 之前（先级联掉 `conversation_assets` 关系行，`assets` 的 `ON DELETE RESTRICT` 才不会拦）。
4. **实例级状态每条重建** —— 服务实例、drafts、事件数组、时钟、假运行时不是库的一部分，共享一个实例会跨用例串味；共享的只有库。

天生要「关库再重开」的用例（`migrations.test.ts` 的全新库、`Database.test.ts` 的 close 语义、`QuestionService` / `NoticeService` 的重开）**保留自己的实例**，不要塞进共享夹具。

### 11.2 「一个事实只在一处断言」

| 事实归属 | 正主 |
|---|---|
| 表结构 / UNIQUE / NOT NULL / 级联 / RESTRICT | `storage/migrations.test.ts` |
| `db.tx()` 的声明式批次边界 | `storage/Database.test.ts` |
| 契约语义（`message.list` 的 `after` / `around`、`question.list` 的过滤…） | 对应的 `*Service.test.ts` |
| SQL 独有行为（FTS5 trigram、LIKE 退化、触发器跟随、通配符转义、`MAX(seq)+1`） | 对应的 `*Repository.test.ts` |
| 上传状态机 / 分帧编解码 | `net/UploadReceiver.test.ts` |
| WS 接线（二进制帧、连接状态、错误帧形状） | `net/WsHub.test.ts` |
| 真命令行 / 真进程 / 重启持久化 | `test:e2e`（`serve.process.test.ts`、`host.integration.test.ts`） |

同一件事在两层都断言，改一次行为就要改两个文件 —— 那种用例删掉弱的那一份，别两边都留。

### 11.3 删用例的判据

判据是必要性，不是「跑得快不快」：

- **生产代码零调用者的方法，连用例一起删**（`AutoNaming.shouldName`、`QuestionService.cancel`、`ConversationRepository.touch` / `countByWorkspace`、`AssetRepository.countConversations` / `listConversationIds`、`QuestionRepository.delete`、`noticeHandlers.createNoticeEventLocalizer` 都是这么出列的）。留着它们会给出假安全覆盖。
- **被测对象根本拿不到的依赖不要摆进夹具**（`TransientRunner` 没有库句柄，却每用例建库去断言「库里 0 行」）。
- **便宜到可以每次改动都跑一遍的守卫按条数留**（`wire/*.test.ts` 70 条共 0.07s，1ms/条）：它们抓的是不可信客户端帧、错误码文案、方法表不许回表这类真回归，删了省不下时间，只丢覆盖。

## 12. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 初稿：定 A1–A10；进程与接线、对象图、生命周期、存储、接线、事件形状、SDK 边界 |
| 2026-11-12 | 上传定为二进制帧（A11）；§9 待拍板只剩一条 |
| 2026-11-12 | `message.list` 取法定下（A12）：按 id 取、含自身最新内容、id 不存在则全量；§9 清空 |
| 2026-11-12 | 按实现复核（W5-B）：回调名改 `onAllRecycled`；补桥接名单与二进制帧格式；推送的事件名在 `method`；表骨架按实际列重写；`tx` 的声明式批次边界写清；方法表 63 个 / 事件 6 个 / 能力清单粒度（A13）落文；数据根目录树按 `ConfigManager` 实际推导；新增 §9 已知缺口，原 §9/§10 顺延 |
| 2026-11-12 | W6-B 运维与展示面：方法表 63 → 64（`host.reload` 进表，A13 的能力条数同步）；§6/§7 改正「`hello` 回完整清单」为**只回能力 id 列表**（R57）；§2 端口那一档补真实来源 `<数据根>/host.json` 与「显式非法端口报 `config_invalid`」（R67）、补升级自检（R66）、数据根目录树与 §5 补 `host.json` 与 `logs/`（F-J2）、§3 的日志口子由 `HubLogger` 改为 `Logger`、§4 补收尾顺序；§9 已知缺口按本轮实现改写（状态栏块、日志、端口三条出列，补助手名字与 `DefaultSelection.language` 两条） |
| 2026-11-12 | W6-C 补齐两条已知缺口：`DefaultSelection.language` 进契约（§9 那条出列）、状态栏助手块的名字与可用性由 `AgentService.describe` 现读（§9 那条出列）；§5 存储表下方补「消息条数的两个口径」（`listByConversation` 主线 / `countByConversation` 全部行，侧栏 vs 删除代价） |
| 2026-11-12 | W7-A：cwd 注入改成**会话创建时一条独立的 `hidden` 消息**（PRD F-D9 改口径），每轮不再往用户消息末尾拼注入段；§4 补「一段对话的诞生」与 `hidden` 的含义，§5 两个条数口径都改成不含 `hidden`，§6 `message.list` 加 `includeHidden?`，§7 `conversation.changed.messageCount` 注明不含 `hidden` |
| 2026-11-12 | W7-C：模型与思考档位改成**会话级、持久化**（PRD L7 / F-B4 / F-B6）：§5 `conversations` 加 `thinkingLevel`（可空）且 `modelId` 变成可改；§4 补「一段对话的模型与档位存在会话行上」与装配口径（档位名 → 参数补丁在 `ChatRunner.createSdkAgentFactory` 展开）；§3 删掉 `ConversationStateRegistry`（进程内临时覆盖作废），服务层要的运行时接口只剩 `isRunning` / `forget` |
| 2026-11-13 | W10：资源表与厂商关联表。`assets` 补 `sha256`（`NOT NULL`）+ `width`/`height`（可空）+ `UNIQUE(conversationId, sha256)`（对话内去重）；新增可失效缓存表 `asset_vendor_files`（`UNIQUE(assetId, endpointId)`、索引 `lastUsedAt`、级联删）。消息里持久化的只有 `asset://<assetId>`，发送前由 `AssetService.resolveHistory` 按当前模型还原；厂商 `file_id` 由 `upload` 注入点查表/写表（命中零上传），失效时按「这段对话 + 这个端点」作废并由 `ChatRunner` 重试一次。新增方法 `asset.get`（65 个方法；走 JSON + base64 回包，不进桥接名单）；§5 补两张表的分工，§6 补去重与取回。 |
| 2026-11-13 | W12：素材层删简。`asset_vendor_files` 去掉 `lastUsedAt` 列与它的索引（不做过期清理），缓存只剩三条规则（命中复用 / 换端点内联 / 首传写回）；删掉 `AssetService.invalidateVendorFiles`、`AssetRepository.listVendorFiles` / `deleteVendorFiles` / `deleteVendorFile` / `touchVendorFile`，以及 `ChatRunner` 里「file 不存在/无效」的文本判据、`retryAfterVendorFileError` / `resetForRetry` / 整轮重备的那一套。§5 按新口径回改；`stripLocalExtensions` 换成 core 的 `formatContent`（W12 同时给 core 加了 `formatContent` / `formatContentSection`，`formatHistory` 走它们）。 |
| 2026-11-13 | W11：引用方式改成**内容段上的本地扩展字段 `__asset_id`**（不再往 `image_url.url` / `file.file_id` 里塞 `asset://`）。`assets` 去掉 `conversationId` / `messageId` 两列，`sha256` 改成全局 `UNIQUE`（去重从「对话内」改成「全局」）；新增关系表 `conversation_assets`（`UNIQUE(messageId, assetId)`、`assetId` 为 `ON DELETE RESTRICT`、索引 `assetId` / `conversationId`），消息落库那一刻扫 `content` 里的 `__asset_id` 写行，撤回 / 删对话由外键级联删行，删完之后 `COUNT(*)` 归零才删素材行与文件（`AssetService.sweepUnreferenced`）。「所有 `__` 开头的字段都是本地扩展、发送前一概剥离」落成 `wire/states.ts` 的两个纯函数 `stripLocalExtensions` / `localAssetIdOf`，`resolveHistory` 出的每一段都过白名单，且同一 `(素材, 端点)` 两轮算出来的段逐字节相同。客户端加 `localAssetIdOf` / `getSectionAsset`（按扩展字段取字节，不解析 scheme）。§5 补第三张表与「归零才删」的落点，§6 补全局去重与取回口径。 |
| 2026-11-13 | W14-A：素材尺寸（裁定 R76）。`assets.width` / `height` 不再恒空 —— `AssetService.finalizeUpload` 把临时文件改名成正式文件之后读一次文件头，由 `src/services/imageSize.ts` 的 `readImageSize`（纯函数，零依赖）从 PNG 的 IHDR 块 / JPEG 的 SOF 段解出宽高写进这一行；其它格式、截断文件、解不出来的字节都写 `NULL`，不重试、不告警。`AssetRef` 与 `asset.get` 回的就是这一行，所以客户端拿到的 `width` / `height` 是上传那一刻量出来的真值。§5 的 `assets` 行按此回改。 |
| 2026-11-14 | W3：契约面跟上新契约。方法表 **65 → 63**（13 个域、无 `credential` 域）：新增 `agent.restoreFactory`、`config.saveMcp` / `config.deleteMcp`（取代 `config.patchMcps` 的整层替换）；删 `host.usage` 与 `credential.list/create/revoke` —— **删的是契约面，能力仍在**（`CredentialService`、`CredentialRepository`、`<数据根>/run/token` 与 `agents-host token create\|list\|revoke` 一字未动，`Credential*` 形状只留给那三个子命令）；§6 桥接名单后「其余 60 条」改成 59。A12 补 `around` 的取法（40 条窗口 / 命中才给 `anchor` / 没命中回空页不报错 / 与 `after` 同给时 `around` 优先 / 消费者只有桌面端搜索定位），A13 的条数 65 → 63。§3 补「视图与入参的几处形状」（`AgentView.messages` / `function`、`DiscoveryEntryView` 的传输字段与 `extra`、`DiscoveryLayerView.scope`、`McpOauthView` 的掩码口径、`ModelInput.tokenThresholds` 可选），§7 能力清单条数同步。§8 把 `@ai-zen/agents-client` 列成「共享连接层」并写清它这一轮定的三件事（npx 拉起 `spawnHostViaNpx`、阶段回调四态、`AbortSignal` 取消），明确「怎么画屏」不归它。 || 2026-11-14 | 测试口径落文（§11，原「变更记录」顺延为 §12）：默认套件关隔离 + 一个文件一个库里的一条 `tx` 清表 + 事实归属表 + 删用例的三条判据。默认套件从 79.5s 降到 20.3s，用例 801 → 761。 |
| 2026-11-14 | 能力清单去掉 `title` / `description`：`/help` 改由 CLI 自己的命令表渲染（PRD F-E5 订正），那两个字段与 i18n 的 `capability.*` 252 条文案零消费者，连同 `localizeCapabilities`、`createCapabilities(language)` 的语言参数、`callInLanguage` 夹具一起删；A13 / §7 / hello 段同步 |
| 2026-11-14 | 契约面 63 → 62：删 `host.capabilities`（连同 `hello.capabilities`、`handlers/capabilities.ts`、`CapabilityView`、`methodDomain()` 的唯一生产消费者）。两端零消费者，见 §7 那段；F-E6 的落点改成客户端命令表。`host.reload` 的 `scope` 参数一并删（5 值枚举 + 校验 + 映射全是空转，没有调用方）。i18n 又清掉 33 条零产出文案（`status.*` / `usage.*` / `notice.*` / `question.confirm.*` 等），并加守卫「每个词条在生产码里都有人取」 |
| 2026-11-14 | 状态栏块名搬回客户端：`StatusBlock` 去掉 `label`（8 块 × 2 语言 = 16 条界面词汇），宿主只给 `id` + `facts` + 顺序（`STATUS_BLOCK_IDS`）；CLI 用本地词条 `status.block.<id>` 渲染。`statusBlocksOf` 不再收 `language`，`blockLabel()` 与 i18n 的 `label.*` 8 组键一起删。同一口径的第二个案例（第一个是能力清单的 `title`/`description`）：**界面文案归界面，宿主只给事实** |
