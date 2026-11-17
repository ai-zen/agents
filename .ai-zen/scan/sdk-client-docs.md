# sdk + client + 文档一致性

扫描对象：`agents@feat/server-rewrite` 的
`packages/sdk/src/**`（重点 `scope/plugins/peers/**`、`runtime/HandoffService.ts`、`agent-plugins/**`、`scope/**`、`runtime/SdkAgent.ts`、`index.ts`）、
`packages/client/src/**`（`client.ts` / `mirror.ts` / `index.ts` / `chunkFrame.ts` / `frames.ts` / `errors.ts` / `testSupport/**`）、
`packages/testing/src/**`；
文档侧对着 `PRD.md` / `PLAN.md` / `CORE.md` 逐条比对（判据见 `.ai-zen/scan/spec.md`）。
只读：读了代码 + 全仓 `grep`（`packages/*/src`，不看 `dist`）。**没跑 `tsc`**（原因见「没把握」第 1 条），没有改代码、没有提交、没有写 `dist/`。

---

## sdk + client + 文档一致性

### 结论（一句话）

**客户端那半边基本是对的**（镜像只有一份、`toolCallId` 分栏只吃事件、从不拿 `message.list { toolCallId }` 去补、`memory_replaced` 整段重拉、没有第二份用量与阶段），
**SDK 那半边有两个洞**：①「自交接」在 SDK 与宿主各写了一套，SDK 那套靠**投一条指令再等 `state:idle`**（公理 2 + PLAN §5.3 都禁），而且有一个能让 `busy` 永不释放、进而把上下文硬线永久让行的竞态；
② SDK 的 `migrate()` 只改内存里的 `agent.messages`，既不落库也不推 `memory_replaced` —— 自动交接那条真路径上的「压缩」重启即失效、界面上看不出、取消时还会把别人的话截掉。
文档那半边**自我打架**：PRD 3.6「交接时要按住」/ PRD 4.5「一开交接就按住」 vs PRD 4.5 第二段 + PLAN §5.3「不按住、不等 idle、没有 suspend/resume」，而代码两边各站一边。

### 清单

