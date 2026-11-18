# TODO —— 还没做的

> 判据看 `PRD.md`（总需求）/ `CORE.md`（内核模型），排期看 `PLAN.md`（总计划）。
> **只列还没做的与明确不做的**；做完的不留勾、不记流水 —— 那是 git 历史的活。

---

## 0. 工作方式（硬约束）

- **先定性、再拍板、后动手**；一个主题一个提交，中文 conventional commits，一行标题说清改了什么。
- **不自己 push**；用户说「推送」才推。
- 跨包改签名后**必须重建 `dist`**，顺序 `core → sdk → testing → client → host`；否则下游拿着老名字在运行时炸掉、错误被吞、表现为超时。
- 每批提交前跑：该包单测 + 五份 `tsc --noEmit`。
- 禁用词（注释、命名、文案一律不许出现）：`consumption`、`gate`、`hold/release`、`suspend/resume`、`once`/`busy` 当状态值、`queued`、`run.state`、`usage`（快照）、`settle`、`回投`、`轮/段/圈`。
- 失败不许用 `.skip` 换绿；测的东西已经不存在的用例直接删。**不许为让测试变绿改生产代码**。

---

## 1. 现在要做（按性价比排）

### 1.1 通知的两处小账（半小时的事）

- [ ] **补「成功」档**：PRD 4.9 是四档（信息 / 警告 / 成功 / 错误），`wire/states.ts` 的 `NoticeLevel` 与 `NOTICE_LEVELS` 只有三档，`NoticeService` 的校验也会把 `success` 挡回去。改：类型 + 取值表 + 校验 + 客户端那条渲染路径 + 用例。
- [ ] **全局通知不该被按对话列时滤掉**：`NoticeService` 列通知时一给 `conversationId` 就把 `conversationId === null` 的全局通知滤掉（PRD 4.9 表格与那条「现在有一处与这条不符」自注都写了：不该滤）。改：按对话列 = 那一段的 + 全局的。

### 1.2 inbox 未消费部分的持久化与恢复（唯一一个「关掉就丢东西」的洞）

现状：库里有 9 张表，**没有 `inbox`**；core 的 `inboxAdded` / `inboxTaken` / `inboxCleared` 三事件已就绪但没人接；重启 = 待办全丢。而 PRD 1.2 写着「inbox 要持久化」、4.12 写着「没被处理的那几句话还在等」。

- [ ] **迁移 v6**：加 `inbox` 表 —— 条目上有什么就存什么（`messageId` / `conversationId` / `source` / `content` / `createdAt`），别另造形状。
- [ ] **宿主写的那半**：三事件落地 —— `inboxAdded` 插行、`inboxTaken` 删行（core 已排在落地之后）、`inboxCleared` 清空。**要实时、逐条 upsert，不攒批**。
- [ ] **core 的恢复口子**：`restore(entries)` 原样放回 —— **不能走 `push()`**（会重写 `createdAt`、也会重发 `inboxAdded`）。
- [ ] **装配时放回**：首次装配 agent 时按 `messageId` 去重放回；**已经在记忆里的那条扔掉**（防重复落地）。
- [ ] **用例**：未消费的三句重启后还在、顺序不变；落地过的被去重；`/clear` 之后库里干净。

### 1.3 `send()`

- [ ] core 补 `send()`：**投递并等到空闲，但不关门**（等的是 `state:idle` 且 inbox 真空）；`runOnce()` 保持原样（跑到头就关机）。PRD 4.3 那个「代码现状（欠账）」框去掉。

---

## 2. 之后（功能缺口，需求已经定了）

- [ ] **平级会话阶段 3**（PLAN §12）：超时与 `abort`；`/sessions` 里的「agent 建的」标记；没有 `peer_sessions` 表（血缘在 `conversations.lineage`，这条不变）。
- [ ] **定时器**（PRD 4.4「将来会有」）：只做一件事 —— 往 inbox 投递。能吵醒本来就活着的对话，不能造、不能复活。

---

## 3. 需求本身没定（不是活，别自己拍板）

- PRD **4.14 待定**五条：真异步工具、用量与花销怎么呈现、20MB 与内联上限的缺口、一次性的临时请求带图挂哪、删助手要不要查「还有几段在用它」。
- **题的选择要不要持久化**（4.10）：现在会话复活照样会再问；要「只问一次」就得先定答案存哪。
- **「先算代价、再真做」**：删对话 / 删工作区已经有 `dryRun`，但通用的两步确认还只是目标口径。

---

## 4. 跨仓（不在本仓，动它要装那边的一套）

- [ ] **桌面端 W4**：问答面板 → 完整视图 → 22 项零入口 → 真 GUI 竖切六步（连上 / 流式 / 作答交接问题 / 撤回 / 搜索命中定位 / 置顶）。`desktop/packages/main` 只接了 `chat.questions` / `chat.answerQuestion`。
- [ ] **6 条「有方法、没入口」的契约面**：`config.patch`、`getDiscovery`、`saveMcp` / `deleteMcp`、`agent.*`（6）、`model.*`（7）、`completion.files`、`notice.*`（3）—— 宿主侧都在，消费面在桌面端。
- [ ] **`desktop` 把 `@ai-zen/agents-core` 钉在 `^4.1.0`**，与 `5.0.0-alpha.0` 对不上，会在那边落两份 core。

---

## 5. 工程欠账（不是功能）

- [ ] 兜底治理第二遍：`retry` / `fallback` / `catch` 密集文件还有没过完的（判据是必要性，不是「能删就删」）。
- [ ] 「该说而没说」那批提示（PRD 4.14 最后一条）：删对话 / 删工作区之后确认一句、撞硬线、撤回之后、子 Agent 结束、附件超限。

---

## 6. 明确不动（别再拿「本仓没人读」当理由）

- [ ] `@ai-zen/async-queue` **一个字不动** —— 它是通用发布包，`backpressure` / `shift` / `[Symbol.asyncIterator]` 与 `agents` 无关。
- [ ] core 的 `started` / `requestSent` 事件、sdk 的 `onBeforeHandoff` / `onHandoff` / `handoffDir` / `Scope.get plugins()`、client 的 `snapshot()` / `toMirrorEvent` / `mirror()`：形状没问题，本仓暂时不用不等于该删。

---

## 7. 收尾要验的（每批都跑）

- [ ] 五份 `tsc --noEmit` 全 0。
- [ ] `core` / `sdk` / `host` / `client` / `testing` 单测全绿；host e2e 全绿。
- [ ] `dist` 按 core → sdk → testing → client → host 重建，重建后再跑一遍宿主用例。
- [ ] 交接取消：核实「交接中投一条条目 + 取消」不会把那条截掉（换水位之后应当天然成立，要有用例钉住）。

---

## 8. 冒出来的想法（未拍板，不是活）

- [ ] `@ai-zen/async-queue`：考虑给它加**插队**（让某一条越过已排队的条目先被取走）。用户 2026-11-18 提的，只到「可以考虑」，没拍板；真要动它就不是「一个字不动」了，先谈清语义（插到队头？还是可有几档优先级？被插队的那批算不算已经取出）。
