# 审计规格（静态扫描的判据）

> 这份文件只服务一件事：给代码**定性**。扫描方**不改代码**，只出报告。
> 口径来自 `PRD.md` / `PLAN.md` / `CORE.md` 与用户当面拍的判词。

## 一、七条公理（任何一处实现先拿它照）

1. **乱序受理**：谁都能在任何时刻往队列塞。**不存在「轮」**：没有一次运行可以被开始、产出、结算、回执；没有「这批是谁发起的」。
2. **通信只有投递，禁止等**。唯一例外是没有第二个触发方的一次性对话（`runOnce` 那一类）。
3. **投递不看关系**：只有「目标在不在、活不活」两问，宿主不判资格。
4. **状态靠观测**：对外只有四格 `dead | busy | idle | paused`；更细的阶段与用量由客户端从事件推，宿主不算、不存、不报。
5. **两处状态不许混**：`state: working | idle`（手上有活没有，只由循环位置改）与输出闸 `outputPaused`（还取不取件）是两件事。
6. **记忆是唯一真相，聚合的原子只能是消息**；列表读取**内存优先，死了才读库**；子 agent 的消息不入库（它是一次同步工具调用，恢复它等于恢复半途的工具调用）。
7. **同一个东西一个名字**，从上到下一致：契约 / core / 宿主 / 客户端用同一个词根，不许中途换概念，也不许把同一个概念在不同层捏成两种形状。

## 二、命名对照表（唯一合法名字）

| 概念 | async-queue（源头） | core `Agent` | 宿主 `ChatRunner` | wire | 客户端 |
|---|---|---|---|---|---|
| 输入闸 | `pauseInput()` / `resumeInput()` / `isInputPaused` | 同名委托；事件 `input:paused` / `input:resumed` | 不暴露 | — | — |
| 输出闸 | `pauseOutput()` / `resumeOutput()` / `isOutputPaused` | 同名委托；事件 `output:paused` / `output:resumed` | 合成进 `status` | `ConversationStatus.paused` | 同 |
| 清空待办 | `clear()` | `clearInbox()`（内含 `inbox.clear()`，事件 `inboxCleared`） | `clearInbox()` | `conversation.clearInbox` | `/clear` → 同一个方法 |
| 终结（以后没有新货） | `done()` / `isDone` | `stop()`（关输入 + 开输出 + `done()`，放干血）/ `kill()`（作废 + `done()`） | — | — | — |
| 对外状态 | — | `state: "working" \| "idle"` | `status: ConversationStatus` | `ConversationStatus` | 同 |
| 中断 | — | `abort()`（掐在途 + 翻上输出闸） | `abort(id)` | `conversation.abort` → `{ signalled }` | 同 |
| 投递 | `push(...)` | `push(input)` | `deliver(id, { content, source, storedContent?, mayStart? })` | `conversation.send` / `postMessage` | `deliver` |
| 记忆读取 | — | `messages` | `messagesOf(id, { toolCallId? })` | `message.list` | 镜像 |

**禁用词**：`consumption`（用 `output`）、`gate`、`hold/release`、`suspend/resume`、`once`/`busy`（core 的状态里）、`queued`、`run.state`、`usage`（事件/快照）、`settle`、`回投`、`轮/段/圈`。

## 三、定性分类（报告里每条必须落到其中一类）

| 类 | 含义 |
|---|---|
| **A 超出需求** | 实现了需求里没有的东西（多余的字段/方法/事件/聚合/兜底/可选参数），且答不出「谁读它」 |
| **B 不符合需求** | 与公理或命名表冲突（换词、双份状态、回投残留、按来源判资格、聚合成一段、按消息数判起名……） |
| **C 错误** | 逻辑本身错：会丢数据、会死锁、会说谎、会漏事件、条件反了 |
| **D 冲突** | 两处实现/文档互相抵触，必须有一方让步（写清「哪一处让步、为什么」） |

## 四、报告格式（每队一个文件，`.ai-zen/scan/<area>.md`）

```
## <area>
### 结论（一句话：这片代码现在的定性）
### 清单
| # | 位置（文件:行 + 符号名） | 类 | 一句话说清问题 | 建议（删/改/改名/合并到哪一处） |
### 命名不一致清单（A/B 里凡是词根不一致的，单列一表）
### 没把握的地方（列出来，别猜）
```

要求：**只读代码、跑 `tsc`/`grep` 与只读检查，不改任何文件，不提交**。报告要能指到行，不要写"某处可能"。
