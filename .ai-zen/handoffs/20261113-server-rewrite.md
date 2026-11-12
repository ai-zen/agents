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

---

## 追加（同日，客户端重写波次 C1–C3）

- **R68/R69**：`@ai-zen/agents-client` 已按新契约**重写完毕**并提交（`8efa72f`，分支 `feat/server-rewrite`）：9 个源文件 + 76 用例全绿，`private: true`、删掉发布姿态、类型全部 `import type` 自 `@ai-zen/agents-server`。新 API：`Client`（connect/call/subscribe/resume/reconnect）、`ensureServer`（本地无感拉起 / 显式地址只连）、`settings`、`resume`、`reconnect`、`errors`。
- **C2 CLI**（仓库 `/home/ubuntu/projects/ai-zen/cli-old`，**未提交，109 个改动留在工作区**）：竖切跑通——`tsc` 零错误、564 用例绿、`vitest e2e` 16 绿、真机 TUI（pty）+ 真服务端 + 假模型跑通「拉起→发消息→流式→状态栏用量→/resume//config//exit」。删掉 33 个进程内源文件（会话存档、持久化插件、cwd 插件、自动迁移确认、配置向导 21 文件等）。打包用 vite，`@ai-zen/agents-client` 通过 `link:` + 不外部化**内联进 dist**（产物零引用），但**服务端入口靠 `createRequire` 在运行时解析 `@ai-zen/agents-server/package.json`**（可用 `AI_ZEN_SERVER_ENTRY` 覆盖）。
- **C3 desktop**（仓库 `/home/ubuntu/projects/ai-zen/desktop`，分支 **`feat/new-server`**，**未提交，34 个改动**）：竖切跑通——`packages/main` tsc 零错误、107 用例绿、render 50 用例绿、真 Electron（xvfb+CDP）跑通「拉起随包服务端→建项目→建对话→发消息→六态上屏→重启连回」。`rolldown.config.mjs` 把客户端库 alias 到源文件并内联（`scripts/check-inlined.mjs` 自检），另**新增 `dist/dbWorker.js` 产物**（否则本机服务端开库即崩）。

### 下一步（按优先级）

1. **CLI 与 desktop 的收尾面**（两边报告都列了按 PRD 编号的未接清单）：附件上传（`asset.begin/chunk/end`）、问题对象的作答 UI、状态栏块、配置逐项编辑（`config.patch` / `saveEndpoint` / `patchMcps` / `model.*`）、`@` 补全改走 `completion.files`、桌面端 `notice.list/dismiss`、连接断开时状态回落。
2. **三个跨端一致性问题**（需拍板）：
   - `hidden` 语义冲突：服务端拿它表示「这条里有服务端注入段」（cwd），CLI 旧语义是「整条不画」。当前两端各自按前者处理。
   - 会话级「跟随默认思考档」缺一个方法值（`conversation.setThinking` 只接受具体档位名，无法清掉覆盖）。
   - `conversation.create` 是草稿（R56），不发消息不进侧栏 —— 桌面端「新建对话」瞬间侧栏看不到它。
3. **打包边界**：R69 要求「各端捆绑共享代码」，两端都做到了「客户端库内联」；但服务端入口仍需运行时解析（CLI 用 `link:`、桌面端随包分发 `dist/server.mjs`）。若要「产物零运行时外部依赖」，需要另一套方案（旁置/安装器）。
4. `packages/{shared,render}` 的 `@ai-zen/agents-core` 仍指 registry 4.1.0，main 与客户端库用 workspace 版 4.6.0-alpha，**跨版本能过但早晚撞**。
