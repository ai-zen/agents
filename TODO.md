# TODO —— 这一轮重写要改什么

> 这份文件是**唯一清单**：改什么、按什么顺序、为什么改。
> 判据看 `PRD.md`（总需求）/ `CORE.md`（内核模型），排期看 `PLAN.md`（总计划）。
> 每一条都是「定性 → 用户拍板」之后落下来的，逐条理由写在行内；更早的定性过程在 git 历史里。

---

## 进度（2026-11-18）

已完成并提交（按序）：`b4e3965` 三份需求文档定稿 → `84d57a9` core（修 8 处错 / 删与新模型冲突的旧形状 / 恢复 inbox 三事件）→ `8f3693e` sdk（记忆形状只在 SDK 一处算，闸交给宿主）→ `4cd7d30` host（题进内存、判断收一处、交接期间不收件、宿主只落库）→ `f2133f3` host（改名与零调用清理）→ `b9d5ae0` core+client（那一片增量只留 `AgentNS.Delta`）→ `f89aa7c` client+wire（删 `seq`、镜像占位不再借「死」）→ `43499fe` client（三处加载收成一个 `loadSnapshot`）。

**验收状态**：五包 `dist` 按 core → sdk → testing → client → host 重建成功；单测 core 131 / sdk 752 / testing 7 / client 131 / host 848，host e2e 9，全绿；`tsc` 全 0。

**还没做的**（有理由，不是遗漏）：

- 客户端镜像还没消费 `conversation.changed(handoff_started)`：事件已经发了，但 `ConversationMirror` 只在 `applyReadout` 那一刻更新 `handoff`，所以长时间在线的窗口仍然学不到「交接开始了」。PRD 4.5「界面要直说正在交接、输入框不给发、只留中断」差这一跳。
- `MessageListParams.around` / `.includeHidden`：契约字段，消费者在仓库外的桌面端（PLAN W4），**留**。
- `streamWriteIntervalMs`：给测试留的旋钮，**留**，已标注不当契约。
- `docs/zh|en` 里提到 `sumUsage` 的段落是旧口径 —— 周边文档，按约定不动。

---

## 0. 工作方式（硬约束）

- **先定性、再拍板、后动手**；一个主题一个提交，中文 conventional commits（正文写「改前 / 改后 / 为什么」）。
- **不自动 push**；`git add .` 之外不动索引。
- 跨包改签名后**必须重建 `dist`**，顺序 `core → sdk → testing → client → host`；否则下游会拿着老名字在运行时炸掉而错误被吞、表现为超时。
- 每批提交前跑：该包单测 + 五份 `tsc --noEmit`。
- 禁止再造「段 / 轮 / 圈」「一次运行」「结算」「回投」「产出清单」这类概念；禁用词见 `PRD.md` 与 `CORE.md` 的命名对照表。

## 1. 提交顺序

| 序 | 批 | 依赖 |
|---|---|---|
| ① | core | — |
| ② | sdk | ① |
| ③ | host | ①② |
| ④ | client + 协议 + 文档让步 | ③ |

---

## 2. ① core

### 2.1 修错（会丢数据 / 会说谎）

- [ ] `Agent.ts:879-880` 先 `emit(stopped/killed)` 再 `setState("idle")` —— 订阅方在 `stopped` 那一刻读到的是 `working`。**调换次序**。
- [ ] `stop()` / `kill()` 在**没 `start()` 过**的 agent 上不发任何事件（事件只挂在外循环出口）；`kill()` 之后再 `stop()` 因 `isDone` 提前返回，`onStop` 永不跑。**事件发在本体里，自己判重**。
- [ ] 非门钩子返回 string 也会短路后面所有插件，而返回值在 `setState` / `stop` 里被丢弃。**只有 `DENIABLE_HOOKS` 才短路**。
- [ ] `onSubAgentStart` 被拒时**不发 `denied`**（另两道门都发）。**补上**。
- [ ] `applyChunk`：一片带两个内容段或两个 `tool_calls` 时，除第 0 个全部静默丢弃。**遍历数组按 `index` 归位**。
- [ ] `applyChunk`：首片自带正文被 `+=` 拼两遍（`"A"` → `"AA"`）；首片带 `image_url` 时 `url += deltaSection.image_url` 得到 `"[object Object]…"`。**首片只放 `index`/`type`，正文走 `+=`，`image_url` 取 `.url`**。
- [ ] `applyChunk`：`content` 已是段数组时来了字符串 delta → 赋值 `""`，已攒的段整段消失。**两种形状不许混，字符串包成一个 `text` 段**。
- [ ] `waitForState` 在 `state === target` 时立刻通过，而 push 之后 `state` 还是 `idle` → `runOnce` 的「等闲」常常一步通过。**等「`state:idle` 且 `inboxSize === 0`」**。

