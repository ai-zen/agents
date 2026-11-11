# 服务端架构（初稿）

> **本文边界**：PRD 说「要为用户做到什么」，本文说「这些事怎么搭起来」。
> 本文没写的，按 PRD 办；两者冲突，以 PRD 为准，并回头改本文。
>
> 骨架参照 `ai-zen/desktop` 分离前那份本地实现（分支 `ref/pre-separation`，提交 `5498691`，13 个文件 1,524 行），**不从 `packages/server/bad-src` 继承任何东西**。

- 状态：**初稿**，待逐节过
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

## 2. 进程与接线

**启动方式决定监听范围**，不是运行时判断：

| 启动方式 | 监听 | 凭证 |
|---|---|---|
| 被本地客户端拉起（本地实例） | 只监听回环（`127.0.0.1` / `::1`） | 服务端首次启动时生成，客户端自动取 |
| 创建者手动起、要给别人连（对外实例） | 监听创建者指定的地址 | 创建者在自己的入口里创建凭证（带备注），手动分发给对方 |

端口按 PRD D25：启动参数 > 配置文件 > 默认端口；端口被占时退回系统分配的临时端口。

**单实例靠发现文件**：`<数据根>/run/server.json` 是「这台机器上谁在服务」的唯一真相（进程 id、端口、启动时间、本地/对外），客户端探活、服务端启动时自查，两边都读它，不各写一份。

**凭证交付**：凭证自身一份真相在库里（可列出、带备注、可单独吊销）；`<数据根>/run/token` 只是个交付口，内容只有「本地那串」，吊销/轮换时服务端顺手重写，权限 `0600`。**Windows 上 `0600` 是空操作**，那里只能靠用户目录本身的 ACL —— 文档和文案都不许把它当安全保证。

**升级**（PRD D4）：服务端读磁盘上的版本号，确认与自身版本不一致且升级确实完成（磁盘版本已更新）就立即重启，不等在跑的轮次；服务端不自己装包。

**数据根**（`AI_ZEN_DIR`，缺省 `~/.ai-zen`，可被环境变量改）：

```
<数据根>/
├── ai-zen.db          # 全机一个库
├── assets/            # 图片与文件附件（库里只存引用）
├── agents/            # 助手定义（一实体一文件）
├── skills/、tools/、subagents/、mcp.json   # 配置层（SDK 口径）
└── run/
    ├── server.json    # 发现文件
    └── token          # 本地凭证交付文件
```

## 3. 对象图

**单根 + 构造函数显式注入**，同桌面端 `DesktopApp`：不用模块级单例、不用反射扫描。依赖从根出发，跨服务协作（删对话 → 释放运行中的轮次）用显式钩子声明，不靠事件总线兜。

```
ServerApp（根：组装、启动、退出）
├─ 基础设施
│  ├─ ConfigManager        (SDK)  ← 配置唯一入口
│  ├─ Database             SQLite worker（all / get / run / tx）
│  ├─ *Repository          只做 SQL，不含业务
│  ├─ I18n                 文案与多语言（D8）
│  └─ Logger               落文件 + warn/error 上通知
├─ 服务（一服务一文件，薄）
│  ├─ WorkspaceService     ├─ ConversationService   ├─ AgentService
│  ├─ ModelService         ├─ ConfigService         ├─ AssetService
│  ├─ SearchService        ├─ CredentialService     ├─ NoticeCenter
│  └─ QuestionCenter
├─ 运行时（有状态，比 service 更长寿）
│  ├─ ScopeRegistry        workspaceId → Scope + 依赖计数 + 空闲计时
│  ├─ RunRegistry          conversationId → 运行中的那一轮
│  └─ ChatRunner           一轮的流式循环（借 Scope、产出事件）
└─ 接入
   ├─ WsHub                连接集合、鉴权、语言、JSON-RPC 分发
   └─ UploadReceiver       同一条 WS 上的二进制分帧落盘
```

目录（`packages/server/src/`）：

