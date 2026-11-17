# 定性拍板记录

> 这份文件只记一件事：**哪一处代码被定了性、用户怎么拍的、落地要动什么**。
> 流程是硬约束：**我出定性 → 用户拍板 → 才动手**。没有「拍」这一格的不许改。
> 定性分类见 `spec.md` 第三节（A 超出需求 / B 不符合需求 / C 错误 / D 冲突）。

---

## 第一轮：第 7 条「题与死对话」（2026-11-17）

### 前提判词（用户拍板，不由代码推导）

1. **题不落库**。题的生命 = 这一段对话活着的这段时间。
   理由不是「存一行太贵」，是**消费者对不上**：重启后复活的题被答了却没有消费者执行，而且会一直挡着这段对话。
2. **内存里的题是有意义的**（用户：「持久化的题目没任何意义，复活后找不到消费者。但是内存中的题目是有意义的。」）。
3. **题的去处只有两个**：被答了、这段对话没了（含意外死）。**没有第三个**。
   - 由此：「把题关掉、不答，题就消失」这条**不存在**；
   - 由此：不推「题没了」事件 —— 后者由 `conversation.changed` 说。
4. **死对话上答题没有意义**：死对话永远不会变闲，那条待办永远等不到执行。
5. **问不问只看 `autoHandoff`**：开着不问（它自己交班）、关着就继续问。宿主**不判在场** —— 题在内存里挂着，客户端一连接拉一次 `question.list` 就看得到。
6. **交接期间 `deliver` 一律拒**（`busy` / `handoff_in_progress`），用户没有按发送的机会；拒绝发生在目标那一侧，不按来源分人（公理 3）。

### 清单

| # | 位置 | 定性 | 一句话 | 拍板 |
|---|---|---|---|---|
| 1 | `storage/migrations.ts:157` `questions` 表 + `idx_questions_conversation` | A | 落库的第一块砖；这张表一存在，重启后的 `pending` 行就继续挡 `conversation.send`（PRD 4.10 自己点出的硬伤） | **删表 + 删索引**（认可） |
| 2 | `storage/QuestionRepository.ts` 整套 | A | 那张表的 CRUD，含 `listAll`；无独立 test，行为靠三份服务用例顺带钉着 | **整个文件删**（认可） |
| 3 | `services/QuestionService.ts` `ask` 先 `create` 再 `get`、`list` 读库、`blockingQuestions` 读库、答完 `update` 再 `get`、整套「读坏了怎么办」防御层 | B | 把题的**生命**绑给了库的生命；防御层的存在前提是「行的内容是外部可改的文本」 | **题改成进程内对象**（认可），「存码不存句子」保留 |
| 4 | `wire/states.ts:258-272` `QuestionState` 的 `expired` / `cancelled` + `QUESTION_STATES` | A | 全仓零生产者；唯一写 `state` 的是 `create`（`pending`）与 `answer`（`answered`） | **收成 `pending \| answered`**（认可） |
| 5 | `services/QuestionService.ts:475-482` 忙判据 `state !== "idle"` | C | `dead` / `paused` / `busy` 报成同一个 `busy`，会说谎；比需求（「正在干活时答会被拒」）更严 | **删这道统一 pre-check**（认可）。顺序改成：答完 → 判空闲 → 空闲才交接（见 #12） |
| 6 | `services/HandoffService.ts:462` ↔ `QuestionService.ts:478` ↔ `ConversationService.ts:1091` | B | 「能不能立刻接手交接」三处三种形状，`paused` 在 ① 和 ③ 里结论相反 | **收成一处判据**，拒因分四种（认可，见下节） |
| 7 | `PRD.md:805`「死对话上挂着的题也能答、也能执行」 | D | 与 #5 的口径打架：死对话永不闲，待办永不执行 | **文档让步**：删掉那句；**死那一刻清题**（顺带清待办）；不推新事件（认可） |
| 8 | `PRD.md:142` / 4.10「没人在场就不问」 | B（→ 实为文档口径） | 代码里没这条判据 | **代码不动**；文档让步：删掉「没人连着就不问 / 人回来再问」，改成「题在内存里等着，客户端连上拉一次就看到」 |
| 9 | `wire/methods.ts:731` `QuestionListParams.conversationId?` + `QuestionRepository.listAll` | A | 为支持一个需求里明说不做的「全库问题列表」 | **`conversationId` 必填**，`listAll` 与 `state` 过滤一起删（奥卡姆剃刀） |
| 10 | `wire/methods.ts:1779` `HandoffStartParams.questionId?` + `HandoffService.markQuestionAnswered` | B | 同一个问题的第二种答法，第二处写同一格状态，还把 `answeredBy` 抹成 `null`；自己的主路径（`QuestionService.applyEffects`）都不走它 | **删 `markQuestionAnswered` + 契约字段**（好） |
| 11 | `PRD.md:797`「把题关掉、不答，题就消失」 | D | 与「题的去处只有两个」冲突；wire 上也没有关题入口 | **文档让步**：删掉；「关掉」不存在 |
| 12 | 交接期间 `deliver`（`ChatRunner.ts:1552-1557` `mayStart → resumeOutput()`） | C | 交接期间点发送会把闸开开 → 交接收口那一刻消息可能落进旧记忆 | **交接期间 `deliver` 一律拒**（用户「你看着办」） |