### 2.2 删（旧形状不适用新模型）

- [ ] `Agent.parent` / `Agent.children` —— 血缘只有名册一份（`CORE.md` §17）；且收尸只删 `children`，死的子 agent 仍指回父。
- [ ] 事件 `inboxAdded` / `inboxTaken` / `inboxCleared` + `InboxTakenEvent` 那句「持久化要 inbox 一变化就入库」—— 与宿主「现读 `agent.inboxPending`、不存镜像」直接冲突。
- [ ] `Tools/CodeTool.ts` —— 没有任何 scope 注册它，且靠 `new Function` 执行字符串。
- [ ] `Tools/IndexedSearchTool.ts` —— 不可达能力（无 scope 注册、无引用）。
- [ ] `ctx.function_call` 与 `FunctionCallContext` 别名 —— 一个概念一种形状。
- [ ] 用量聚合：`Usage.ts` 三件（`ZERO_USAGE` / `addUsage` / `sumUsage`）、`Message.subAgentUsage`、`Agent.lastUsage` —— 公理 4：core 不算、不存、不报用量；客户端从事件推。**连带改** SDK 两个护栏插件（改读最后一条 assistant 消息的 `usage.prompt_tokens`）。

### 2.3 内部改名 / 收紧

- [ ] `GATE_HOOKS` → `DENIABLE_HOOKS`。
- [ ] `Turn` → `Inflight`（`currentTurn` → `inflight`，`abortTurn` 随之）；删 `turn.aborted`，只读 `controller.signal.aborted`。
- [ ] `let settled` → `fired`。
- [ ] `landHigh(): boolean` → `void`（返回值没有读者，方法本来就是 `private`）。
- [ ] `state` 改 `private set` + `get state()` —— 读接口不变，写入只走 `setState`（现在生产代码无人写它，但 public 可写字段能让 `state` 说谎）。
- [ ] `push()` 别把「暂时不收」与「已经关了」压成同一个码。
- [ ] 陈旧注释：`applyChunk.ts:4,16,42`（`Agent.parseStreamData`、`innerLoopTasks`）、`Tools/CallbackTool.ts:20`（`preventDefault`）、`Agent.ts:311`（「收不收件」只指输出闸）。
- [ ] `start()` / `setState()` 的「先事件后钩子」统一成「先钩子后事件」（与别处一致）。

---

## 3. ② sdk

- [ ] `_busy` → `handingOff`；「正在交接」只有宿主一份事实，SDK 只读注入的回调。
- [ ] **闸交给宿主**：SDK 不再调 `agent.resumeOutput()`，交接收口在宿主那一侧开；`onHandoff` 由宿主注入（修「文档写完就开闸、而换记忆在之后」）。
- [ ] 删 `migrate()` —— 第二套换记忆（只改内存、不落库、不存档、不推 `memory_replaced`），自动交接只通知宿主。
- [ ] 删 `MigrationStrategy` 与 `prune` 分支 —— 与「换记忆一个 tx、旧记忆成存档」相反。
- [ ] 删 `createPostMessages()` —— 断点消息的形状是 `role: system` + `hidden` + 正文只带路径。
- [ ] 删 `minHandoffBytes` + `isHandoffFileReady()` —— 与宿主 `documentReady` 是同一判定的两份。
- [ ] 删 `modelLevel` —— 「哪一级模型」只留宿主 `modelSource()` 一处。
- [ ] 删 SDK 的「交接时调用方还要 `agent.abort()`」那套（PRD 的「按住」已作废）。
- [ ] `PeerSessionStatus.state` → `status: ConversationStatus`；`gone` 单列（`{ found: false }` / `status: null`），别混进同一格。
- [ ] 删 `SEND_ACCEPTED_HINT` 里「nothing is pushed to me automatically」那半句（与下一句自打脸，且是对未来的断言）。
- [ ] `write` 字面量四处 → 收成 `WriteTool.NAME`。
- [ ] `postMessage` 失败改成返回 `{ ok: false, reason: "gone" | "dead" }`（宿主让步）—— 那两句 hint 是唯一告诉模型「别等回音」的话。
- [ ] 补「交接开始」这一拍：`beginHandoff` 推一条 `conversation.changed`（或折进 `state` 推送），否则客户端 `mirror.handoff` 永远是 `null`。
- [ ] `applyChunk` 改吃 `AgentNS.Delta`（wire 上跑的就是它）—— 客户端因此不再需要 `chunkOf()`。
- [ ] 数据根与 `run/token` / `run/host.json` 的路径规则收进一处（共享包），客户端不再自己推一遍。

