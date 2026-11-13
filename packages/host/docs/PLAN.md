# 计划（PLAN）

> **三份文档的分工，不许混**
>
> | 文档 | 回答什么 | 谁能改 |
> |---|---|---|
> | `PRD.md` | **需求**：产品要什么、边界在哪 | 只有用户（人的决策） |
> | `architecture.md` | **结构**：宿主内部怎么搭 | AI，改了要说清道理 |
> | 本文件 | **计划**：先做什么、怎么算做完 | 优先级与范围归用户（§5），拆法与步骤归 AI（正文） |
>
> 本文每条都标了它的性质：
> **【需求】** 来自 PRD，不许改；**【人的决策】** 等用户裁定，AI 不替他拍；**【AI 的决策】** 是拆法与实现路径，写清理由，用户随时可否决。
>
> 历史：本文件取代四份已删的计划文件（见 §7），裁定编号 R1–R79 的原文在 git 历史里。

## 1. 现状快照（2026-11-13 实跑，不是估计）

| 仓 | 分支 / HEAD | 未提交 | 类型检查 | 用例 |
|---|---|---|---|---|
| `agents`（host + client） | `feat/server-rewrite` / `af5e7c9` | 183 项 | `tsc` 0 错 | host **763 绿**（59 文件）、client **98 绿** |
| `cli`（TUI CLI） | `main` / `75ab365` | **0** | **`tsc` 161 错 / 37 文件** | **58 失败 / 745 通过**（803 条，56 文件） |
| `desktop` | `feat/new-server` / `cb16f28` | 77 项 | `vue-tsc` + rolldown + 两条护栏通过 | main **121 绿 + 3 跳过**、render **70 绿** |
| `cli-old` | detached @ `pre-split-20261111` | 0 | 只读冻结参照物，不是迁移对象 | 冻结时 818 |

**结论**：宿主已经完整（65 方法 / 6 事件 / 全绿），**TUI CLI 落在旧协议上、当前 HEAD 就编译不过**。
「host ↔ TUI CLI」这条链是断的，而且断在客户端一侧。

## 2. P0 —— host ↔ TUI CLI 打通（当前唯一主线）

### 2.1 断在哪（事实，逐条有据）

桌面端和 TUI CLI 共用同一个连接层 `@ai-zen/agents-client`，但它被重写成了**精简传输层**：
`Client` / `ensureHost` / `parseAddress` / `settings` / `resume` / `upload` / `asset` / `reconnect`
（`agents/packages/client/src/index.ts` 的门面表）。旧库提供的
`ServerConnection` / `ensureServer` / `createRemoteConfigPort` / `ConfigPort` / `AgentStore` / `Mcp*` **全都不在了**。
桌面端已跟着改完，TUI CLI 没跟。

161 条错误的成因只有四类（`npx tsc --noEmit -p tsconfig.test.json`）：

| 类 | 条数 | 例子 | 性质 |
|---|---|---|---|
| 模块不存在 | 8 | `@ai-zen/agents-server`（5）、`@ai-zen/agents-server/protocol`（3）—— `session/types.ts`、`session-phase.ts`、`__tests__/e2e.test.ts` | 宿主改名 R77 的下半场没做完 |
| 客户端库没有这个导出 | 58 | `ServerConnection`、`ensureServer`、`ConfigPort`、`AgentStore`、`McpConfig`、`SocketServerClient`、`parseServerUrl`、`connectionSettingsPath`… （全清单见附录 A） | 库已经重写了形状 |
| 旧字段名 | 12 | `ConnectionSettings.serverUrl` / `serverToken`（现在是 target + 语言） | 同上 |
| 连锁的隐式 any | 37 | `handlers.ts` 里 `model` / `agent` / `item` 参数 | 上游类型补齐即消失，不单独处理 |

58 条失败用例集中在 8 个文件，主因是大量 `new ServerConnection()` 这种「旧类当假件」的写法
（`src/tui/screens/chat.test.tsx:196`）。

### 2.2 五步（【AI 的决策】，可调，但不许改需求）