### 判据（#6 + #5 + #7 的落地形状）

```
现在能不能立刻接手这一批：
  { ok: true }
| { ok: false, reason: "no_agent" | "working" | "output_paused" | "handoff_in_progress" }
```

- 四个拒因**各说各的**，不许再压成一个 `not_idle` / `conversation_busy`；
- `ConversationService.assertIdle`（换模型 / 换思考档）问的是**另一件事**——「手上有没有活」，按公理 5 只看 `state`，与闸无关。保持现状，但名字与注释要说清它跟交接准入不是一回事。

### 答题的顺序（#5 的落地形状）

1. `ask` 发生在**变闲那一刻**，只摆一道题出来；开输入闸、开输出闸，题挡人靠 `assertSendable`（`question_pending`），**不靠闸**；
2. 用户答**自交接 / 独立交接 / 不交接** → **先把题答完**（去掉、推事件）→ 再判是否空闲；
3. 空闲 → 才走真正的交接逻辑，**这时才关输出闸**；关闸点在**批头**（货已取在手上），不能在投递之前 —— `takeAll()` 回空、迭代器停在闸上，提前关就是死锁；
4. **不空闲** → 不做，**在会话行上留一个待交接标记（带 mode）**，`onIdle` 那一拍看到就做、做完清掉。

### 待落地清单（等用户说「改」）

**代码**

| 文件 | 干什么 |
|---|---|
| `storage/migrations.ts` | 加 v5：`DROP TABLE questions`（索引随表走）+ `ALTER TABLE conversations ADD COLUMN pendingHandoff TEXT`（`NULL` = 没有待办） |
| `storage/QuestionRepository.ts` | 删 |
| `storage/types.ts` | `Question*` 行类型删 |
| `services/QuestionService.ts` | 题改内存对象；`ask` 造对象 + 推事件；`list(conversationId)` 必填；`blockingQuestions` / `assertSendable` 读内存；`answer` 走上面的顺序；删防御层；加「这段对话没了（含死）」的清题入口 |
| `wire/states.ts` | `QuestionState` 收成两格 |
| `wire/methods.ts` | `QuestionListParams.conversationId` 必填、删 `state`；删 `questionId?` |
| `services/HandoffService.ts` | 删 `markQuestionAnswered` + `QuestionMarker`；入口判据换成上面那一处 |
| `services/ConversationService.ts` | `pendingCount` 改问 `QuestionService`（内存）；`assertIdle` 名字与注释说清 |
| `runtime/ChatRunner.ts` | 交接态下 `deliver` 抛 `busy` / `handoff_in_progress`；提供「agent 死了」的现读给清题用 |
| `app.ts` | `onIdle` 先看会话行上的待办；`askHandoffOnIdle` 判据不变（只看 `autoHandoff`） |

**文档**：`PRD.md` 4.10 四处（`805`、`797`、`142`、`812`）+ 4.11 对应行。

**用例**：`QuestionService.test.ts` 三条落库用例删（`落库`、`重开库之后问题与回答都还在`、`list 不给对话就是全库`）；`HandoffService.test.ts` / `ConversationService.test.ts` / `ChatRunner.test.ts` 跟着调；8 个测试文件里的 `DELETE FROM questions` 删掉。

**提交拆分**：① 数据层去表 + 题进内存 → ② 答题顺序与待办 → ③ 交接期间收件与清题 → ④ 文档让步。

---

## 笔记：扫描报告里有几条已经过期

- `host.md` 的 **B1**（`consumption` 词根 8 处）：`6a6c634` 已全仓改完，`grep -rn "consumption\|Consumption" packages/*/src` 现在只剩 `docs/en` 里与计费有关的那处。
- `host.md` 的 **C3**（中断后没有继续的路径）：`3c61380` 让 `mayStart` 开闸顶了一半；「怎么做显式继续」这一整条还没拍。
- `host.md` 的 **A5 / A14 / B10 / C1 / C5** 就是本轮 #4 / #6 / #5 / #10，已拍。

## 本轮之后还没过的

- 宿主扫描还剩约 30 条：C2（回滚水位）/ C4（`push` 抛错登记不回滚）/ C3（继续入口）、D1（`autoHandoff` 缺省 1 ↔ 0）/ D2（阈值 0 两义）/ D4（`conversation_dead` 的注释）、A 13 条（含零消费者的状态观察通道）、B 10 条（含 `handoffs` ↔ `inFlight` 两份交接态）。
- `core.md` 与 `sdk-client-docs.md` 两份报告一条没过。