| # | 位置（文件:行 + 符号名） | 类 | 一句话说清问题 | 建议 |
|---|---|---|---|---|
| A1 | `sdk/src/runtime/HandoffService.ts:121 onBeforeHandoff`、`:123 onHandoff` | A | 构造选项的两个钩子**生产代码零注入**（宿主 `app.ts:1095 createSdkHandoffService` 只传 handoffDir/skillDirs/client/model/modelConfig/logger），唯一读者是 `HandoffService.test.ts:711-747`；`onMigrated` 有人读（`AutoMigratePlugin.ts:43`→`ChatRunner.ts:2179`），这两格没有 | 删两个钩子；要「交接前后做点什么」用事件/通知，宿主那边本来就有 |
| A2 | `HandoffService.ts:119 minHandoffBytes` + `:230`（默认 `400`）+ `:785 isHandoffFileReady()` | A | 生产零传参；同一个 `400` 与同一条「stat + size >= 400」判定在宿主另有一份（`host/services/HandoffService.ts:123 MIN_HANDOFF_BYTES`、`:997 documentReady`） | 删 SDK 的阈值参数；`documentReady` 只留宿主那一份（SDK 只在 summary 模式落盘，不需要校验） |
| A3 | `HandoffService.ts:136-141 MigrationStrategy`、`:182 defaultStrategy`、`:225`、`:393-405 prune 分支` | A | 生产从不传 `strategy`（只有测试传 `"prune"`），`omit` 是唯一在跑的路径；`prune` 分支物理删历史，与宿主「换记忆一个 tx」正相反 | 删 `MigrationStrategy` 与 prune 分支（见 D3：连 `migrate()` 一起去留要一起定） |
| A4 | `HandoffService.ts:178 FALLBACK_TEMPLATE`、`:243 get handoffDir()`、`:317 createPostMessages()`、`:329 serializeMessages()` | A | 四个公开出口**生产零读者**（只有 `HandoffService.test.ts:236,247` 用后两个）；断点消息真用的是宿主自己那条（见 D4），`handoffDir` 宿主用的是自己的 `handoffDirFor()` | 删这四处；`serializeMessages` 若要留就标成测试件搬进 `test-support/` |
| A5 | `sdk/src/scope/plugins/peers/peerSessionTools.ts:104 PeerSessionSendRejectReason`、`:112 PeerSessionSent`、`:195 SEND_REJECT_HINTS`、`:415 if (!sent.ok)` | A | 这套「结构化拒绝」**在生产不可达**：宿主 `PeerSessionService.send`（`host/services/PeerSessionService.ts:383-397`）在目标不在时**抛** `HostError`，从不回 `{ ok: false }` → 为它写好的两句 hint（「Nothing was sent…do the work here instead」）永远到不了模型 | 二选一，见 D5（建议宿主改成返回） |
| A6 | `peerSessionTools.ts:87-99 PeerSessionStatus.lastMessage / startedAt` | A | 需求只要「问一格」（PLAN A14），这两格是「顺手取一段内容」的**第二条路**（另一条是消息事件/`message.list`）；模型侧 hint 只按 `state` 分支，两个字段没有读者 | 删（摘要若要留，说明它替谁服务；PRD 里没有这一格） |
| A7 | `client/src/mirror.ts:84 SubAgentColumn`、`:95 SubAgentFact`、`:102 MirrorSnapshot`、`:183 snapshot()` | A | ① `SubAgentFact` 与 host `wire/states.ts:109 SubAgentFact` 逐字段相同（宿主已从 `index.ts` 转出）；② `snapshot()` 全仓零调用，`MirrorSnapshot` 只被测试当类型引用；③ `SubAgentFact` 这个名字**没从 `client/src/index.ts` 导出**（`:75` 只导出 `MirrorEvent/MirrorSnapshot/SubAgentColumn`），消费者拿不到 `MirrorSnapshot.roster` 的类型名 | 删 `snapshot()`；`SubAgentFact` 改成 `import type { SubAgentFact } from "@ai-zen/agents-host"` |
| A8 | `client/src/mirror.ts:66 toMirrorEvent()` + `client/src/index.ts:74` | A | 只被 `client.ts:734` 内部调一次，却做成包出口 | 收回为模块内函数（`routeToMirror` 里就一处判断） |
| A9 | `client/src/client.ts:398 mirror(conversationId)` | A | 全仓（含测试）零调用 —— `open()` 已经把镜像交出去了 | 删（要「拿到打开过的镜像」就再看一眼 `open()` 的返回值） |
| A10 | `sdk/src/scope/Scope.ts:157 get plugins()` | A | 全仓零读取（`use()` 是唯一的插件入口，`getPluginById` 有人用） | 删 |
| A11 | `sdk/src/runtime/SdkAgent.ts:47 modelLevel` + `createAgent.ts:117 modelLevel: resolved.level` | A | 注释说「客户端用它把当前生效档标在 `/model` 选择器上」，**没有这个消费者**：宿主自己另算一份（`host/services/ConversationService.ts` 的 `modelSource(row, agent, config)`），全仓零处读 `agent.modelLevel` | 删字段（「哪一级」这件事只留宿主 `modelSource` 一处 —— 见命名表最后一行） |
| A12 | `HandoffService.ts:694-698 pushInstructionRound(): Promise<"idle" \| "paused" \| "dead">` | A | 自造第三套状态词：这里的 `paused` = 这一趟被 abort、`dead` = 循环结束 —— 与四格同字不同义 | 跟着 D1 一起删；留的话改 `boolean`/抛错，别复用那三个词 |
| A13 | `client/src/frames.ts`（重写宿主 `wire/frames` 的判别与拼装）、`client/src/chunkFrame.ts`（重写 `net/UploadReceiver` 的分帧）、`client/src/connection.ts:64-120`（`resolveDataRoot` / `tokenFilePath` / `hostFilePath`） | A | 三份「宿主已有」的逻辑副本。前两份有正当理由（包里写明了：不能 import 宿主运行期），**第三份没有** —— 数据根与 `run/token` / `run/host.json` 的路径规则宿主 `config.ts` 已经算过并导出（`host/src/index.ts:21-28`），客户端又推一遍 | 路径规则收进一个私有共享包（PRD 224「客户端与宿主可共享代码，但禁止发包」就是给这条留的路）；前两份保留但要在注释里指向宿主那份唯一实现 |
| A14 | `client/src/client.ts:369-396 open()`、`:420-436 resync()`、`:777-790 reloadMirror()` | A | 「读 `conversation.state` → `message.list` → `applyReadout` + 替换」这段写了两遍半（`open` 与 `reloadMirror` 逐字相同，`resync` 只差一个 `after`/`mergeFrom`） | 收成一个 `loadSnapshot(id, { after? })`，三处都调它 —— 否则哪天给 `message.list` 加参数，三处会各漂一次 |
| A15 | `packages/testing/src/index.ts:5`、`fake-llm.ts:11,15`、`sdk/src/runtime/HandoffService.summary.test.ts:16` | A | 注释里的 `chunk-parsed` 事件在 core 里**不存在**（CORE §10 叫 `delta`），而 testing 的包注释还写着「这条契约有三个消费者（core 的广播、server 的翻译、CLI 的呈现）」—— server / CLI 这两个名字也已经不存在 | 改成 `delta` 与 host / 客户端；那句「三个消费者」按现在的去向重写 |
| B1 | `HandoffService.ts:700 if (agent.consumptionPaused)`、`:721 agent.on("consumption:paused", …)`；注释 `:636`、`:699` 的 `resumeConsumption` | B | 禁词词根 `consumption`；命名表要求 `isOutputPaused` / 事件 `output:paused`。core 那半边改名之后这三处必须同步，否则 SDK 静默失聪（订阅名对不上就等不到） | 跟 core/sdk 一起改名（一次全仓做，见 D11） |
| B2 | `HandoffService.ts:694 pushInstructionRound()`（调用 `:516`、`:521`、`:644`） | B | **SDK 里唯一的「等一轮」**：往常驻 agent 投一条指令，再等 `state:idle`。违公理 2（通信只有投递，唯一例外是一次性对话）、公理 1（不存在「轮」）、PLAN §5.3（「写完了没有看工具结果…不看状态、不等 idle」）；方法名里就带着禁词「轮」 | 删这一套，SDK 只留「写指令正文」的纯函数（见 D1） |
| B3 | `HandoffService.ts:194 _busy`、`:238 get busy()`、`:422 withBusy()` | B | 「这一段正在交接」这份事实的**第三份记录**（另两份：`host/runtime/ChatRunner.ts:1506 handoffs`、`host/services/HandoffService.ts:460 inFlight`）；`busy` 一词还与四格里的「忙」同字不同义（这里是「交接进行中」）。它确实是 `ContextGuardPlugin.isSuspended` 的输入（`ChatRunner.ts:2158`），语义站得住、名字站不住 | 改名 `handingOff`/`migrating`，并明确「谁才是那份事实」（建议：宿主持有，SDK 只读一个注入的回调） |
| B4 | `HandoffService.ts:352 abort()` + `:145`、`:348` 注释「调用方通常要同时 `agent.abort()`」 | B | 这就是 PRD 378「交接时要把手按住」那套（掐在途 + 翻输出闸），与 PRD 650 / PLAN §5.3「交接不按住它…不需要翻那个开关」直接对立 | 见 D2：SDK 不该教调用方按「中断」来实现交接 |
| B5 | `peerSessionTools.ts:57 PeerSessionState = "busy"｜"idle"｜"paused"｜"dead"｜"gone"`、`:87 PeerSessionStatus.state` | B | 同一个概念（对外那一格）在这里叫 `state`、且比命名表的四格多一格；wire 与客户端一律叫 `status`（`ConversationState.status` / `MirrorSnapshot.status`）。`gone` 其实是「会话行不在」，宿主也是这么实现的（`PeerSessionService.status`：`if (!row) return { state: "gone" }`） | 字段改 `status: ConversationStatus`，`gone` 单独一格（例如 `{ found: false }` 或 `status: null`）——否则「哪一格」与「在不在」混进同一格 |
| B6 | `peerSessionTools.ts:212 SEND_ACCEPTED_HINT`（+ `:166 NO_POLL_HINT`） | B | 回执里先断言「nothing is pushed to me automatically」，紧接着同一句又说「when that session has something for me it calls postMessage on me itself」——两句都是对未来的断言，而且互相打脸（公理 3 + PLAN A15「回执里没有状态、没有『叫醒了没有』、没有结果」） | 只留「收下了 + 进的是那边的待办」+「别轮询」；删掉「nothing is pushed to me」这半句 |
| B7 | `client/src/client.ts:378 new ConversationMirror({ …, status: "dead" })` | B | 四格拿「死」当占位：打开那一刻界面会先看到「死」，而 PRD 4.4 的「死」格带「发话」按钮（客户端据此先复活再投递）—— 一个未读到的状态被报成了最坏的那一格 | 占位用 `null`/`unknown`（四格之外不许借词），`opened` 之后才有一格 |
| B8 | `client/src/mirror.ts:131-146 chunkOf()` | B | 一片增量在 wire 上是 `AgentNS.Delta`、`applyChunk` 的签名却要厂商 `ChatCompletionChunk`，于是客户端负责「包一层 `choices[0]`、`finish_reason` 填 `null`」的搬运 —— 同一件事两种形状，搬错一处就是流式错位 | 见 D8：让 `applyChunk` 吃 `AgentNS.Delta`（wire 上跑的就是它） |
| B9 | `write` 这个工具名硬编码四处：`HandoffService.ts:584`（`supportsSelfHandoff` 判 `tool.function?.name === "write"`）、`HandoffGuardPlugin.ts:63`、`:27 WRITE_TOOLS`、`host/services/HandoffService.ts:126 WRITE_TOOL_NAME` | B | 「写工具叫什么」是 `WriteTool` 自己的事实（`builtin/WriteTool.ts:9 name: "write"`），现在被四个地方各抄一遍；任何一处改名/包装，交接就静默退化成 summary（不报错，只说「降级」） | 由 `WriteTool` 导出一个常量（或直接 `WriteTool.NAME`），四处都引它 |
| C1 | `HandoffService.ts:700-729 pushInstructionRound()`（`sawWorking` 只在 `state:working` 事件里置真） | C | **会挂死**：`setState` 对「同一格」提前返回（`core/Agent.ts:1086 from === next` 就不发事件），所以若订阅这一刻 agent 已经是 `working`（`onIdle` 派发到本函数之间插进了一次投递，中间还隔着 `fileExists` / `readSkillContent` 两次磁盘 IO 与 `push`），就再也看不到 `state:working` → 后面那拍 `state:idle` 被 `if (sawWorking)` 丢弃 → `ended` 永不落定 → `runSelfHandoff` 挂住 → `withBusy` 永不释放 → `busy` 恒真 → `ContextGuardPlugin.isSuspended()` 恒真 → **上下文硬线永久让行**，`AutoMigratePlugin` 也再不触发 | 订阅时先读一次现读值（`agent.state === "working"` 就当已见过）；更彻底的是按 D1/B2 删掉这套等待 |
| C2 | `HandoffService.ts:376-408 migrate()`（`:393-404` 改 `agent.messages`） | C | 只改**内存**：`omit` 标记不落库（宿主 `markCompacted` 只写会话行，`host/services/ConversationService.ts:965`）、不存档旧记忆、不推 `memory_replaced`。而自动交接那条真路径走的就是它（`ChatRunner.ts:2174-2175` 给 `AutoMigratePlugin` 的 `resolveMode` 只在 `autoHandoff === true` 时回 `"self"`）→ 兄弟会话越线后「压过」只写在会话行上，重启后整段历史原样回来（`messages.omit` 列没变），客户端镜像也不会重拉 | 见 D3：SDK 不该有第二套「换记忆」 |
| C3 | `HandoffService.ts:566-574 restoreBeforeHandoff()` 里的 `agent.messages.splice(messageCountBefore)` | C | 拿「记忆长度」当「这一趟写了多少」：交接回合期间任何**别人投进来并已落地**的话都落在水位之上，取消时被静默截掉。比宿主那份更糟：SDK 这条路没调 `beginHandoff`，宿主不知道在交接 → 那几条**已经落库、已经推给客户端**（`message.added` 客户端已折进镜像）→ 内存少一条、库里多一条、界面还显示着 | 不要按长度截；按「这一趟产出的消息 id 集合」精确删（从 `messageAdded` 期间收 id），或干脆把这一趟写成「一份临时记忆」 |
| C4 | `client/src/mirror.ts:216 applyReadout()`（唯一写入 `handoffValue` / `rosterValue` 的地方）；调用点只有 `client.ts:384 / 428 / 783` | C | 「正在交接」与「子 agent 名册」只在 open / resync / `memory_replaced` 才算一遍。**交接开始那一拍没有任何事件**（`host/runtime/ChatRunner.ts:1762 beginHandoff` 只 `handoffs.set` + `flushWrites`，不 emit），于是长时间在线的客户端 `mirror.handoff` 永远是 `null`：PRD 4.5「界面上要直说正在交接」「输入框不能打字、只留中断按钮」这两条走不到。子 agent 名册同理（派遣/结束都不刷新，`mirror.roster` 停在打开那一刻） | 交接开始必须有事件（`conversation.changed` 加一格，或 `state` 里带 `handoff`），客户端据此刷新 —— 见文档表第 4 行 |
| C5 | `client/src/mirror.ts:318-326 delta()` | C | 完全不读 `payload.seq`。wire 那边 `MessageDeltaPayload.seq`（`host/wire/events.ts:66`，`:61-65` 是它的说明）的**唯一文档用途**就是「客户端用它发现漏了一片并在重连后重拉整条」—— 这个消费者不存在 | 见 D6（要么客户端真的用它，要么删 `seq`） |