**S1 连接层对齐**（`src/server-client/index.ts`、`src/connection.ts`、`src/env.ts`）
- `ServerConnection` → `Client`（`Client.connect` / `client.call` / `client.subscribe`）
- `ensureServer({ aiZenDir, serverPackage, serverUrl, serverToken })` → `ensureHost({ dataRoot, target?, token?, spawnHost })`
- `SERVER_PACKAGE = "@ai-zen/agents-server@0.1.0-alpha.0"` → 宿主包坐标（`@ai-zen/agents-host`），拉起走 `spawnAgentsHost`
- 设置文件改用 client 的 `settings.ts`（`readSettings` / `writeSettings` / `parseSettings`），不再自己拼 `serverUrl/serverToken`
- **探活**：旧代码用 `client.call("ping")` 证明「连上且进得去」（`src/connection.ts:156`），
  新契约**没有 ping**（`grep -rn ping agents/packages/host/src agents/packages/client/src` 无输出）。
  判据换成「`ensureHost` 成功即连上」—— 握手本身校验凭证，握手不过就没有 client。
  这是**删代码**，不是补代码；若将来要真正的保活，那是新需求，另立。

**S2 契约面改名**（`src/session/*`、`src/session-phase.ts`、`src/session-notice.ts`、`src/pending-notices.ts`、`src/tui/*`）
- 协议类型来源：`@ai-zen/agents-server/protocol` → `@ai-zen/agents-client`（它已把宿主的 `wire` 全量 `export type` 转出）
- `notice.ack` → `notice.dismiss`（一条）/ `notice.clear`（一片）；`SessionQuestionEvent` → `QuestionView`
- `PhaseInfo` 六态 → `RunState.phase`（宿主 `wire/states.ts` 的同名事实）
- **词汇**：CLI 里的 `server`→`host` 是产品术语对齐（PRD §1 的对照表），只改语义对应物；
  MCP 的 `mcpServers`、Node 的 `WebSocketServer`、SDK 的 `InternalServerError` 一律不动（R77 的边界）

**S3 补 CLI 自己的薄服务层**（新增，不是改名）
旧库顺手给了 `ConfigPort` / `AgentStore` / `Mcp*` 这类便利层，新库不给 —— 它只做传输。
所以 CLI 要像 `desktop/packages/main/src/host/services.ts` 一样，自己把「界面要的形状 ↔ 契约调用」翻一层：
`config.get / patch / setDefaults / getDiscovery / patchMcps / saveEndpoint / deleteEndpoint`、
`agent.*`（7 条）、`model.*`（8 条）。**规则照桌面端那四条纪律**：不自己算规则、不重新包装
`AgentNS.Message`、结构化事实不拍平、契约没有的东西不造。

**S4 用例与 e2e**
- 58 条失败按新 API 重写（`new ServerConnection()` 假件换成注入的 `client` 形状）
- e2e 的 `Daemon`（来自已不存在的包）→ `createHost`（`agents/packages/host/src/index.ts:12` 导出）
  或真进程 `agents-host serve`；`workspaceIdFor` 之类的旧助手一并替换

**S5 打包**（R69 的下半场）
`rolldown.config.mjs` 把 `@ai-zen/agents-client` 内联进 `dist`，`check:imports` 里加一条
「产物不许留 `@ai-zen/agents-client` 的运行时依赖」。共享包 `private: true`，不许发包。

### 2.3 P0 验收（逐条走，错一条就是没做完）

1. `npx tsc --noEmit -p tsconfig.test.json` **0 错**
2. `npx vitest run` **全绿**（基线 803 条；每条失败要么修好，要么删掉并在提交里说明为什么它不该存在 —— 不许留给下一轮）
3. `npx vitest run --config vitest.e2e.config.ts` 全绿
4. **真进程竖切**：`node ../agents/packages/host/dist/cli.js serve` 起真宿主，`ai` 手动走一遍：
   连接 → 发一条消息看到流式 → 撤回 → 搜索 → 置顶 → 跑到交接线作答（三选一）→ 配置向导改一个默认项
5. `pnpm build && node scripts/check-imports.mjs dist/index.js --forbid @ai-zen/agents-client` 通过
6. **不必要性审查**（铁律 10）：这次迁移里**不许新增**任何「因为旧代码有所以留着」的东西 ——
   每一条新增入参、每一个防御分支都要能说出「哪个界面的哪一行会走到」

## 3. P1 —— TUI CLI 侧的需求完整性（P0 绿了才能开始）

【需求】PRD §4 里落点是 `C` 或 `S+C` 的条目，主战场就是 TUI CLI。**大部分已经实现**（对着旧协议写的），
P0 之后要逐条复验，而不是重做：

