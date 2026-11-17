## core + async-queue

扫描对象：`agents@feat/server-rewrite` 的 `packages/core/src/**`（1213 行 `Agent.ts` 为主）与 `async-queue@main`（`src/AsyncQueue.ts` 284 行 / `LinkedQueue.ts` 96 行 / `index.ts`）。
只读：读了代码、`grep`、`tsc --noEmit`（0 错）、并对着**已发布的 dist**跑了几段 `node -e` 复现（`async-queue` 装上的 `1.7.0-alpha.0` 与本仓库 `dist/` 逐字节相同；`core/dist/applyChunk.js` 与 `src` 的关键分支逐行比对过）。没有改任何文件。

### 结论（一句话）

结构（队列即 inbox、取件边界那道闸、名册不参与判断、`state` 与闸分开）是对的，但**中断这条路是断的**（`abort()` 掐不住工具段之后的续圈，而且它关上的闸全仓库没人再打开），**流式攒消息有 4 处会丢数据/污染参数**，**禁用的 `consumption*` 词根与缺失的 `input:*` 事件、无读者的 7 个事件还在**——先修 `abort`+`applyChunk`，再按命名表做一次改名。

### 点名八条的结论

1. **`consumption*` 还在，且是整套**：`consumptionPaused`（`Agent.ts:532`）、`pauseConsumption`（:544）、`resumeConsumption`（:574）、事件 `consumption:paused`/`consumption:resumed`（:258-259）、钩子 `onConsumptionPaused`/`onConsumptionResumed`（:116-118）。→ B1–B4。
2. **`state` 与输出闸确实彻底分开了**：`state` 只有 `setState()`（:1084，唯一写入点 :1086-1087）在改，且只在 `outerLoop` 两处（:787 取到一批、:810 队列真空）；`pauseConsumption`/`resumeConsumption`/`abort` 一格都不碰；`landHigh` 看的是闸、`innerLoops` 看的是 `killed`，没有一处拿闸表达「在不在干活」。唯一毛病是 `state` 是 **public 可写字段**（:302，生产代码无人写、只有测试伪造）→ A8；以及死亡报事件与置 idle 的次序反了 → C3。
3. **`stop()`/`kill()`/`abort()` 的顺序都对**：`stop()` = `pauseInput` → `resumeOutput` → `done`（:493-496），`kill()` = 上面三样 + `clearInbox` + `abortTurn`（:513-519），`abort()` = 翻输出闸 + `abortTurn`（:560-563），和「关输入 + 开输出 + done 放干血」一字不差；`pauseConsumption` 在 `isDone` 时拒绝（:547）正好堵住「暂停中 stop」那道死锁。但：**`abort()` 本身留了两个死口** —— 工具段之后仍会续圈发请求（C1，已实测）、闸关上以后没人翻回来（C2，已 grep 全仓库）；`stop()`/`kill()` 在没 `start()` 过的 agent 上不发事件（C4）。
4. **外循环没有历史残留**（没有 `awaitIntakeOpen`、没有同步 `takeAll` 取件的注释、`for await` 就一句 `asTakeAll()`）；名册清空点在 :785（每批开头），与 CORE §17 一致。**残留都在注释里**：`applyChunk.ts:4,16,42` 还在说 `Agent.parseStreamData` 与 `innerLoopTasks`，`Tools/CallbackTool.ts:20` 还在说 `preventDefault`（A12）。
5. **子 agent 登记（§17）干净**：派遣加点 :426、结束只填 `endedAt`（:441-442，且 `endedAt === null` 才填）、清空 :785；内部唯一读它的是 `findSubAgentEntry`（:732），只用来标记，没有任何判断读它。→ 无 A/B/C，仅两条观察写进「没把握」。
6. **事件表不封闭**：22 个事件里 **7 个全仓库零订阅**（`started`、`inboxAdded`、`inboxTaken`、`inboxCleared`、`requestSent`、`toolStarted`、`subAgentFinished`，其中 `subAgentFinished` 是宿主明确写「不订」的）；同时 `onSubAgentStart` 被拒**不发 `denied`**（C6），`stopped`/`killed` 在未 start 时不发（C4）；一名两义：`started`（agent 活了）vs `subAgentStarted`/`toolStarted`（一次委派/一次调用开始了）。
7. **「算用量」还在**：`Usage.ts` 三件（`ZERO_USAGE`/`addUsage`/`sumUsage`）+ `Message.subAgentUsage`（`AgentNS.ts:106`）+ `AgentToolLazy.ts:99` 写回 tool 消息 + `Agent.lastUsage`（:1155）。「报阶段」干净（`MessageStatus` 挂在活消息上，CORE §4 允许），「记录一次运行」干净（没有任何 run 记录）。
8. **两个闸的用法不是一一对应**：core 只用了 `pauseInput`（而且只当「关门」用）、`pauseOutput`/`resumeOutput`/`isOutputPaused`、`clear`、`done`/`isDone`、`push`、`takeAll(filter)`、`asTakeAll`、`snapshot`、`size`；`resumeInput`/`isInputPaused`/`shift`/`[Symbol.asyncIterator]`/`backpressure`/构造期 iterable 在 agents 里零使用（A6/A7）。core 自造语义两处：把 `QueueInputPausedError` 一律翻成 `AgentError("closed")`，把队列特意分开的「暂时不收 / 永远关了」合成一个码（B12）；把 `isOutputPaused` 改名成 `consumptionPaused`（B1）。反过来队列的 `done`/`clear` 语义 core 用得一板一眼，没有第二层。