（A 15 条（A1–A15）、B 9 条（B1–B9）、C 5 条（C1–C5）、D 12 条（D1–D12，见下），合计 41 条。）

**D 类（冲突，写清哪一处让步）**

| # | 位置 | 类 | 一句话说清问题 | 建议（谁让步、为什么） |
|---|---|---|---|---|
| D1 | `sdk/src/runtime/HandoffService.ts:606 runSelfHandoff` + `:694 pushInstructionRound` ↔ `host/services/HandoffService.ts:826 writeBySelfHandoff` + `:905 watchDocumentWrite` | D | **「自交接」有两套实现**，判据、超时、护栏、取消语义全不同：SDK 那套「投一条指令 → 等 `state:idle` → 验盘」，宿主那套「`deliver` → 等那次 `toolFinished`（工具名 + 参数路径）→ 验盘」，还带 5 分钟超时（`HANDOFF_WRITE_WAIT_MS`）。两条都是活的：手动/答题那条走宿主，自动交接那条走 SDK | **让步方：SDK**。理由：PLAN §5.3 明写「看工具结果…不看状态、不等 idle」，公理 2 也禁等；宿主那套已经在真路径上跑，SDK 这套只在自动那一路出现，删掉它两边就一致。SDK 只保留纯函数（`createHandoffInstruction`、`createHandoffFileName`）与 summary 那一条 |
| D2 | `PRD.md:378-384`（「交接时要把手按住（那一次请求临时加一道闸）」）、`:640`（「一开交接就把这段对话按住」）、`:648` 表格「别人的话 ｜ 一条都不进来」↔ `PRD.md:650`（「**交接不按住它**…不需要翻那个开关，也不需要事后翻回来」）、`PLAN.md:§5.3`（「没有 `suspend` / `resume` 编排」）；代码：`sdk/runtime/HandoffGuardPlugin.ts` 有实现但只装在 SDK 那套（`:611 ensureGuard` / `:621 guard.arm`），宿主真路径的插件表里没有它（`host/runtime/ChatRunner.ts:2160-2205`） | D | 「按住」这一个词在 PRD 里同时指两件事：①挡改文件类工具（`HandoffGuardPlugin` 干的）；②翻输出闸让整段对话不收件。文档一半说按、一半说不按，代码两套各站一边；结果是 ①**真路径上没有**（PRD 3.6 那条要求在手动交接上根本没实现），②没人做（谁做谁死，见 core C2） | **让步方：文档 + 代码各让一半**：PRD 378 那段拆成两句 —— ①「工具守卫：交接回合只放行写交接文档」保留，并要求**装在宿主那条真路径上**（今天缺）；②「翻输出闸把人按住」删掉（PLAN §5.3 与 PRD 650 都对，按住 = 永久 paused）。PRD 640/648 那两段一并删 |
| D3 | `sdk/src/runtime/HandoffService.ts:376-408 migrate()` ↔ `host/services/HandoffService.ts:561 runToEnd` / `:630 commitMemory`（`ConversationRepository.replaceMemory` 一个 tx） | D | 「换记忆」两套：SDK 在内存里 omit + 追加断点（不落库、不归档、不推事件），宿主一个事务换记忆 + 存档旧会话 + 推 `memory_replaced`/`created`。公理 6「记忆是唯一真相」在 SDK 那套上退化成「内存真相」 | **让步方：SDK 的 `migrate()` 删**。自动交接只该「告诉宿主：这一段到线了」，由宿主那条路去换记忆（与 `app.ts:1127 askHandoffOnIdle` 同一条）。理由：换记忆要么不改、要么整批成/整批不成，SDK 没有库、也没有会话行 |
| D4 | `sdk/src/runtime/HandoffService.ts:317 createPostMessages()`（`Message.User` + `source:{kind:"system",label:"handoff"}` + 三行正文）↔ `host/services/HandoffService.ts:654-666`（`role: system` + `hidden` + 正文只带路径） | D | 同一件事（交接断点消息）两种形状。PLAN §5.3 与 PRD 3.6 都站在宿主那边（「`role: system` + `hidden`、正文**只带文档路径**」） | **让步方：SDK**（删 `createPostMessages`，或改成与宿主同形并由宿主调它）—— 文档写得很明确，而 SDK 这条只有测试在用（A4） |
| D5 | `sdk/src/scope/plugins/peers/peerSessionTools.ts:112 PeerSessionSent`（`{ok:true}｜{ok:false,reason}`）+ `:415` ↔ `host/services/PeerSessionService.ts:383-397 send()`（抛 `HostError("not_found"/"conversation_dead")`，注释自己写「不是一条『拒绝』返回值」） | D | 同一个 `postMessage` 的失败有两种形状，SDK 那一套（含两句专为模型写的下一步 hint）在生产永远走不到；模型实际拿到的是一句宿主渲染的异常文本，里面没有「别等回音、自己干」 | **让步方：宿主**（按端口契约返回 `{ok:false, reason:"gone"｜"dead"}`）。理由：PRD 4.13「投递失败只回给投递方」+ SDK 那两句 hint 是唯一告诉模型「不会有回音」的话；异常文本里没有这一句，模型会去等。若选另一端，就得删 A5 那四处并把端口签名改成「抛」 |
| D6 | `PLAN.md:§5.4` 表（`state` 事件载荷写 `{ conversationId, state }`）、`PLAN.md:§3` 表（`ConversationSummary.state`）↔ `host/wire/events.ts:139 StatePayload.status`、`host/wire/states.ts:132 ConversationState.status`、`client/src/mirror.ts:104 MirrorSnapshot.status`、`sdk/.../peerSessionTools.ts:87 PeerSessionStatus.state` | D | 同一个概念（对外那一格）三种写法：文档叫 `state`，wire/客户端叫 `status`，SDK 又回到 `state` | **让步方：PLAN 的文字 + SDK 的字段名**（命名表：`ConversationStatus` 就是这一格的名字；客户端已经全按 `status`）。事件名 `state` 保留 —— 它是「换了一格」这件事的名字，不是那一格 |
| D7 | `host/wire/events.ts:61-66`（`seq` 的用途：「客户端用它发现漏了一片」）↔ `client/src/mirror.ts:318 delta()`（不读 `seq`） | D | 一方承诺、一方没有消费者 | **让步方：wire**（删 `seq`）：这条连接是 TCP 上的有序 WS，漏片只可能是断线，而断线即作废、靠 `resync` 补 —— 「漏一片」这个处境不存在。留着它就得让客户端真的做（多一条重拉路径，与「不重放、不 ack」冲突） |
| D8 | `core/src/applyChunk.ts:52 applyChunk(receiver, chunk: ChatCompletionChunk)` ↔ `host/wire/events.ts:37`（「流式增量的载荷是 core 的 `AgentNS.Delta` 原样…`applyChunk` 吃的是同一份」）+ `client/src/mirror.ts:131 chunkOf()` | D | wire 上传的是 `Delta`，`applyChunk` 收的是厂商 chunk，两边说的「同一份」不是同一份 —— 客户端只好每次搬一次形状（`choices[0]` 包一层、`finish_reason` 填 `null`，顺手把 `Delta.finish_reason` 丢掉） | **让步方：core 的 `applyChunk` 签名**（吃 `AgentNS.Delta`）。理由：`applyChunk` 自己的注释就说它处理的是「本片新增了什么」，而那份类型就是 `Delta`；改完之后客户端不再需要 `chunkOf`，也不可能搬错 |
| D9 | `PRD.md:30`、`PLAN.md:§5.4`（「宿主不算用量，客户端自己合计」）↔ `sdk/src/agent-plugins/AutoMigratePlugin.ts:104`、`ContextGuardPlugin.ts:69`（读 `agent.lastUsage.prompt_tokens` 判阈值） | D | 「这一段现在多满了」有两处算法：core 派生一份 `lastUsage` 快照 → SDK 两个插件拿它比阈值；客户端对 `message.usage` 自己求和。「用量」在 SDK 里成了事实源 | **让步方：core 不再给 `lastUsage` 快照**（core 队 B11 已列），SDK 两个插件改成「取最后一条 assistant 消息的 `usage.prompt_tokens`」——同一份事实、同一条消息，不另立第二个 getter，也就不存在第二份口径 |
| D10 | `client/src/connection.ts:64-120`（`resolveDataRoot` / `tokenFilePath` / `hostFilePath`）↔ `host/src/config.ts`（同名的 `resolveDataRoot` / `resolvePaths`，并从 `host/src/index.ts:21-28` 导出） | D | 数据根与 `run/` 下两个文件的路径规则两份实现；PRD D25 说发现文件是唯一真相，而**在哪找它**这件事本身有两份答案 | **让步方：客户端那份规则**（收进一个私有共享包，或让 client 只 `Pick`/复用宿主导出的常量）。PRD 224 已经给了出路：共享代码、不发布 |
| D11 | `CORE.md:29-31,41-52,144,293,311,518,665`（全篇 `pauseConsumption` / `consumptionPaused` / `consumption:*`）↔ 本队 spec 命名表（输出闸一律 `output`）；SDK 依赖点：`HandoffService.ts:700,721` | D | 文档与 core 站在一边，spec 站另一边；SDK 这三处订阅名跟着 core 走，改名要一起改 | **让步方：文档 + core + SDK 一起改名**（spec 是判据，`consumption` 在禁用词表里）。只改一处会让 SDK 静默丢事件 |
| D12 | `PRD.md:556`（四格表：「暂停 ｜ 活着，收话但不动，**能按：继续、杀死**」）↔ `host/wire/methods.ts`（只有 `conversation.abort` / `conversation.clearInbox`，**没有 `conversation.resume`**）、`client/src/client.ts`（同样没有任何「继续」方法） | D | 四格里「暂停」这一格承诺了一个动作，契约与客户端都没有入口；用户按一次中断之后，界面上那个「继续」按钮无处可发 | **让步方：必须补一侧** —— 要么 wire + host + client 补一条 `conversation.resume`（翻回输出闸），要么 PRD 把「继续」改成「重新发一句」。与 core C2 / host C3 是同一件事的第三端 |