| 已存在的实现（文件） | 对应的 PRD 条目 |
|---|---|
| `tui/screens/handoff-choice.ts` | F-D2 交接三选一 |
| `tui/screens/notice.ts`、`pending-notices.ts`、`session-notice.ts` | F-I8 通知通道 |
| `tui/mention.ts` | F-H4 / F-H5 `@` 菜单 |
| `status-segments.ts`、`session-rate.ts` | F-I6 状态栏块 / F-I5 速率 |
| `tui/config-wizard/*`、`mcp-command.ts`、`agent-switch.ts`、`reasoning-effort.ts` | F-F1~F-F7、F-B4、F-B6 |
| `tui/key-debug.ts`、`mouse.ts`、`input-editing.ts`、`system-editor.ts`、`hook.ts`、`clipboard.ts` | F-J3、F-H1~H3、F-C11、F-A4、F-H6 |
| `version-compare.ts` | F-E3 升级 |

P0 迁移完成后，逐个确认它到底接的是新契约的哪个方法（不是「文件在就算做完」）：

- `question.answer` —— 交接/确认的作答必须走它（旧协议不是这条）
- `notice.list / dismiss / clear` —— 通知的持久化与手动清（旧的是 `notice.ack`）
- `statusBlocks` —— 状态栏八块的结构化事实（现在是 CLI 自己拼字符串？查了才知道）
- `completion.files` —— `@` 补全的数据源（D7：远程前端看不到目录）
- `host.upgrade` / `host.reload` —— 升级与手动重载
- `conversation.revert / pin`、`search.conversations / messages` —— 撤回 / 置顶 / 搜索

每条的验收照旧：真进程手跑一遍 + 一条钉住该行为的用例。

## 4. P2 —— desktop（**排在 P0/P1 之后，先不排期**）

【需求】桌面端同样是客户端，PRD 里 `S+C` 的条目它也欠着。已普查完（不进本文件正文，见 §7 的出处），
压成三档：

1. **会跑死对话的 3 条**：问题对象没有作答通路（`question.list/answer` 零调用，`main/src/host/events.ts:243`
   把 `QuestionView` 压成一条 notice）⇒ 跑到交接线后每次 `conversation.send` 被 `question_pending` 拒，
   对话永久报废；交接 `handoff.start` 同一条链。
2. **22 项 PRD 明文要求但零入口**：搜索、撤回、置顶、思考强度、临时对话、记住上次会话、帮助、
   能力清单、切语言、模型/图片模型/助手/MCP/端点编辑、默认项 3/5、工具输出上限、
   `/` 与 `@` 菜单、用量与状态栏、通知栏。
3. **体验欠账**：首启引导屏没跑过真 GUI（本机无 electron 二进制，但有 `xvfb-run`）、
   「选服务 + 填 Key」不是向导只是跳设置页。

## 5. 人的决策（等你裁定，AI 不动手）

| 编号 | 问题 | 现状事实（供你判断） | 我的建议 |
|---|---|---|---|
| Q1 | 6 条「没有任何客户端入口」的契约方法删不删：`credential.list/create/revoke`、`host.usage`、`host.upgrade`、`host.shutdown` | `credential.*` 有生产消费方但**不是 wire**：`agents-host token create/list/revoke` 直接开库调 `CredentialService`（`host/src/cli.ts:213-268`）；桌面端从不 kill 宿主（`launch.ts:50-80` detached+unref），`host.shutdown` 无人调用；`host.usage` 的口径已被 `conversation.state.usage` 全覆盖 | 删 wire 面、留服务层（`credential.*` / `shutdown` 的内部机制仍在用）；`host.upgrade` 单独议：它是 PRD F-E3 的明文需求，但**现在有了 TUI CLI 这个客户端**，它可能正是升级入口 |
| Q2 | PRD 里 8–9 条 TUI 专属条目怎么处理：F-A4、F-C9、F-C11、F-H1、F-H2、F-J3、F-K1~K3 | 这些条目现在**有真正的客户端了**（TUI CLI，且大多已实现），不再是「遗留」 | 不用动 PRD，归 P1 |
| Q3 | desktop 的类型检查要不要前置 `agents/packages/host/dist` 的构建 | 现状是靠已存在的 dist，构建顺序没写进脚本 | 前置（一次显式依赖，胜过一条隐式约定） |
| Q4 | 「复杂兜底」全仓审计要不要做、做多大：`retry` / `fallback` / `catch` 密集文件的逐文件清理 | 只做过契约面这一遍 | 等 P0 完成后再做，否则会边修边被清理 |