### 清单

| # | 位置（文件:行 + 符号名） | 类 | 一句话说清问题 | 建议 |
|---|---|---|---|---|
| A1 | `core/src/Agent.ts:706 parent`、`:709 children`；`Tools/AgentToolLazy.ts:65-66,75,96` | A | 血缘是同一份关系的两处写法，而**唯一读者是测试**（`AgentToolLazy.test.ts:199-207`），core/host/sdk 没有一处读它做判断；收尸只删 `children`，死的子 agent 仍指回父 | 删掉 `parent`/`children`（要「还活着的」就问名册 `endedAt === null`）；至少二选一 |
| A2 | `Agent.ts:472 emit("started")` | A | 全仓库（含测试）零订阅 | 删；或让宿主真的用它报「起来了」 |
| A3 | `Agent.ts:260-262` 事件表 + `:629 emit("inboxAdded")` + `:798 / :1145 emit("inboxTaken")` + `:691 emit("inboxCleared")` | A | 三个事件全仓库零订阅，宿主明确改成「现读 `inboxPending`」 | 见 D2：删事件 + 改注释 |
| A4 | `Agent.ts:198 RequestSentEvent` / `:905 emit("requestSent")` | A | 零订阅；CORE §10「等首字 = requestSent 之后」这一格因此没人能报 | 删，或宿主接上再留着 |
| A5 | `Agent.ts:1138 landHigh(): boolean`（调用处 `:879` 丢弃返回值） | A | 返回值没有读者 | 改 `void` |
| A6 | `async-queue/src/AsyncQueue.ts:122 backpressure(max)` | A | agents 零使用，自家 `AsyncQueue.spec.ts` 也零测试；它既不是闸也不是 `done` | 删（或标成「外部 API」并补 spec） |
| A7 | `AsyncQueue.ts:65 [Symbol.asyncIterator]`、`:86 shift()`、`:44 constructor(iterable)` | A | core 只用 `asTakeAll()`；「取件」有四种形状（`shift`/`takeAll`/迭代器/`asTakeAll`），三种没人用 | 只留 `takeAll` + `asTakeAll`，其余删 |
| A8 | `Agent.ts:302 state: AgentNS.AgentState`（public 字段） | A | 生产代码无人写它（只有 `AgentRegistry.test.ts:98,103` 在伪造），而写它不发事件 → 能让 `state` 说谎 | 改 `private set` + `get state()`（写入只走 `setState`） |
| A9 | `Agent.ts:574 resumeConsumption()`、`:118 onConsumptionResumed`、`:259 consumption:resumed` | A | 除 core 自己的测试外零调用 —— 宿主没有「继续」这个动作，这条事件永远不会发 | 与 C2/D4 一起处置：要么宿主接上，要么删掉这半边 |
| A10 | `Tools/CodeTool.ts:17,38`（`@deprecated`，`new Function(...)`） | A | 零使用，且拿字符串当代码执行 | 删 |
| A11 | `Tools/IndexedSearchTool.ts:11` | A | 零使用（host/sdk/client/testing 都没引用） | 删或明确标为可删的历史工具 |
| A12 | `applyChunk.ts:4,16,42`（`Agent.parseStreamData`、`innerLoopTasks`）、`Tools/CallbackTool.ts:20`（`preventDefault`） | A | 注释指向已经删掉的符号，读的人会去找不存在的东西 | 改成现在的名字（`Agent.runTurn` / 无 / 无） |
| B1 | `Agent.ts:532 get consumptionPaused()` | B | 命名表要求 `isOutputPaused`；这是禁词词根 | 改名（连宿主 5 处引用一起） |
| B2 | `Agent.ts:544 pauseConsumption()` / `:574 resumeConsumption()` | B | 命名表要求 `pauseOutput()` / `resumeOutput()`，且要求是「同名委托」 | 改名 + 保持纯委托 |
| B3 | `Agent.ts:258-259` 事件 `consumption:paused` / `consumption:resumed` | B | 命名表要求 `output:paused` / `output:resumed` | 改名（宿主/sdk 订阅名同步，另队） |
| B4 | `Agent.ts:116-118 onConsumptionPaused` / `onConsumptionResumed` | B | 命名表里没有「闸」这一行钩子；且词根是禁词。事件已经够用了 | 删；要留就改 `onOutputPaused` / `onOutputResumed` |
| B5 | 缺失：core 无 `pauseInput()` / `resumeInput()` / `isInputPaused`，也无 `input:paused` / `input:resumed` | B | 命名表第一行要求 core 同名委托三个方法 + 两个事件，一个都没有 | 补齐三个同名委托 + 两个事件（`stop()`/`kill()` 里翻闸时发） |
| B6 | `Agent.ts:285 const GATE_HOOKS` | B | 禁词 `gate` 出现在标识符里 | 改 `DENIABLE_HOOKS` |
| B7 | `Agent.ts:288-296 interface Turn`、`:326 currentTurn`、`:977-982 abortTurn`、`turn.aborted` | B | 类型名把公理 1 否掉的「一次运行」请回来了（禁词 轮/段/圈）；且 `turn.aborted` 与 `turn.controller.signal.aborted` 是同一事实的两份（只有 `abortTurn` 同时改） | 删 `aborted`，只读 `controller.signal.aborted`；类型改名 `Inflight`/`AbortHandle` |
| B8 | `Agent.ts:1106 let settled` | B | 禁词 `settle` | 改 `fired` |
| B9 | `ToolCallContext.ts:35 ctx.function_call`、`:82-83 FunctionCallContext` | B | 一个概念两种形状（`tool_call.function` 的兼容副本）+ 一类两名；读者只有自家测试 | 删兼容字段与别名 |
| B10 | `Usage.ts:13,20,34`、`AgentNS.ts:106 subAgentUsage`、`Tools/AgentToolLazy.ts:99` | B | core 在做用量聚合并写回消息（公理 4：用量由客户端从事件推）；而转给父的 `delta` 原始片里本来就带着 `usage` 那一片 —— 第二份口径。附注：`AgentToolLazy.ts:99` 在 `finally` 里写，可能给一条正文是「子 agent 没有产出」的 tool 消息记上用量 | 删 `sumUsage`/`addUsage`/`ZERO_USAGE` 与 `subAgentUsage`，客户端镜像自己累加 |
| B11 | `Agent.ts:1155 get lastUsage()` | B | 是「用量快照」，命中禁词表（`usage`（快照））；读者是 sdk 的 `ContextGuardPlugin.ts:69`、`AutoMigratePlugin.ts:102` | core 只给 `messages`，护栏插件自己从里面取最后一条 assistant 的 `usage` |
| B12 | `Agent.ts:620-627 push()` 里把 `QueueInputPausedError` 一律翻成 `AgentError("closed")` | B | 队列特意给了具名错误来区分「暂时不收」与「以后也没有了」（`AsyncQueue.ts:3-10` 的注释就是为这件事），core 第一件事就把它抹平成一个码 | core 若真要暴露「输入闸」就保留两码（`paused` / `closed`）；不然就把 `pauseInput` 私有化，别对外承诺一个分不出的码 |
| C1 | `Agent.ts:994-1003 runTools()` 恒 `return true`；`:876` 只按 `hadTools` 续圈 | C | **abort 落在工具执行期间时不生效**：`runTools` 回来仍是 `true`，内循环接着 `newTurn()` → 再发一轮完整请求。实测：工具跑到一半 `abort()`，`create` 被调第 2 次，一条「第二次请求的回答」照样落进 `messages` | `runTools` 返回 `!turn.aborted`（或续圈前判 `turn.aborted` / 输出闸） |
| C2 | `Agent.ts:560-563 abort()` → `pauseConsumption()` | C | 关上的输出闸**全仓库没有一处再打开**（`resumeConsumption` 除 core 测试外零调用；宿主 `ChatRunner.deliver` 不看闸）→ 用户按一次「中断」，这条会话永久不取件：`push` 照收、`inboxSize` 一直涨、循环停在闸上，对外报的却是「暂停（还能继续）」 | core 的 `abort()` 不该关死闸（掐在途就够），或宿主必须接上「继续」。见 D4 |
| C3 | `Agent.ts:814-815`（先 `emit(stopped/killed)` 再 `setState("idle")`） | C | 实测：`stopped` 那一刻 `agent.state === "working"`；随后一个已死的 agent 还发一条 `state:idle`（宿主 `ChatRunner.ts:1007` 因此会在 `onTerminated` 之后又跑一次 `onIdle`，今天靠 `closed` 守卫挡着，纯属侥幸） | `setState("idle")` 挪到 `emit` 之前；死亡那一刻不再发 `state:idle` |
| C4 | `Agent.ts:491-499 stop()`、`:512-521 kill()`、`:814` | C | `stop()`/`kill()` 在**没 `start()` 过**的 agent 上不发任何事件（实测 `killed=0`、`stopped=0`）—— 事件只挂在外循环出口；同理 `kill()` 之后再 `stop()` 因 `isDone` 提前返回，`onStop` 钩子永远不跑（`:493`） | 事件发在 `stop()`/`kill()` 本体里（或在两处都发并判重）；幂等判据别复用队列的 `isDone` 去代表「已经 stop 过」 |
| C5 | `Agent.ts:378-398 dispatchHook()` | C | 非门钩子返回 string 也会 `return r` **短路后面所有插件**，而这个返回值在 `setState`（:1089-1090）/`stop`（:497）里被丢弃。实测：p1 的 `onIdle` 返回 string → p2 的 `onIdle` 没被调 | 只有 `isGate` 才短路；非门钩子拿到非 undefined 就报 `failed` 并继续问下一个 |
| C6 | `Agent.ts:413-446 dispatchSubAgentHook()` | C | `onSubAgentStart` 被拒时**不发 `denied`**（另两个门 :860 / :1035 都发）→ 宿主对「这次委派被拒」完全无感，CORE §10 那张表就少一格 | 拒时补 `emit("denied", { hook: "onSubAgentStart", reason })` |
| C7 | `applyChunk.ts:114-124`（`{ index, function: {...delta.function}, ...deltaToolCall }`） | C | `...deltaToolCall` 把刚合并好的 `function` 覆盖回去：首片只给 `{name}` 不给 `arguments` 时，下一片拼出 `"undefined{\"p\":1}"`（实测）→ `JSON.parse` 必失败 → 工具静默降级成「参数解析错误: …」回给模型 | 先 `...deltaToolCall`，再单独合并 `function`（`arguments ??= ""`） |
| C8 | `applyChunk.ts:66-67`（`delta_.content[0]`）、`:111-112`（`delta_.tool_calls[0]`） | C | 一片里带两个内容段或两个 tool_calls 时，除了第 0 个全部**静默丢弃**（实测：两个 tool_calls 只留第一个） | 遍历整段数组，按各自 `index` 归位 |
| C9 | `applyChunk.ts:118-121` + `:91-93`；`:84-85` | C | 「先 spread 再 `+=`」让首片自带正文的段拼两遍（实测 `text:"A"` → `"AA"`）；首片带 `image_url` 时 `url += deltaSection.image_url` 得到 `"[object Object]…"`（类型上是 `{url,detail}`，`delta_` 是 `any` 所以 tsc 放过了） | 首片只放声明字段（`index`/`type`），正文一律走 `+=`；`image_url` 取 `.url` |
| C10 | `applyChunk.ts:95-100` | C | `content` 已是段数组时来了一个字符串 delta → `receiver.content = ""`，已攒的段整段消失（实测：`[{type:"text",text:"old"}]` → `"str"`） | 两种形状不许混；要么报错，要么把字符串包成一个 `text` 段 |
| C11 | `Agent.ts:667 await this.waitForState("idle", …)`（`:1102` 现读 `state`） | C | push 之后 `state` 还是 `idle`（`working` 要等外循环头），所以 `runOnce` 的「等闲」**常常立刻通过**——`Agent.lifecycle.test.ts:88-93` 的注释自己承认「刚 push 完就问一次会立刻通过」。今天不炸只因后面还有 `await death` | 等「`state:idle` **且** `inboxSize === 0`」，或等第一批真的开始 |
| D1 | `CORE.md:29-31,41-52,144-150,294,311,518,556,665`、`PRD.md:72,196-200,565`、`PLAN.md:190` 全篇 `consumptionPaused` / `pauseConsumption` / `resumeConsumption` / `consumption:*` ↔ 本队 spec 的命名对照表（输出闸一律 `output`） | D | 文档和代码站在一边，spec 站另一边，两者不能都算对 | **让步方：文档 + core 一起改名**（spec 是判据，`consumption` 在禁用词表里）；宿主/sdk 的订阅名同步（另队） |
| D2 | `Agent.ts:160-175`（`InboxTakenEvent` 注释：「持久化要求 inbox 一有变化就入库」，正文在 :165）↔ `host/src/runtime/ChatRunner.ts:736,957,1671`（「不存镜像，一律现读 `agent.inboxPending`」） | D | 一边给事件编了持久化理由，一边明确不要这些事件 | 让步方：core（删 `inboxAdded`/`inboxTaken`/`inboxCleared` 与那句注释）—— 「事件不是唯一信息源」已经由 `inboxPending` 立住了 |
| D3 | `Agent.ts:311`（「收不收件 = `isInputPaused`」）↔ `Agent.ts:529`（「此刻还收不收件 —— 输出闸的现读」）+ CORE §4 | D | 「收不收件」在同一文件里被用在两个概念上（输入闸 / 输出闸） | 让步方：`:311` 那条注释；两个概念按命名表分别只叫「输入闸（还收不收新货）」「输出闸（还取不取件）」 |
| D4 | `PRD.md:72`、`CORE.md:43-45`（「中断完落在暂停格、**还能继续**」）↔ 实现无「继续」入口（`resumeConsumption` 零调用、`deliver` 不看闸） | D | 需求说「暂停可恢复」，实现只有「暂停」没有「恢复」 | 让步方：**必须补一处**：core 的 `abort()` 不关闸 + 宿主留一个 resume；或 PRD 改成「中断即停，继续 = 重开一轮」。与 C2 同一件事故的两面 |
| D5 | `Agent.ts:472-473`（先 `emit("started")` 再跑 `onStart`）、`:1089-1090`（先发 `state:*` 再跑 `onIdle`）↔ `:405-430`、`:1010-1067`（先钩子、后事件，「钩子在前，事件在后」） | D | 同一份代码里两套次序规矩 | 让步方：`start()` / `setState()` 调换次序，或把「死活边例外」写进 CORE §11 并说明理由 |