```
app.ts        单根：组装、启动、退出
cli.ts        命令行：serve / token / version
config.ts     路径与端口来源
wire/         契约：方法名、帧形状、错误码、事件名
net/          WsHub、鉴权、上传接收
services/     薄服务
runtime/      ScopeRegistry、RunRegistry、ChatRunner
storage/      Database、dbWorker、Repository、migrations
i18n/         文案
```

## 4. 生命周期

**一轮对话**：

```
请求到达 → RunRegistry 占位（该对话已在跑则直接拒，PRD D14）
        → 借 Scope（ScopeRegistry.acquire：懒创建或复用，依赖 +1）
        → 装配 agent（模型/助手/权限来自 SDK，跑完即弃）
        → 流式：增量推事件；同一条消息边流边写
        → 内循环结束：写一次（D15）→ agent 释放 → ScopeRegistry.release（依赖 −1，归零则起 10 分钟计时）
```

**计时器只有一处**：`ScopeRegistry` 持有唯一那份空闲计时。L4 说的「10 分钟无活动」和 D28 说的「Scope 空闲 10 分钟」，是同一个计时器的两个说法，不各写一份。

**进程退出**：没有连接、没有运行中的轮次、且 Scope 全部回收之后 —— 也就是「什么都不欠了」。进程退出连带断开所有 MCP 连接，这是已知代价（MCP 服务器自己拉起的外部进程可能随之结束，取决于那个 MCP server 的实现）。

**Scope 被销毁的三个原因**：(1) 空闲 10 分钟；(2) Workspace 被删；(3) 配置变更需要重连 MCP（PRD F-E2：改完配置即生效，靠重连而不是重启）。

## 5. 存储

`node:sqlite`（SQLite 3.53.4，实测支持 WAL / json1 / FTS5 / `trigram`）跑在 worker 线程里，主线程只发消息。对外四个方法：`all` / `get` / `run` / `tx`（`tx` 是一次消息里跑多语句，用于「批量写必须原子」的场合）。

表骨架（初稿，字段随实现调整）：

| 表 | 关键列 |
|---|---|
| `workspaces` | `id`、`name`、`cwd`（不可变）、`createdAt` |
| `conversations` | `id`、`workspaceId`、`name`、`pinned`、`createdAt` |
| `messages` | `id`（服务端分配，请求发出前就有）、`conversationId`、`seq`、`role`、`status`、`omit`、`content`(json)、`createdAt` |
| `assets` | `id`、`conversationId`、`messageId`、`path`、`mime`、`bytes`、`createdAt` |
| `notices` | `id`、`level`、`duration`、`payload`(json)、`createdAt`（L3：持久化，只能手动清或到点消失） |
| `questions` | `id`、`conversationId`、`kind`、`payload`(json)、`state`、`answer`(json)、`createdAt` |
| `credentials` | `id`、`note`、`hash`、`createdAt`、`revokedAt` |
| `meta` | `schemaVersion`、`createdAt` |

**全文检索**：`messages` 上挂 FTS5 外部内容表，`tokenize='trigram'`。两条实测约束要写进实现：(1) `unicode61` 下整段中文是一个 token，用错就搜不到；(2) `trigram` 的查询词至少 3 个字符，2 字中文查询退化到 `LIKE`（D16 的「成本接受」就落在这）。

**边流边写**：运行时以内存里的消息为真相，同一条消息行按节流 upsert；装载/崩溃恢复复用 core 的 `reconcileAbortedToolRounds(fill)` + `reconcileAbortedMessages(keep)`，所以 `status` / `omit` 两列必须落盘（PRD D15）。

**迁移**：`meta.schemaVersion` + 顺序迁移脚本，启动时在事务里跑；不识别任何旧数据（L1）。

## 6. 接线：一条 WS 上的 JSON-RPC

**首帧 `hello`**：`{ token, language?, clientInfo }`。凭证不放在 URL 查询串里（会进日志与进程表）；未 `hello` 成功的连接除了 `hello` 什么都不接。`language` 挂在连接上，断开即忘（D8 的缺省语言取配置）。

