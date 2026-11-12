# Handoff — 服务端重写夜间作业（服务器已成形，cli/desktop 未动）

## 💬 Conversation Breakpoint

用户睡前最后一句：**「接下来你充当项目经理，你可以派多个人去实施你的计划，你尽可能不要亲手去办，你只做指挥和验收。等服务器写完了再去更新 cli 和 desktop 代码。我去睡觉了，遇到任何问题你先自己决策」**。
此前最后一次纠偏（白天）：**「对于聊天消息内容不要发明任何新的数据类型，直接按原样使用 core 包的导出」**。

## 🎯 Task Goal

按 `packages/server/docs/PRD.md`（需求）+ `architecture.md`（架构，A1–A13）**推倒重写 `packages/server`**；服务器写完之后再更新 `packages/cli` 与 `ai-zen/desktop`（**这一步一个字都没动**）。

## 📊 Current State

- 分支 **`feat/server-rewrite`**（`main` 未动，仍是 `796ad5c`），HEAD **`55c9763`**；`git status` 干净。
- 提交序列：`66fe88d` W1 → `bf2419a` W1-R 纠偏 → `b40edee` W2 → `3dcb95a` W3 → `28b8aeb` W3-F/W4 → `d9ce164` W4-X 总装 → `eabb603` W5 文档+裁定 → `f35440e` W6 → `55c9763` W6-C。
- **规模**：`packages/server/src` 71 个实现文件（约 2.1 万行）+ 58 个测试文件（约 1.5 万行）。
- **验收**：`npx tsc --noEmit -p tsconfig.json` 与 `-p tsconfig.test.json` 均零错误；`npx vitest run` **58 文件 / 679 用例全绿**；`npx tsc -p tsconfig.json` 能产出 `dist/`；真进程冒烟通过（起服务、WS 握手、建 workspace/对话、重启后数据仍在、`run/server.json` 退出后摘掉）。
- `packages/server/bad-src/**` 是改名后的旧实现，**一行未读作依据、一行未改**。
- `packages/sdk` 只加了两处可选字段：`AppConfig.namingModel`、`AppConfig.language`（`dist` 已重建）。
- `packages/core`、`packages/client`、`packages/testing`、`ai-zen/desktop` **未改**。`desktop` 里新开了参照分支 `ref/pre-separation`（指向 `5498691`，分离前最后一个提交），`main` 未动。

## ✅ Completed

1. **存储**（`src/storage/`）：`node:sqlite` + worker 线程 + WAL；`all/get/run/tx(声明式批次)/close`；v1 迁移含 8 张表 + FTS5 `trigram`（中文 3 字以上命中，2 字退化 `LIKE`）；`workspaces.cwd` 唯一、`conversations.agentId/modelId` NOT NULL、`nameIsAuto`、`messages.parentToolCallId`、`notices.conversationId`。
2. **契约**（`src/wire/`）：64 个方法、6 个事件、13 个业务码；JSON-RPC 2.0 为底（不支持批量）；消息/内容段/工具调用/状态/用量**全部直接用 core 的 `AgentNS.*`**（用户硬要求）。
3. **运行时**（`src/runtime/`）：`ScopeRegistry`（懒创建、依赖计数、无依赖后 10 分钟回收、`onAllRecycled`）、`RunRegistry`（忙即拒）、`ChatRunner`（六态、边流边写、中止落 `Aborted`、`reconcile*` 修复、子 Agent 消息落库、cwd 系统注入、结算后回调）、`ConversationStateRegistry`（临时模型/思考档位，只在内存）、`TransientRunner`（临时对话零痕迹）、`ConversationDrafts`（create 不落库）。
4. **接线**（`src/net/`）：一条 WS（RPC + 推送 + 二进制上传）、首帧 `hello` 鉴权（凭证不进 URL）、语言挂连接、事件按对话缓冲到回包后、`run/server.json` 发现文件、`run/token` 本地凭证交付口（0600 尽力而为）。
5. **服务**（`src/services/`）：Workspace/Conversation/Message/Search/Credential/Asset/Config/Agent/Model/Discovery/Completion/Notice/Question/Handoff/AutoNaming/Logger 共 16 个薄服务。
6. **组装**：`ServerApp` 单根显式注入（无单例、无反射）；`createHandlers` 注册 60 个方法 + 4 条桥接（`server.hello`/`setLanguage`/`asset.begin`/`asset.end`），并有「契约全表覆盖」测试钉住；`cli.ts` 提供 `serve` / `token` / `version`。
7. **审计**：一轮全量 PRD §4（70 条）+ L1–L12 + D1–D28 + §5 不做清单的代码级审计，缺口已派单修完（问题对象产生者、子 Agent 回看、cwd 注入、多端事件、空会话、日志落盘、状态栏块、缺省语言、端口三档、升级自检）。