---

## 4. ③ host

### 4.1 第 7 条「题与死对话」（用户已拍板）

前提：**题不落库**，题的生命 = 这段对话活着的这段时间；题的去处只有「被答了」与「这段对话没了（含意外死）」；问不问只看 `autoHandoff`；**交接期间一律不收件**。

- [ ] `migrations.ts`：加 v5 —— `DROP TABLE questions`（索引随表走）+ `ALTER TABLE conversations ADD COLUMN pendingHandoff TEXT`（待交接的 mode，`NULL` = 没有）+ 删 `messages.parentToolCallId` 列与它的索引（库不再有第二种取法）。
- [ ] `migrations.ts` v4：`autoHandoff … DEFAULT 1` → `DEFAULT 0`（旧库不迁移，删掉重来）。
- [ ] 删 `storage/QuestionRepository.ts` 整个文件；`storage/types.ts` 里的 `Question*` 行类型一起删。
- [ ] `QuestionService`：题改成**进程内对象**；`ask` 直接造对象 + 推事件；`list(conversationId)` 必填（删 `listAll` 与 `state` 过滤）；`blockingQuestions` / `assertSendable` 读内存；删掉整套「读坏了怎么办」防御层；加「这段对话没了」的清题入口（死那一刻清题 + 清待办）。
- [ ] `wire/states.ts`：`QuestionState` 收成 `pending | answered`。
- [ ] `wire/methods.ts`：`QuestionListParams.conversationId` 必填、删 `state`；删 `HandoffStartParams.questionId`；`conversation.send` 注释里的 `not_found` 改成 `conversation_dead`，并补「交接期间 `busy` / `handoff_in_progress`」。
- [ ] `HandoffService`：删 `markQuestionAnswered` + `QuestionMarker`；入口判据换成下面那一处判据。
- [ ] **答题顺序**：答完 → 判能否立刻交接 → 能就交接（批头才关输出闸）、不能就在会话行上留待交接标记；`onIdle` 那一拍先看待办，有就做、做完清掉。
- [ ] **判据收成一处**：`{ ok: true } | { ok: false, reason: "no_agent" | "working" | "output_paused" | "handoff_in_progress" }`，这四个词是全仓唯一的一套拒因（换模型 / 换思考档那类「手上有活」的判定复用 `working`，不另起 `not_idle`）；`ConversationService.assertIdle` 只留「手上有活」，名字与注释说清它不是交接准入。
- [ ] `ConversationService`：`pendingCount` 改问 `QuestionService`（内存），不再查表。
- [ ] `ChatRunner.deliver`：交接期间一律拒（`busy` / `handoff_in_progress`）。
- [ ] `ChatRunner` / `ConversationBridge`：回滚水位从「记忆长度」换成「**交接指令的位置**」（按那条消息 id 截）。

### 4.2 补两个动作

- [ ] `conversation.pause`：只翻输出闸、不掐在途；死对话 `{ paused: false }`；交接期间拒。
- [ ] `conversation.resume`：只开输出闸、不投任何东西；死对话 `{ paused: false }`；交接期间拒。

### 4.3 白跑的东西（内部符号，零调用）

- [ ] 删 `ScopeRegistry.get()`、`WsHub.pushTo()`、`ConversationDrafts.size()`。
- [ ] `ReconcileResult` 返回值收成 `AgentNS.Message[]`（删 `repairedIds`）。
- [ ] `AutoNaming` 返回值收成 `void`（删 `AutoNameSkip` 八格与 `skipped`；八格收进测试）。
- [ ] 删 `listByParentToolCallId` + `messages` 表上那条 `parentToolCallId` 索引 + `listByConversation` 里 `AND parentToolCallId IS NULL`（写侧从来没写过这一列）。
- [ ] 「这段对话有几条消息」只留 `countByConversation`，另一处从它派生。
- [ ] `conversationIds(workspaceId?)` / `killAll(workspaceId?)` 收掉「不给 = 全部」的可选分支。
- [ ] `streamWriteIntervalMs` 标注成「给测试留的旋钮」，不当契约。
- [ ] 注释里指向不存在的符号（`AgentRegistry.discard`、`parentToolCallId 列留给旧行`）改掉。
- [ ] wire 与 runtime 重复的形状（`SubAgentReadout`/`SubAgentFact`、`ConversationReadout`/`ConversationState`）改成从一处派生。

### 4.4 命名与双份