（A 12 条（A1–A12）、B 12 条（B1–B12）、C 11 条（C1–C11）、D 5 条（D1–D5），合计 40 条。）

### 命名不一致清单

| 概念 | 唯一合法名字（spec 命名表） | 代码里的名字 | 位置 |
|---|---|---|---|
| 输出闸 | `pauseOutput()` / `resumeOutput()` / `isOutputPaused`；事件 `output:paused` / `output:resumed` | `pauseConsumption()` / `resumeConsumption()` / `consumptionPaused`；事件 `consumption:paused` / `consumption:resumed` | `Agent.ts:532,544,574,258-259` |
| 输出闸的钩子 | 命名表无此行（钩子按位置命名，形状应为 `on<位置>`） | `onConsumptionPaused` / `onConsumptionResumed` | `Agent.ts:116-118` |
| 输入闸 | `pauseInput()` / `resumeInput()` / `isInputPaused`；事件 `input:paused` / `input:resumed` | **不存在**（`pauseInput()` 只在 `stop`/`kill` 里被调，没有对外委托，也没有事件） | `Agent.ts:494,515`、事件表 `:252-262` |
| 能拒的钩子 | 禁用词 `gate` | `GATE_HOOKS` | `Agent.ts:285` |
| 一次请求的中断把手 | 公理 1：不存在「轮/段/圈」 | `Turn` / `currentTurn` / `turn.aborted` / `abortTurn()` | `Agent.ts:288,326,977` |
| 「已经结束了」 | 禁词 `settle` | `settled` | `Agent.ts:1106` |
| 工具调用上下文 | `ToolCallContext`（一个名字，一种形状） | `FunctionCallContext`（别名）+ `ctx.function_call`（`ctx.tool_call.function` 的兼容副本） | `ToolCallContext.ts:35,82-83` |
| 用量 | 禁词 `usage`（事件 / 快照）；公理 4：core 不算 | `lastUsage`（getter）、`sumUsage()`/`addUsage()`/`ZERO_USAGE`、`Message.subAgentUsage` | `Agent.ts:1155`、`Usage.ts:13,20,34`、`AgentNS.ts:106` |
| 「收不收件」这个中文说法 | 只能指一处（输出闸） | `:311` 指输入闸、`:529` 指输出闸 | `Agent.ts:311` vs `:529`（见 D3） |
| agent 活过来 vs 一次调用开始 | 已知一名两义 | `started`（agent 活了）/ `subAgentStarted` / `toolStarted`（一次委派 / 一次调用开始了）；`stopped` 对 `subAgentFinished` | `Agent.ts:254-262` |