### 命名不一致清单

| 概念 | 唯一合法名字（spec 命名表） | 代码里的名字 | 位置 |
|---|---|---|---|
| 输出闸 | `pauseOutput()` / `resumeOutput()` / `isOutputPaused`；事件 `output:paused` / `output:resumed` | `agent.consumptionPaused`、`agent.on("consumption:paused")`；注释里的 `resumeConsumption` | `sdk/src/runtime/HandoffService.ts:700,721,636,699` |
| 对外状态（四格） | `status: ConversationStatus`（`dead｜busy｜idle｜paused`） | `state` + 第五格 `gone`：`PeerSessionState` / `PeerSessionStatus.state` | `sdk/src/scope/plugins/peers/peerSessionTools.ts:57,87` |
| 同一份「对外状态」（文档侧） | `status` | PLAN 的 `{ conversationId, state }` / `ConversationSummary.state` | `PLAN.md §5.4` 表、`PLAN.md §3` 表 |
| 「正在交接」 | 一处事实 | `busy`（SDK）/ `handoffs`（宿主 runner）/ `inFlight`（宿主 service） | `HandoffService.ts:238`、`host/runtime/ChatRunner.ts:1506`、`host/services/HandoffService.ts:460` |
| 一次「投递+等」 | 公理 1：不存在「轮/段/圈」 | `pushInstructionRound()`（名字里就是「轮」） | `HandoffService.ts:694` |
| 「这一趟怎么结束的」 | 四格那四个词只表示对外那一格 | `"idle" ｜ "paused" ｜ "dead"`（本地三值，`paused` = 被 abort、`dead` = 循环结束） | `HandoffService.ts:694-698` |
| 投递失败 | 一种形状 | 端口 `{ ok:false, reason }` vs 宿主 `throw HostError` | `peerSessionTools.ts:112` vs `host/services/PeerSessionService.ts:383-397` |
| 投递成功 | 一种形状 | `{ ok: true }`（端口）/ `{ accepted: true }`（给模型的回执） | `peerSessionTools.ts:112` vs `:416` |
| 写工具的名字 | 由 `WriteTool` 命名一次 | `"write"` 字面量四处 | `HandoffService.ts:584`、`HandoffGuardPlugin.ts:63`、`HandoffGuardPlugin.ts:27 WRITE_TOOLS`、`host/services/HandoffService.ts:126` |
| 子 agent 名册的一行 | 一个名字（host 已导出 `SubAgentFact`） | 客户端又声明一份同名同形的 `SubAgentFact`（且不从包出口导出） | `client/src/mirror.ts:95`、`client/src/index.ts:75` |
| 「那一片增量」的形状 | 一种（`AgentNS.Delta`） | wire 上 `Delta`，`applyChunk` 要厂商 chunk，客户端 `chunkOf()` 搬 | `client/src/mirror.ts:131`、`core/src/applyChunk.ts:52` |
| 「已经结束了」 | 禁用词 `settle` | `SpawnedHost.exited` 的文档写「子进程退出时 settle」 | `client/src/connection.ts:105` |
| MCP 连接状态 | `state` 已被 agent 那一格占住 | `McpConnectionState` / `getState()` / `entry.state` | `sdk/src/types/index.ts:377`、`scope/plugins/mcp/McpConnectionManager.ts:25,91` |
| 「哪一级模型」 | 一处判定 | SDK `resolveModel → modelLevel`（无读者）vs 宿主 `modelSource()` 自己再算 | `sdk/src/runtime/SdkAgent.ts:47`、`host/services/ConversationService.ts` |

