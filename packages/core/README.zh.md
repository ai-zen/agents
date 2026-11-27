# @ai-zen/agents-core

## 它是什么

`@ai-zen/agents-core` 是 Agent 里唯一跟模型直接打交道的那一层，别的一概不想知道。给它一个
`OpenAI` 客户端、一个模型名、一个消息数组，它就把请求发出去、把模型点名的工具跑掉，并把那个数组
当成唯一的真相。沿途发生的事 —— 一条消息出现、一片流增量、一次工具调用、被人打断、失败 ——
都以事件的形式交出来，谁想接就接。

它没有存储、没有界面、没有文案、没有权限、没有配置：消息写到哪、用户看见什么、用哪个模型，都是
上一层的事。它也不重试、不给错误分类、不替崩溃收拾残局。失败就是挂在出事那条消息上的一个事实。

## 怎么用

```bash
pnpm add @ai-zen/agents-core
```

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({ apiKey: "sk-…", baseURL: "https://api.deepseek.com/v1" });
const agent = new Agent({
  client,
  model: "deepseek-chat",
  messages: [Message.System("Answer in one sentence.")],
  lifetime: "one-shot",
});

const messages = await agent.runOnce({
  content: "What does this package do?",
  priority: "low",
  source: { kind: "user" },
});

console.log(messages.at(-1)?.content);
```

把 `baseURL`、`apiKey` 与 `model` 换成你自己的端点、密钥与模型名，其余一个字都不用动。

分量在两处。`lifetime: "one-shot"` 说这个 Agent 办完这一件事就没了；`runOnce()` 只有这种 Agent
才有，它负责把 Agent 关掉，再把消息交回来。调用里的 `priority: "low"` 意思是「等循环准备取新的
一批时再取」（写 `"high"` 才能插进正在跑的那一批），`source` 说的是这话是谁说的：`{ kind:
"user" }` 是人说的，`{ kind: "agent", label }` 与 `{ kind: "system", label }` 分别是另一个 Agent
与宿主、定时器、外部系统。

想要一个一直活着、随时能再塞一句进去的 Agent，不是这么写；那种形状是下一部分的事。

## 它是怎么拼出来的

下面这些全部出自一个决定：消息数组就是状态，别的东西都只是关于它的事件。没有一份影子副本，没有
快照，没有要对账的 diff。要渲染、要落库的那个调用方手里本来就有全部消息，core 不必猜一个界面想
要什么。

### 队列既是收件箱也是唤醒信号

另造一条通知线 —— 条件变量、定时器、另开一条线程去查 —— 就得让它跟队列保持同步，而这两样总在第一个
bug 上分家。所以只有一个结构：队列在被推入时通知，空着的时候循环就挂在这条通知上。除此之外没有
任何东西被 signal。

```ts
for await (const batch of inbox.asTakeAll()) {
  // a batch is in hand
}
```

```text
start() → outer loop
 └─ wait on the output switch                     ← once, before taking anything
    for await (batch of inbox.asTakeAll())
        state = "working"
        repair history                          ← the only place that looks back
        land this batch (one user message per entry with content, nothing for a key)
        report inboxTaken
        onOuterLoopStart → inner loop → onOuterLoopEnd
        queue empty → state = "idle"
        wait on the output switch                 ← once per batch, at the tail