## 📋 Not Completed

1. **cli 与 desktop 未更新**（用户明确要求服务器先写完）——下一步就是它们。
2. 已知缺口（`architecture.md` §9 有登记）：`question` 没有「客户端自造问题」的方法（问题只由服务端产生：交接线、未登记 cwd）；`AutoMigratePlugin` 阈值口径是 SDK 的 `>`、服务端提问用 `>=`（插件已传 `resolveMode: () => null`，永不自动迁移，所以只影响「何时问」）。
3. `docs/plan-questions.md` 里还有若干「实施者自决」条目没被 PM 逐条复核（都不影响可用性，属于口径确认）。

## 🧠 Key Decisions（这轮新定的，别再重开）

- **A1–A13 架构定论**（见 `architecture.md` §1）：单进程、单监听单 WS、契约归服务端、JSON-RPC 2.0 为底、所有连接要凭证（本地靠自动填充无感）、`node:sqlite`、照桌面端三层按需扩展、agent 跑完即弃 + Scope 空闲 10 分钟回收、能力清单每个方法一条。
- **R21（用户当场纠偏）**：消息内容一律用 core 导出，不许自造形状；wire 只能包「非消息事实」的薄外壳。
- **R56–R67**（`plan-server-rewrite.md` §10）：create 不落库、hello 只回能力 id、缺省语言可配、交接线提问由服务端结算后触发、未登记 cwd 走问题对象、撤回回填只给文本 + assetIds、新增 `server.reload`、日志落文件、`statusBlocks` 拼装、端口三档、升级自检。
- **提交纪律**：用户说过「不要自己 commit」，但本轮授权「自己决策」；为不污染 `main`，全部提交落在 `feat/server-rewrite`，**`main` 一个字节没动**。

## ⚠️ Constraints and Preferences

- `AGENTS.md`（用户亲写，不可删改）：改东西前先商量、不替用户做决定、**不要自己 commit**、**不许在代码注释里立规矩**（注释只解释在做什么/为什么）。
- 用户风格：直接、不耐绕弯、厌恶 AI 立规矩；一次只问一个问题。
- 文档语言中文；PRD 用业务语言，实现细节留架构文档。

## 📁 File Index

| 路径 | 用途 |
|---|---|
| `packages/server/docs/PRD.md` | 需求唯一来源（未改） |
| `packages/server/docs/architecture.md` | 架构（已按实现对齐，§9 已知缺口） |
| `packages/server/docs/plan-questions.md` | 实施者自决与待核问题清单 |
| `.ai-zen/plan-server-rewrite.md` | 实施计划 + 波次 + **PM 裁定 R1–R67** + 现状快照 |
| `packages/server/src/**` | 新实现（71 文件） |
| `packages/server/bad-src/**` | 旧实现（待删，用户判定为垃圾） |
| `ai-zen/desktop` 分支 `ref/pre-separation` | 桌面端分离前实现，**架构参照物**（13 文件 1,524 行，写得干净） |

## 🔔 First Step for the Next Agent

```bash
cd /home/ubuntu/projects/ai-zen/agents && git log --oneline -3     # HEAD 应为 55c9763
cd packages/server && npx vitest run                              # 应 679 全绿
```

然后按用户原话继续：**更新 `packages/cli` 与 `ai-zen/desktop`**，让它们对接这条 WS 契约（`packages/server/src/wire/methods.ts` 是唯一契约来源，客户端只 `import type`）。桌面端可参考 `ref/pre-separation` 那套本地实现的分层与交互，但一切数据改为问服务端。

## ❓ 需要用户拍板的两处（本轮 PM 先按实现走）

1. **PRD D25 写「不做发现文件」，实现里有 `<dataRoot>/run/server.json`**：它是单实例判断与「端口退了临时端口」时客户端找得到服务端的唯一真相（A2/D26 需要它）。当前按「留发现文件」实现，PRD 那句「不做发现文件」需要用户改口或要求拆掉。
2. **`packages/server/bad-src/` 何时删**：用户已判「整包是垃圾」，本轮只改名未删（保留参照），删除时机由用户定。