## 6. 每波的验收标准（三波共用，不许减项）

1. 类型检查 0 错（host/client `tsc`、cli `tsc -p tsconfig.test.json`、desktop `vue-tsc`）
2. 用例全绿；**失败不许用 `.skip` 换绿**，要么修好要么删掉并说明
3. 真进程竖切跑通（不是只有单测绿）
4. **不必要性审查**（铁律 10）：新增的每个可选入参、可空返回、防御分支，都要答得出「哪个客户端的哪一行会走到」
5. 文档同步：改了行为就改 PRD/architecture 的对应条目，不许文档落后于代码
6. 不自己 commit（用户的规矩）

## 7. 文档地图（历史去哪了）

| 路径 | 是什么 |
|---|---|
| `agents/packages/host/docs/PRD.md` | 需求唯一来源（79 条能力 + 锁定决策 L/D/A） |
| `agents/packages/host/docs/architecture.md` | 宿主结构（A1–A13） |
| `agents/packages/host/docs/plan-questions.md` | 实施者自决与待核（QD 条目） |
| `agents/packages/host/docs/PLAN.md` | **本文件** |
| `agents/.ai-zen/handoffs/*.md` | 交接记录（历史，不假造过去，不改） |

**本次删掉的四份**（内容已被本文件吸收，原文在 git 历史里）：

| 删除的文件 | 里面还有价值的东西去哪了 | 怎么找回原文 |
|---|---|---|
| `agents/.ai-zen/plan-host-rewrite.md`（36KB） | 裁定 R1–R79 的原文、目录契约、旧验收标准 → 仍在生效的约束已体现在 PRD / architecture / 本文件 §2.2 / §6 | `git show HEAD:agents/.ai-zen/plan-server-rewrite.md`（289 行，HEAD 里还是改名前的旧名） |
| `agents/.ai-zen/plan-clients.md` | C1–C4 客户端波次 → 在 §2 S1–S5、§4 | `git show HEAD:agents/.ai-zen/plan-clients.md`（26 行） |
| `agents/.ai-zen/gap-report-20261113.md` | 完成度普查（65 方法 / 46 零调用）→ 结论进 §4，明细随该文件删除 | 未入库，只在上一轮对话里 |
| `desktop/TODO.md` | 首启真 GUI 验收 5 条、凭据向导 5 条 → §4 第 3 档 | `git -C desktop show HEAD:TODO.md`（71 行） |

## 附录 A —— TUI CLI 缺失的客户端库导出（`tsc` 的 58 条 TS2305 去重）

连接与地址：`ServerConnection`、`ensureServer`、`ServerClient`、`ServerTargetSource`、`parseServerUrl`、
`normalizeServerAddress`、`connectionSettingsPath`、`connectionSettingsToTarget`、`readConnectionSettings`、
`writeConnectionSettings`、`connectionLabel`、`readDescriptor`、`resolveToken`、`explainUnauthorized`、`SocketServerClient`

配置与 MCP：`ConfigPort`、`createRemoteConfigPort`、`McpConfig`、`McpReadResult`、`McpScope`、`McpServerEntry`、
`McpServersMap`、`ModelParams`、`ModelLevel`、`clientWorkspacePath`、`WorkspaceFileEntry`、`MAX_TEXT_BYTES`

会话与消息：`AgentKind`、`AgentStore`、`RemoteSessions`、`SessionStreamState`、`SessionSnapshotResult`、
`SessionQuestionEvent`、`SessionNoticeCode`、`ServerNoticeCode`、`SessionChannel`、`MessageContent`、
`MessageContentBlock`、`UploadContentInput`、`ContentUploadResult`、`ChannelNoticePayload`、`GlobalNoticeSlot`

宿主状态：`ServerStatus`、`ServerStatusDeps`、`readServerStatus`、`PhaseInfo`、`NoticeListResult`

> 这张表就是 S2 + S3 的工作量清单：**每一行要么映射到新契约的某个方法/类型，要么确认它已经不需要**。
> 不许「为了让它编过」在 CLI 里再造一份同名类型 —— 那等于把客户端库重写一遍。