```

在输出开关上等待有两处 —— 进去之前一次，每批尾部一次。这就是「批与批之间不取走」的实际含义：输出开关
翻上的时候到达的 InboxEntry 留在队列里，看得见条数，可以落库，之后可以恢复。

内循环在「刚才那次响应要了工具」时继续。它是 `while`，不是递归：每递归一层就多一个栈帧、多一份私有
的局部状态，「现在走到第几层」就变得答不出来。一批之内，一次响应要的工具并行执行，结果消息按调用
顺序写进 `messages`，不是按完成顺序。

已经取出来的那一批算已经开始。`pauseOutput()` 从下一批生效，不把它收回：它可能已经落了消息，工具
也可能跑了一半。

### 活着与在干活是两个问题

嘴里说「停」的人，实际想要的大多是四件事之一：干完就走、现在就没了、先搁着、把在跑的掐掉但人还在。
一个动词会把这件事盖起来，所以这些动作由两个正交的答案拼成 —— 停完之后还有没有命，现在要不要掐掉
在途的活。

| 动作             | 干什么                                                                         |
| ---------------- | ------------------------------------------------------------------------------ |
| `start()`        | 起来等 InboxEntry。返回一个只在 Agent 死掉时才 resolve 的 promise，永不 reject |
| `stop()`         | 关上输入开关，让已经排队的 InboxEntry 走完，然后死                             |
| `pauseOutput()`  | 翻上输出开关：从下一批起不再取走。在途的活一概不碰                             |
| `abort()`        | 中止在途的请求与工具，然后翻上输出开关，然后报 `aborted`                       |
| `resumeOutput()` | 翻回输出开关。只动这一个开关，`state` 不碰                                     |
| `kill()`         | 立刻死，排着的一切作废，不做任何收尾                                           |

|                                  | 让它自己收手    | 现在中止在途 |
| -------------------------------- | --------------- | ------------ |
| **以后不再跑**（排队清空或作废） | `stop()`        | `kill()`     |
| **先不跑**（排队留着）           | `pauseOutput()` | `abort()`    |

- `stop()` 与 `kill()` 动的是整条命；`pauseOutput()` 与 `abort()` 动的是下一批。
- `abort()` 必然含着「不再取走」（中止之后没法往下走）；反过来不成立：`pauseOutput()` 不中止任何东西。
- `kill()` 不是更快一点的 `stop()`，它是不处理残余的 `stop()`。
- 六个动作重复调用都是空动作。只有 `send()` 与 `restore()` 会抛：已关门的 Agent 上 `send()` 抛 `closed`，输入暂时关着时抛 `input_paused`；`restore()` 在已关门或 InboxEntry 形状不全时抛。
- `stop()` 与 `kill()` 都不可撤销：死了就死透，复活就是新建一个。
- `start()` 返回的 promise 永不 reject。一次请求失败就是一次请求失败 —— 它落在那条消息的 `error`
  上和 `failed` 事件上，循环接着等下一个 InboxEntry。

输出开关两边都会放行：`resumeOutput()` 翻它，`stop()` / `kill()` 也放掉所有等在它上面的东西。否则
停在暂停上的循环会等一个永远不来的 `resumeOutput()`，`start()` 那个 promise 就永远不 resolve。

### 三个答案，三个地方

手上有没有活、还接不接 `send()`、还取不取走，是三个各自独立的事实，调用方也是分开问的。把它们并成一个
枚举，「暂停」就会同时意味着五件事，每个读代码的人都得猜是哪一件。所以每个事实各占一处，谁也不替
谁说话。

| 处         | 成员                         | 说的是                                      | 谁改它                                                             | 事件                               |
| ---------- | ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| 对外那一格 | `state: "working" \| "idle"` | 手上有没有活                                | 只有循环的位置                                                     | `state:working` / `state:idle`     |
| 输出开关   | `isOutputPaused`             | 还取不取走（`true` = 从下一批起不取）       | `pauseOutput()` / `resumeOutput()`                                 | `output:paused` / `output:resumed` |
| 输入开关   | `isInputPaused`              | 还接不接 `send()`（`true` = `send()` 被拒） | `pauseInput()` / `resumeInput()`；`stop()` / `kill()` 是它的生产者 | `input:paused` / `input:resumed`   |

一句话把两道开关分开：输入开关拦 `send()`，输出开关拦取走。输入开关关着的时候 `send()` 抛 `closed`，而队列与
手上那一批一件不动；输出开关翻上之后不取走，`send()` 照收、InboxEntry 留在队列里。两道开关都不参与 `state`，所以
「不取走期间到的那批跑完了」与「输出仍然不取走」是两个事实，都报得出来。

`state` 只由循环的位置决定，别的什么都不参与：取到一批 → `working`；这批跑完且队列真空 → `idle`。

`stop()` 与 `kill()` 自己把输入开关关上，此后它不再打开：队列已经宣告不会有新 InboxEntry 了，这时候放一条
进去，等于把它交给一个没人取的队列。

- `pauseOutput()` 从下一批生效：手上那一批跑完。
- `abort()` 中止在途的活（请求与工具）并报 `aborted`；Agent 不死，只是输出开关翻上了。死是 `kill()`
  的事。
- 每道开关各有自己的一对事件，当前值从活对象上现读（`agent.isOutputPaused` / `agent.isInputPaused`），
  不放在事件载荷里。
- 没有「出错」这一格：错误是消息上的一个事实，读它的 `status` / `error`。也没有「死」这一格：死就是
  没有 Agent 这个对象。

### 一次性与常驻是两种不同的本事

将来某个时刻才回来的结果，到那一刻必须还有人在收。一次性 Agent 的调用栈那时已经退回去了，那里没有
人 —— 所以两种寿命的差别不在于活多久，而在于它到底能干什么。

|                      | 常驻                             | 一次性                                |
| -------------------- | -------------------------------- | ------------------------------------- |
| 怎么起               | `start()`，起来之后等 InboxEntry | `runOnce()`，寿命塞在调用栈里         |
| 谁给它 `send()`      | 谁都行，多少次都行（`send()`）   | 只有发起它的那一个调用方，而且只一次  |
| 怎么收尾             | 没人再递的时候 `stop()`          | 自己收尾：第二次 `send()` 抛 `closed` |
| 结果将来才回来的工具 | 支持                             | 不支持                                |

最后一行是硬的，而且必须在装配那一步就拒掉，不能等到递结果的时候才发现。

常驻会话也没有「递一条进去再等它闲」这个动作：它随时可能被任何触发方推一条进来，「我等到它闲」没有
可以挂靠的东西。只有一次性 Agent 有一条因果链 —— 调用方自己那一次调用。

### InboxEntry 是数据，不是引用

InboxEntry 要存下来、再读回来，所以两种形状都是纯数据、不带任何活引用；`source` 里同样不许放活的 `Agent`
引用：Agent 带着一个客户端和自己那份消息数组，这两样都过不了一次存储。

```ts
// an entry with content: lands as one user message
interface InboxEntryWithContent {
  messageId?: string; // chosen by the sender, so a client can echo optimistically
  createdAt: string; // filled by core: the moment it arrived
  priority: "high" | "low"; // high: takeable inside the inner loop; low: outer loop only
  source: AgentNS.MessageSource;
  content: AgentNS.MessageContent;
}