### 文档 vs 代码（对照表）

| # | 文档说 | 代码实际 | 让步 |
|---|---|---|---|
| 1 | PRD 3.6「交接时要把手按住：拒绝一切改文件类动作，只放行写这份交接文档」 | 实现有（`HandoffGuardPlugin`），但只装在 SDK 那套；**宿主真路径没装**（`ChatRunner.ts:2160-2205` 插件表里没有它）→ 手动交接期间模型可以随便改代码 | **代码**（补装到宿主那条路） |
| 2 | PRD 4.5「一开交接就把这段对话按住（『暂停』那套语义：收话、但不动）」+ 表「别人的话 ｜ 一条都不进来」 | `ChatRunner.deliver` 完全不看交接态（`host/runtime/ChatRunner.ts:1552`），谁都能投；PLAN §5.3 与 PRD 650 也明说不按住 | **文档**（删这两段）—— 按住的代价是「永久 paused」（core C2） |
| 3 | PLAN §5.3「『写完了没有』看工具结果…**不看状态、不等 idle**」 | SDK `runSelfHandoff` 就是「投一条指令 → 等 `state:idle`」 | **代码**（删 SDK 那套，D1/B2） |
| 4 | PRD 4.5「界面上要直说『正在交接』…输入框不能打字、只留中断按钮」 | `conversation.state.handoff` 只在 `ChatRunner.beginHandoff` 里 `set` 一下，**不发事件**；客户端镜像因此学不到「交接开始了」 | **代码**（补一条事件，或把 `handoff` 折进 `state` 推送）→ C4 |
| 5 | PLAN §5.3「提交点之后是『换记忆』：**一个 `tx`**（`replaceMemory`）…再推 `memory_replaced`」 | 自动交接那条路走 SDK `migrate()`：只改内存、不 tx、不推事件 | **代码**（删 SDK `migrate`，D3/C2） |
| 6 | PLAN §5.3 / PRD 3.6「断点消息：`role: system` + `hidden`、正文只带文档路径」 | SDK `createPostMessages` 造的是 `role: user` + 三行话 | **代码**（D4） |
| 7 | PLAN §5.4 表：`state` 事件载荷写成 `{ conversationId, state }`；§3 表写 `ConversationSummary.state` | wire 是 `{ conversationId, status }` / `ConversationSummary.state` 里装的是 `ConversationStatus` | **文档**（统一写 `status`，D6） |
| 8 | PLAN §7「**子 Agent 那一栏同样是内存**…子 agent 不入库」+「父一死…那些消息一起没了」 ↔ 同节「子 Agent 的话按 `listByParentToolCallId` 单独取」、`host/wire/events.ts:75`「`message.list { toolCallId }` 能取回同一批」 | 子 agent 消息不入库、`parentToolCallId` 恒 `NULL`（host A6）→ 库那一条取法永远空；客户端**没有**去补（`grep toolCallId packages/client/src` 只有归栏），是对的 | **文档**（删 `wire/events.ts:78` 与 `listByParentToolCallId` 那两句；公理 6 站在客户端这边） |
| 9 | PRD 30 / PLAN §5.4「用量由客户端按事件自己推、自己算 —— 宿主不算、不存、不报」 | SDK 两个插件读 `agent.lastUsage` 判阈值（`AutoMigratePlugin.ts:104`、`ContextGuardPlugin.ts:69`） | **代码**（core 不收 `lastUsage`，插件改读消息上的 `usage`，D9） |
| 10 | CORE §9「`sumUsage(agent.messages)` 钉到本次委派的 tool 消息上」 | 公理 4：用量由客户端算，宿主/SDK 不算；客户端镜像也**没有**做这个聚合（只在注释里请 UI 自己求和） | **文档/core**（删 `sumUsage` 那一步；客户端本来就没依赖它） |
| 11 | CORE §4/§5/§10 全篇 `pauseConsumption` / `consumptionPaused` / `consumption:*` | spec 命名表要求 `pauseOutput` / `isOutputPaused` / `output:*`；SDK 三处订阅按 core 的名字写 | **文档 + core + sdk**（一起改名，D11） |
| 12 | PRD 4.4 四格表：「暂停」格能按「继续、杀死」 | 契约与客户端都没有 `resume` | 必须补一侧（D12） |
| 13 | PRD 4.6「结果靠对方用 `postMessage` 说回来…父不追问、不轮询、不等」+ PLAN A14「没有『跑完把结果投回去』这种东西」 | SDK 三个工具与客户端都干净：`postMessage` 回执只有 `{accepted, hint}`、`create_session` 只回 `{sessionId,label}`、`read_session_status` 是显式观测而不是等；**没有回投、没有等** | —（这条守住了，点名：`peerSessionTools.ts:212-220`、`:312-320`、`:416`） |
| 14 | PLAN §5.3「提交与回滚都推 `memory_replaced`，客户端据此 `message.list` 全量整段替换」 | 客户端做了（`client/src/client.ts:764-790`），且拉取期间的事件先攒后补 | —（守住；唯一缺口是同一节第 4 行的「交接开始」没有事件） |
| 15 | `packages/testing/src/index.ts:5`「`chunk-parsed` 的第二参才是 chunk…三个消费者（core 的广播、server 的翻译、CLI 的呈现）」 | `chunk-parsed` 在 core 里不存在（叫 `delta`）；server / CLI 已改名 host / 客户端 | **文档**（A15） |
| 16 | `AGENTS.md`「严禁在代码注释里订立任何规矩…不得写成『永不…』『一律…』『只能…』」 | SDK/client 注释里这类断言很多（如 `peerSessionTools.ts:9-31`「投递不承诺任何未来」、`mirror.ts:228`「子 Agent 那几栏不动」、`HandoffService.ts:337`「source 必须带」） | 记一笔：这些是**给模型/后来者看的判词**，按 AGENTS.md 的口径不该由注释来立 —— 归到「下一轮整理注释」的清单，不单列成缺陷 |