### 没把握的地方

1. **事件「发了没人用」是按 `agents` 仓库全量 grep 的静态结果**（`packages/*/src`，排除 `dist`）。宿主桥可能还有我没走到的订阅路（例如自己 `new Agent` 的地方），另外宿主/sdk 是别的队，该不该删这 7 个事件得他们点头。`subAgentFinished` 是宿主注释里**明确写「不订」**的（`ChatRunner.ts:977`），这条我比较确定。
2. **`core/dist/` 是否与 `src/` 逐行同步**：我只核了 `applyChunk.js` 的 5 个关键分支（与 `src` 一致，`tsc --noEmit` 也过），C7–C10 的实证因此对 `src` 成立；`Agent.js` 是早先构建的产物，C1/C3/C4/C5 的实测跑的是它 —— 万一 `src` 比 dist 新，那几条的「实测」要降级为「读码可推」。建议跑一次 `pnpm -F @ai-zen/agents-core build` 再复核（我没跑，因为会写 `dist/`）。
3. **`AsyncQueue.done()` 之后再 `push()`**：库里允许（入队但可能再没人取，`AsyncQueue.ts:93-113` 只拦输入闸不拦 `isDone`），core 靠 `pauseInput()` 挡住了，所以今天不成立。这算不算 C 取决于「done 之后还能不能收」的口径 —— 我没定，也没写进清单。
4. **`LinkedQueue.shift()` 把队列摘空后 `tail` 不退**（`LinkedQueue.ts:44-49`）：因为 `push()` 只在 `head === null` 时整体重置，行为是对的；只有 `takeWhere()` 里专门写了这条（`:67-71`）。我认为不是 bug，但没写专门的边界测试去证。
5. **`abort()` 之后宿主是否会换个新 agent**：我只 grep 到「没有任何地方调 `resumeConsumption`」；`AgentRegistry` 的 `retired` / `settle` / `reconcile` 那条路会不会在某种条件下重建 agent，我看得不够细（那是另一队的地盘）。若确有一条「重装」路把会话救回来，C2 的严重度要降一档，但 D4 依然成立。
6. **§17 名册持活引用**：名册里存的是活的 `Agent`（含它整份 `messages`），`endedAt` 填上后**不摘**，直到下一批开头才 `length = 0`（`:785`），`stop()`/`kill()` 也不清。语义上正是 §17 要的（父要答得出它说过什么），但「跑完就散」这句措辞和「一直攥着直到下一批」有张力，也没人测过内存。我按「不是缺陷」处理，没进清单。
7. **legacy `function_call`（无 id）的委派**：`dispatchSubAgentHook` 用 `tool_call.id ?? ""` 当名册键（`Agent.ts:427`），宿主要按 `toolCallId` 找栏（`ChatRunner.ts:1743`）；两条无 id 的委派会撞成 `""`。我没确认宿主在那种形状下会不会错配，故未列类。