- [ ] 删 `HandoffService.inFlight`，用 `ChatRunner.handoffs` 那一个标记答「在不在交接」。
- [ ] `"stale-on-settle"` → `"stale-on-idle"`；`Database.settle()` → `resolveResponse()`。
- [ ] `WsHub`：`PushHold`/`holds`/`hold()`/`release()` → `DeferredPush`/`deferred`/`defer()`/`flush()`；`deliver` → `dispatch`；`send` → `writeFrame`。
- [ ] `AssetService.deliver` → `sendAsset`；`ChatRunner.deliver` 与 `PeerSessionRunner.deliver` 是同一个东西，不改。
- [ ] `queuedIds` / `queuedStored` / `QueuedEntry` → `landingIds` / `landingStored` / `DeliveryEntry`。
- [ ] `AutoNaming.afterTurn()` → `nameIfUnnamed()`。
- [ ] 宿主 `HandoffService` → `HandoffDocumentService`（文件一起改），与 SDK 的 `HandoffService` 分开。
- [ ] 「两处状态」的解释只留 `wire/states.ts` 一处，别处改 `{@link ConversationStatus}`。

---

## 5. ④ client + 协议

- [ ] 打开 / 重连 / `memory_replaced` 三处加载快照合成一个 `loadSnapshot(id, { after? })`。
- [ ] 镜像占位 `status: "dead"` → `null`（四格之外不许借词）。
- [ ] `chunkOf()` 随 `applyChunk` 改签名一起消失。
- [ ] `PeerSessionStatus` / PLAN 里的 `state` 统一成 `status`。
- [ ] 删 wire 的 `MessageDeltaPayload.seq`（不重放、不 ack、断线即作废靠 `resync`）。
- [ ] 删注释里的 `chunk-parsed`（core 里叫 `delta`），以及「三个消费者（core 的广播、server 的翻译、CLI 的呈现）」这类已经不存在的东西。

---

## 6. 文档让步

- [ ] `PRD.md:805` 删「死对话上挂着的题也能答、也能执行」；改成「题只在对话活着时存在，死那一刻跟着没」。
- [ ] `PRD.md:797` 删「把题关掉、不答，题就消失」（没有这第三条去路）。
- [ ] `PRD.md:142` / 4.10 删「没人连着就不问 / 人回来再问」；改成「题在内存里等着，客户端连上拉一次就看到」。
- [ ] `PRD.md:812` 「交接期间照样入队、只是没人取」改成「交接期间不收件，等交接收口再发」。
- [ ] `PRD.md:568` 「界面上只提供暴力中断」改成「界面给暂停 / 继续 / 中断三个；交接期间只给中断」。
- [ ] `PRD.md:556` 四格表里「暂停」那一格现在真的有「继续」按钮了（随 `conversation.resume`）。
- [ ] `PRD.md:650` / 3.6 关于「按住」的两段：只保留「交接回合只放行写交接文档」这一层工具守卫，删掉「翻输出闸把人按住」。
- [ ] PLAN 里 `state` → `status`；`listByParentToolCallId` 那两句删掉。
- [ ] CORE §9 删「`sumUsage(agent.messages)` 钉到委派那条 tool 消息上」那一步。

---

## 7. 明确不动（别再拿「本仓没人读」当理由）

- [ ] `@ai-zen/async-queue` **一个字不动** —— 它是通用发布包，`backpressure` / `shift` / `[Symbol.asyncIterator]` 与 `agents` 无关。
- [ ] core 的 `started` / `requestSent` 事件、sdk 的 `onBeforeHandoff` / `onHandoff` / `handoffDir` / `Scope.get plugins()`、client 的 `snapshot()` / `toMirrorEvent` / `mirror()`：形状没问题，本仓暂时不用不等于该删。

## 8. 收尾要验的

- [ ] 五份 `tsc --noEmit` 全 0。
- [ ] `core` / `sdk` / `host` / `client` / `testing` 单测全绿。
- [ ] `dist` 按 core → sdk → testing → client → host 重建，重建后再跑一遍宿主用例。
- [ ] 交接取消：核实「交接中投一条高优条目 + 取消」不会把那条截掉（换水位之后应当天然成立，要有用例钉住）。

---

## 9. 冒出来的想法（未拍板，不是本轮的活）

- [ ] `@ai-zen/async-queue`：考虑给它加**插队**（让某一条越过已排队的条目先被取走）。用户 2026-11-18 提的，只到"可以考虑"，没拍板；真要动它就不是「一个字不动」了，先谈清楚语义（插到队头？还是可有几档优先级？被插队的那批算不算已经取出）。