// a key: wakes the loop up and lands nothing
interface InboxKey {
  createdAt: string;
  priority: "low"; // the inner loop only looks at high, so a key is never taken there
  content?: undefined;
}
```

`source` 有三种，都是文字：`{ kind: "user" }`，`{ kind: "agent", label }` 指另一个 Agent，
`{ kind: "system", label }` 指宿主、定时器或外部系统。每条 `role: user` 的消息都带一个 —— 宿主注入
的隐藏消息也不例外 —— 于是「这是用户说的」只有一个判据：`source.kind === "user"`。

除 `user` 之外的每种来源，写进 `messages` 时 core 都在正文前面加一行注释 —— 它写出来的就是下面这一行：

```text
// 这条消息来自 <label> 自动推送（<createdAt>）

<the content, unchanged>
```

正文是内容块数组的时候，这行注释变成最前面一个 `text` 块，其余块的位置不动。时间用 InboxEntry 自己的
`createdAt`，不是「现在」：外部通知可能说的是很久以前发生的事，模型得能分辨。

三个事实会报出来，收件箱每变一次就是其中一个：

| 事件           | 载荷      | 什么时候                                                  |
| -------------- | --------- | --------------------------------------------------------- |
| `inboxAdded`   | `entry`   | 放进了一个 InboxEntry                                     |
| `inboxTaken`   | `entries` | 这些 InboxEntry 离开了队列，它们的消息已经写进 `messages` |
| `inboxCleared` | `entries` | 队列被作废（`clearInbox()`），不是被取走                  |

`inboxTaken` 在消息写进 `messages` 之后报，不是之前。进程若在两者之间死掉，「消息写了、InboxEntry 还在队列里」是可以
用 `messageId` 去重的重复，反过来则是消息丢了。

### 修历史修在开头，不修在结尾

循环取下一批之前，把历史修一遍。修在开头而不是在被打断之后立刻修，界面才能显示真相：那半句话和没
回话的工具留在原地，直到 Agent 真的重新开始。这是唯一回头看的地方，它做三件事：把遗留的 `writing` /
`pending` 消息定型，按「丢」的策略删掉不该留的，按「填」的策略补上没配对的工具结果。

判断只用两样东西 —— 消息的 `status`，以及 `tool_calls` 与工具消息的配对 —— 于是中断、失败、崩溃
在这里长得一样。两个策略都是构造选项，表在细节里。

### 事件是事实，钩子是位置

事件说的是「发生了什么」，拦不住；钩子说的是「循环走到这里」，其中四个位置可以拒绝。分开是因为它们
回答的是不同的问题：「让我看见它在干什么」与「决定这件事能不能发生」。把两者并成一个，等于让每个
订阅者都握一张否决票。

能拒的钩子有四个，它们 fail-closed —— 会把活放进来的坏开关不叫开关。其余钩子 fail-open，当作没说过话。
两种都报 `failed`；抛错的插件不能留下一个看着还活着、其实什么都不干的 Agent。

`onOuterLoopStart` 不能拒：这批已经从队列里取出来了，拒了它就没主。关于一批的判决属于 `send()` 之前。

## 细节

### 三个入口

| 入口                          | 干什么                                                                                   | 等不等 |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| `send(input?)`                | 往 inbox 放一个 InboxEntry 就返回；已关门的 Agent 上抛 `closed`；不给 `input` = 只拧钥匙 | 不等   |
| `send(input?, { signal })`    | 需要就先起，递进去，等到闲，交回 `messages`（不关门）                                    | 等     |
| `runOnce(input?, { signal })` | 起、`send`、关门、等到死透，交回 `messages`                                              | 等     |

`sendAndWait()` 与 `runOnce()` 拒掉一切 `lifetime` 不是 `"one-shot"` 的 Agent。`runOnce()` 还拒已经开始
的 Agent，也拒 `messages` 为空且没有正文的调用 —— 没燃料的钥匙发出去是一个空请求。这些都是调用方
代码写错了，所以抛裸 `Error` 而不是 `AgentError`：那几个错误码是给会落到 `message.error`、会被从
存储里读回来的失败用的。

不取走，只读队列：

| 成员           | 给什么                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `inboxPending` | 还没被取走的 InboxEntry，按到达顺序 —— 数组是拷贝，InboxEntry 是同一批对象 |
| `inboxSize`    | 队列里有几条                                                               |

`restore(entries)` 把存下来的 InboxEntry 原样放回去：`createdAt` 不变，不补任何默认值，也不发 `inboxAdded`
（行已经在存储里，恢复不是新变化）。它拒一次性 Agent（寿命在调用栈里，没有「重启之后接着等」这回
事）、已关门或已被杀的 Agent，以及形状不全的 InboxEntry —— 半截 InboxEntry 当场拒掉，不装进队列。

### 修历史的两个策略

| 成员                       | 取值                | 默认     | 决定什么                                                                               |
| -------------------------- | ------------------- | -------- | -------------------------------------------------------------------------------------- |
| `abortedToolRoundStrategy` | `"fill"` / `"drop"` | `"fill"` | 被中断的一组工具调用：留着并补上缺的那条结果（`abortedToolRoundReason`），还是整组删掉 |
| `abortedMessageStrategy`   | `"drop"` / `"keep"` | `"drop"` | 被中断的 assistant 消息：删掉，还是留下已经写出来的那部分                              |

两个都是构造选项。「丢」是真的删 —— 内存和存储里都删 —— 并报 `messageRemoved`；`omit` 是另一件事
（消息还在，只是不再发出去）。

### 事件

每条事件都带 `agent`、`seq`（这个 Agent 自己的计数器，从 1 起，只增）和 `at`。凡是带消息、InboxEntry 或流
增量的，带的就是那个活对象本身，不是拷贝。

| 事件                                                 | 发生了什么                                    | 载荷                                                            |
| ---------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `started` / `stopped` / `killed`                     | 起来了 / 排空之后死了 / 被杀                  | —                                                               |
| `state:working` / `state:idle`                       | 对外那一格到了这个值                          | `from`                                                          |
| `output:paused` / `output:resumed`                   | 从下一批起不取走了 / 又开始取走               | —（现读 `agent.isOutputPaused`）                                |
| `input:paused` / `input:resumed`                     | `send()` 关了 / 又开了                        | —（现读 `agent.isInputPaused`）                                 |
| `aborted`                                            | 有人按了停                                    | —（有没有东西被中止，读消息的 `status`）                        |
| `inboxAdded` / `inboxTaken` / `inboxCleared`         | 来了一个 InboxEntry / 这些被取走 / 队列被作废 | InboxEntry 本身                                                 |
| `messageAdded` / `messageChanged` / `messageRemoved` | 一条消息出现 / 就地变了 / 被删了              | 那条消息                                                        |
| `messageFinished`                                    | 这条消息的这一版是终版，不会再变              | 那条消息                                                        |
| `delta`                                              | 到了一片原始的流增量                          | `chunk` + `source`（`{ message }` 或 `{ subAgent, toolCall }`） |
| `requestSent` / `responseFinished`                   | 请求发出去了 / 这次响应结束了                 | 请求体 / 定型后的消息                                           |
| `turnStarted` / `turnFinished`                       | 一次请求与它引发的工具开始了 / 结束了         | assistant 占位消息，两边是同一个实例                            |
| `toolStarted` / `toolFinished`                       | 一个工具开始了 / 结束了                       | 工具调用 / 结果消息                                             |
| `subAgentStarted` / `subAgentFinished`               | 一次委派开始了 / 结束了                       | subagent 与工具调用                                             |
| `denied`                                             | 钩子拒了，这一次根本没有跑                    | `hook`、`reason`、结构化的 `detail`                             |
| `failed`                                             | 跑了，失败了                                  | 一个 `AgentError`，有的话还有那条消息                           |
| `observerFailed`                                     | 某个订阅者抛了                                | 事件名与错误                                                    |

`seq` 让订阅者判出重复与缺口。`denied` 与 `failed` 是两个名字，因为之后的历史长得不一样：`denied`
一个字都不留，`failed` 留下一条半截的 assistant 消息，`status: "error"`。

订阅是旁路。`on(type, handler)` 返回退订函数；抛错的 handler 当场被接住，报成 `observerFailed`，
不打扰 Agent —— 磁盘满不该打死正在被观察的那次请求。

### 钩子

`use(plugin)` 挂一个插件。钩子说的是循环里的一个位置，不是一个事实（事实是事件）。

| 钩子                                  | 能不能拒      | 位置                                               |
| ------------------------------------- | ------------- | -------------------------------------------------- |
| `onInit`                              | 不能          | 注册之后，与寿命无关                               |
| `onStart` / `onStop` / `onKill`       | 不能          | 寿命的两端                                         |
| `onOutputPaused` / `onOutputResumed`  | 不能          | 输出开关翻了                                       |
| `onAbort`                             | 不能          | 有人按了停（开关本来就翻着也照发）                 |
| `onIdle`                              | 不能          | 对外那一格变成 `idle`                              |
| `onOuterLoopStart` / `onOuterLoopEnd` | 不能          | 一批开始了 / 结束了                                |
| `onInnerLoopStart`                    | 能            | assistant 占位消息还不存在的时候；也允许改写请求体 |
| `onInnerLoopEnd`                      | 不能          | 那次请求结束了                                     |
| `onToolStart`                         | 能            | 工具存在；问要不要跑它                             |
| `onUnknownTool`                       | 能            | 工具不存在；问该回模型什么                         |
| `onToolEnd`                           | 不能          | 工具跑完了（只对存在的工具）                       |
| `onSubAgentStart` / `onSubAgentEnd`   | 只有 start 能 | 委派的边界                                         |

能拒的钩子返回字符串时，那个字符串就是工具消息的正文或拒绝的理由；core 不拿自己的措辞去包它。
`onInnerLoopStart` 在 assistant 占位消息造出来之前跑，所以拒了不会留下一条卡在 `pending` 的消息。

同一个位置上钩子先于事件，只有一个例外：`state:*` 由状态 setter 在 `onIdle` 之前发出，`started` 在
`onStart` 之前发出 —— setter 是同步的边界，订阅者得能在钩子跑之前看见那个值。

### 错误

一个类，同一个实例出现在两处。

```ts
export type AgentErrorCode =
  | "request-failed" // could not connect / no response
  | "stream-failed" // a response came, but the stream broke or did not fit
  | "closed" // the agent is finished: sending will never be taken again
  | "input_paused"; // the input switch is closed right now: wait and send again

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown });
}
```

同一个实例既是 `failed` 事件的载荷，也是它所归属那条消息的 `error`。`{ code, message }` 足够从存储
里把它重建出来（`AgentError.fromJSON()`），`cause` 与 `stack` 留给写那行的人。

错误的文字永远不进 `content`。`content` 是模型说过的话；配上「留」的策略，一条存下来的
`ECONNREFUSED` 会以模型自己说过的话的身份回到模型面前。`role: tool` 的消息是例外：它的 `content`
本来就是模型要读的结果。

core 只分类它知道的那一维（哪一部分失败）。错误可不可重试、401 是不是「密钥错了」、要不要退避、
要不要重试，它一概不判。

### 导出

| 导出                                   | 是什么                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Message`                              | 消息类；`Message.System()`、`Message.User()`、`Message.Assistant()`、`Message.Tool()` 造一条，`id` 与 `createdAt` 由构造函数补 |
| `Tool`                                 | 工具抽象基类：继承它并实现 `exec(ctx): Promise<MessageContent>`；定义放在 `function` 上                                        |
| `CallbackTool`                         | 用一个回调而不是子类定义的工具                                                                                                 |
| `ToolCallContext`                      | 工具收到的东西：`agent`、`tool_call`、`parsedArgs`、`parseError`、`resultMessage`、`signal`                                    |
| `AgentToolLazy`                        | 把一个 Agent 当工具：按需造它、把它的事件转发给父级、跑一次并交回它说过的话                                                    |
| `applyChunk`                           | 一片流增量就地攒进一条消息 —— 这件事唯一的实现                                                                                 |
| `formatContent`                        | 内容块收敛成模型认识的字段；`__` 开头的键与不认识的块丢掉                                                                      |
| `sumUsage` / `addUsage` / `ZERO_USAGE` | 跨消息求和用量：消息自己的 `usage` 加上工具消息的 `subAgentUsage`                                                              |

