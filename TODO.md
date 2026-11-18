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

### 1.1 通知的两处小账（✅ 已做：`2d5d15a` 四档、`1034cd7` 全局通知不再被滤）

- [x] **补「成功」档**：`NoticeLevel` / `NOTICE_LEVELS` 四档。
- [x] **全局通知不该被按会话列时滤掉**：`list({sessionId})` = 那段的 + 全局的；`clear` 的粒度不变。

### 1.2 inbox 未消费部分的持久化与恢复（✅ 已做：`9982b92` / `ff4f3ac` / `16a3a8d` / `6b7e194`）

现状：库里有 9 张表，**没有 `inbox`**；core 的 `inboxAdded` / `inboxTaken` / `inboxCleared` 三事件已就绪但没人接；重启 = inbox全丢。而 PRD 1.2 写着「inbox 要持久化」、4.12 写着「没被处理的那几句话还在等」。

- [x] **迁移 v6**：`inbox` 表（`messageId` / `sessionId` / `source` / `content` / `createdAt` / `seq`），外键级联。
- [x] **宿主写的那半**：三事件逐条落库，写串成一条链（否则「删」可能比「插」先落地）。
- [x] **core 的恢复口子**：`restore(entries)` 原样放回，不重写 `createdAt`、不发 `inboxAdded`。
- [x] **装配时放回**：按 `messageId` 去重，已在消息里的扔掉并删行。
- [x] **收尾不作废**：`markShuttingDown()` 显式标记；用户按杀死才连行一起删。

### 1.3 用户按杀死（✅ 已做：`5f0c6ac` 契约+运行时、`b26ef69` handler、`faaf78f` / `6f2e067` 用例、`33f5670` PLAN 方法表）

`session.kill`：会话行与消息一个字不动（那不是删除），只把 agent 收掉、没消费的条目连库里的行一起作废，落在「死」那一格；交接期间拒；本来就是死的回 `killed: false`（不是错误）。顺序是「先硬着陆再拆桥」—— 反了那条 `inboxCleared` 没人听，行会留成孤行、下次装配又把它放回队列。

### 1.4 `send()`（✅ 已做：`730b902` —— `send` 是原语、`runOnce` 包一层它）

`send()`：投递 + 等到空闲（`state` 到 `idle` 且队列真空），**不关门**；`runOnce()` = `send` + `stop`。两者都只给一次性 agent（常驻会话调 `send` 直接抛）。PRD 4.3 那个「代码现状（欠账）」框已换成这两个口子的说明，CORE §2 / §15 同步。

---

## 2. 之后（功能缺口，需求已经定了）

- [ ] **平级会话阶段 3**（PLAN §12）：超时与 `abort`；`/sessions` 里的「agent 建的」标记；没有 `peer_sessions` 表（血缘在 `sessions.lineage`，这条不变）。
- [ ] **定时器**（PRD 4.4「将来会有」）：只做一件事 —— 往 inbox 投递。能吵醒本来就活着的会话，不能造、不能复活。

---

## 3. 需求本身没定（不是活，别自己拍板）

- PRD **4.14 待定**五条：真异步工具、用量与花销怎么呈现、20MB 与内联上限的缺口、一次性的临时请求带图挂哪、删助手要不要查「还有几段在用它」。
- **题的选择要不要持久化**（4.10）：现在会话复活照样会再问；要「只问一次」就得先定答案存哪。
- **「先算代价、再真做」**：删会话 / 删工作区已经有 `dryRun`，但通用的两步确认还只是目标口径。

---

## 4. 跨仓（不在本仓，动它要装那边的一套）

- [ ] **桌面端 W4**：问答面板 → 完整视图 → 22 项零入口 → 真 GUI 竖切六步（连上 / 流式 / 作答交接问题 / 撤回 / 搜索命中定位 / 置顶）。`desktop/packages/main` 只接了 `chat.questions` / `chat.answerQuestion`。
- [ ] **6 条「有方法、没入口」的契约面**：`config.patch`、`getDiscovery`、`saveMcp` / `deleteMcp`、`agent.*`（6）、`model.*`（7）、`completion.files`、`notice.*`（3）—— 宿主侧都在，消费面在桌面端。
- [ ] **`desktop` 把 `@ai-zen/agents-core` 钉在 `^4.1.0`**，与 `5.0.0-alpha.0` 对不上，会在那边落两份 core。

---

## 5. 工程欠账（不是功能）

- [ ] 兜底治理第二遍：`retry` / `fallback` / `catch` 密集文件还有没过完的（判据是必要性，不是「能删就删」）。
- [ ] 「该说而没说」那批提示（PRD 4.14 最后一条）：删会话 / 删工作区之后确认一句、撞硬线、撤回之后、subagent 结束、附件超限。

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