### 没把握的地方

1. **`tsc` 没跑成**：`npx tsc --noEmit` 在本机需要 `packages/sdk`/`client` 的 `node_modules` 与 TS 7 解析链，我没有把握在不写任何文件（`tsconfig.test.json` 会产出 `.tsbuildinfo`）的前提下跑干净，所以本报告的全部结论都是**读码 + grep** 的静态结论，`dist/` 未参与（`client` 与 `sdk` 的 `dist` 我一个新字节都没写）。若需要「编译级」确认，建议派一条只跑 `tsc --noEmit -p tsconfig.test.json` 的活。
2. **「零消费者」都是按 `packages/*/src` grep 的**（排除 `dist`、`node_modules`）。但 `packages/client` 是 `private: true`、由**仓库外的 cli / desktop** 捆进产物（`client/package.json` 描述里就写着），`packages/sdk` 还是发到 npm 的包。所以 A7/A8/A9 那几条（`snapshot()` / `toMirrorEvent` / `client.mirror()`）在**本仓库**里零调用，仓库外可能有 —— 删之前要问接线的人。A1–A4（SDK `HandoffService` 的选项与静态出口）风险小得多：唯一的生产接线点就是宿主 `app.ts:1094`。
3. **C1（等闲挂死）是推演，不是实测**：链条是「`setState` 同格提前返回（`core/src/Agent.ts:1086`）→ 订阅时若已 `working` 就永远等不到 `state:working` → `sawWorking` 不被置真 → 后面那拍 idle 被丢」。要实测得在 `onIdle` 派发与本函数订阅之间插一次投递（窗口里有两处磁盘 IO），我没写用例。方向我认为是确定的；严重度取决于窗口被撞到的频率。
4. **C2（自动压缩不落库）的严重度取决于 `autoHandoff` 的实际分布**：迁移 v4 的 `DEFAULT 1` 让**所有老会话**都读成「开」（host 队 D1），于是这条不只影响兄弟会话。我按代码路径推的，没有起进程验证「重启后历史回来」。
5. **`mirror.ts` 的 `fromSnapshot` 那套「宁可少写」**：`open()` 期间到达、而快照又把那条消息包含在内时，那几片增量会被跳过（注释明说靠下一条 `message.changed` 补回来）。收口一定发 `changed`，所以我认为这是**有界的**（最多错到收口那一刻），没列成 C；但断线 + 丢一条 `changed` 的情形要等下一次 `resync` 才自愈，我不确定是否算「会说谎」。
6. **`resync()` 失败时补的那一批 replay 事件**（`client.ts:797-820`）：`snapshotWhileBuffering` 的 `finally` 不看 `load()` 成败，失败也照样把队列按 `replay: true` 折进镜像，而这一轮并没有落地新快照 —— `fromSnapshot` 还是**上一轮**的集合，于是这几条增量被当成「快照已包含」丢掉，随后 `endReplay()` 清空。窗口很窄（只有失败那一次），且下一次 `resync` 会补回，所以没列类；但它是「失败路径上行为与成功路径不同」的一处，值得在修 C4 时一起看一眼。
7. **`Scope.filter/instantiate` 那一层没展开审**（`scope/**` 的其余插件：builtin / skills / mcp / usertools / subagents 的 discover 与 tool 工厂）。我按「不在这份报告的中心」处理，只抽看了命名（工具名、`call_mcp_tool` 之类）。若要把「sdk 超出需求」做全，`builtin/` 19 个工具与 `mcp/` 的 500 行还有一个独立的工作量。
8. **D5 建议「宿主让步」是我的判断，不是用户拍过的**：反方向的理由也成立（宿主那边抛错能带上 `not_found` / `conversation_dead` 两个不同的码，而端口契约把它们压成一个 `gone`/`dead`）。这条要真人点头。
9. **`client/src/upload.ts` / `settings.ts` / `asset.ts` / `reconnect.ts` 只做了命名与「有没有第二份状态」的抽查**（都没问题），没有逐行审 —— 它们不在本队的必看清单里。