`Tool.exec` 停不下循环：它返回什么，就是一条交回模型的工具消息。能停的两种办法是钩子拒绝和
`abort()`。

### 不做什么

| 不做                                | 为什么                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| 重试、分类、降级                    | 产品策略；引擎里的重试循环得懂网络、厂商与幂等                |
| 归一厂商错误码                      | 每上一个 provider 就得改一次 core                             |
| i18n                                | 引擎层的文字是英文；语言属于宿主                              |
| 认识 Asset、端点或存储              | 顺着那条线会自己长成一个应用                                  |
| 空闲回收、引用计数、定时器          | 寿命只跟六个动作走                                            |
| 递归的内循环                        | 每层多一个栈，「现在走到第几层」就说不清                      |
| 全局的「已中止」标志或「出错」状态  | 全局标志是 Agent 沦落到需要人工复活的开始；错误是消息上的事实 |
| 错误文字进 `content`                | 模型会把它读成自己说过的话                                    |
| 一次性 Agent 上结果将来才回来的工具 | 没有人留在那里收                                              |

## 测试

```bash
npm run pretest      # tsc --noEmit over src and the tests
npx vitest run       # the suite
```

两条命令都在 `packages/core` 下跑。用例不需要网络，也不需要 API key：模型客户端是传进来的，用例自己
给一个。

## 许可

MIT