**方法名**：`<域>.<动作>`，如 `workspace.list`、`conversation.send`、`message.list`、`config.get`、`config.patch`、`question.answer`。

**`message.list` 的取法（A12）**：入参 `after?: <消息 id>`。

| `after` | 返回 |
|---|---|
| 不给 | 该对话全部消息 |
| 给了且该 id 存在 | **从这条消息开始**（含它本身，内容是**最新**的，可能是流式中那条的部分内容 + 还在写的标记，L5）+ 其后全部 |
| 给了但该 id 不存在（已删除、或库已换） | 全部 |

“从这条开始而不是它的下一条”是故意的：重连的客户端上次拿到的最后一条可能是流式中那条，它的内容已经变了；从它自己重新拿，天然就是“最新内容 + 之后的”。

**推送**：JSON-RPC 通知（无 id），`params` 里带事件名与数据。**不重放、不需要 ack** —— 断线即作废，重连按 D5 自己拉状态与消息。

**错误**：JSON-RPC `error` 对象；`data.code` 是稳定业务码（客户端据此分支），`data.message` 是按连接语言渲染好的人话（服务端出文案，D8）；结构性事实（哪个字段不对、还差什么）放 `data.detail`，不让客户端解析句子。

**推送（含通知）入库存的是「码 + 参数」，不是渲染好的句子**：多语言在读出时按该连接的语言渲染（D8），否则一条通知存死一种语言，换个语言连回来就错了。

**上传**：同一条 WS 上走**二进制帧**，三段式 —— `asset.begin`（JSON：声明总长、用途、类型）→ 若干 `asset.chunk`（WS 二进制帧，直接写进 `assets/` 的临时文件，不攒进内存）→ `asset.end`（服务端校验长度与摘要后改名为正式引用并返回）。单张 20MB 上限（D5），超限在 `begin` 就拒，不接收完再说不行；中途断开按 `begin` 里记的临时文件清理。

## 7. 事件形状

| 事件 | 内容 |
|---|---|
| `run.state` | 六态：连上 / 等首字 / 在想 / 在输出 / 拼工具调用 / 等工具（并行工具只念还在跑的，PRD L8） |
| `message.delta` | 消息 id + 片段 + 该片段属于哪一段（思考 / 工具调用 / 正文）；单条消息内部顺序恒定 |
| `conversation.changed` | 结构变化（改名、置顶、新增消息已落库）—— 让客户端知道「该去拉了」 |
| `notice` | 三档语气 + `duration`（给秒数则到点消失，不给则永久，L3） |
| `question` | 问题对象：id、类型、候选、当前状态（多端看同一个，D22） |
| `usage` | 本轮 / 累计（含子 Agent）/ 速率 |

## 8. 与 core / SDK 的边界

| 归谁 | 内容 |
|---|---|
| `@ai-zen/agents-core` | `Agent`、流式 `applyChunk`、消息与工具调用结构、中止修复（`reconcile*`） |
| `@ai-zen/agents-sdk` | `Scope`（能力装配）、`ConfigManager`、`createAgent` / `SdkAgent`、`HandoffService`、五个 Scope 插件、`McpConnectionManager`、`discover*`、出厂 Skill 与思考策略表、`fileToContentSection` |
| 服务端 | 进程与接线、凭证、Workspace 与对话的生命周期、Scope 的持有与回收、持久化、i18n 文案、通知与问题对象、上传 |

原则：**agent 循环不重写**，服务端只做「装配 + 持久化 + 接线」。

## 9. 待拍板

（已清空：上一条“`message.list` 怎么取”已由 A12 定下。）

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 初稿：定 A1–A10；进程与接线、对象图、生命周期、存储、接线、事件形状、SDK 边界 |
| 2026-11-12 | 上传定为二进制帧（A11）；§9 待拍板只剩一条 |
| 2026-11-12 | `message.list` 取法定下（A12）：按 id 取、含自身最新内容、id 不存在则全量；§9 清空 |
