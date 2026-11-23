---
title: Core API
description: 内核：怎么跑起来、边界、六个方法、一次性与常驻的差别、两个循环、两道开关、inbox 与它的三条事件、在循环开头修历史、事件表、钩子、AgentError，以及它不做的事。
outline: deep
---

# Core API

`@ai-zen/agents-core` 是内核。它的产物只有两样：一个 `Agent` 手上的那个消息数组，以及它跑着的时候发生的事实，以事件交出去。没有存储，没有界面，没有文案，没有权限，没有配置。

它跑在官方 `openai` 包上：一个 `OpenAI` 客户端、一个模型名、一个消息数组，构造一个 `Agent` 需要的就是这三样。

```bash
pnpm add @ai-zen/agents-core
```

## 怎么用

构造、递一条、等一批，二十行：

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o",
  messages: [Message.System("Answer in one sentence.")],
});

// on() returns the unsubscribe function; the handler receives the live message
const offFinished = agent.on("messageFinished", ({ message }) => {
  if (message.role === "assistant" && message.content) console.log(message.content);
});

// resolve when one batch is done and the queue is empty
const idle = new Promise<void>((resolve) => {
  const offIdle = agent.on("state:idle", () => {
    offIdle();
    resolve();
  });
});

agent.send({ content: "What does this package do?", priority: "low", source: { kind: "user" } });

void agent.start();  // resolves only when the agent is dead
await idle;          // the batch in hand finished
agent.stop();        // drain what is queued, then die
offFinished();
console.log(agent.messages.at(-1)?.content);
```

构造要三样：一个 `OpenAI` 客户端、一个模型名、起步那几条消息。`send()` 往队列里放一条就返回，不等；`start()` 起来跑，它返回的 promise 只在 `Agent` 死的时候才 resolve，所以不能排在 `stop()` 之前 await；等一批就是等 `state:idle`，那条事件的载荷只说到了哪个值，当前值从 `agent.state` 读。收尾是 `stop()`：排空队列再死。

接下来通常按这个顺序往上加：一次只跑一遍用 `runOnce()`（见[一次性与常驻](#一次性与常驻)）；工具是 `Tool` 的子类，挂到构造选项上；要落库就订 `inboxAdded`、`messageFinished`、`failed` 三条；要能力发现、模型解析、交接与唤醒，别在内核这一层做，往 [SDK](sdk.md) 走 —— 只要能力、不要运行时的话，见[只用 core 与 Scope](scope.md)。

## 知道什么、不知道什么

| 必须知道 | 不许知道 |
|---|---|
| 消息、工具、模型请求、流、用量、中断、排队、委派 | 存储、多端、i18n、权限、界面、谁在听、能力怎么装配、模型怎么解析、Asset 怎么变成真东西 |

这张表是任何「内核该不该知道 X」的判断题唯一的尺子：先看 X 在不在左栏。右栏里进来任何一样，内核都会沿着它长成一个应用。

判据可以收紧成一句：把 sdk 与宿主都删掉，只留内核配一个假模型客户端，一个 `Agent` 仍然跑得完 —— 取走 `InboxEntry`、发请求、收流、跑工具、发事件、回到闲。

它连自己叫什么都不知道：构造时给一个 `id`，内核只拿它写错误消息与日志，不参与任何逻辑。

## 六个方法

| 方法 | 干什么 |
|---|---|
| `start()` | 起来等 `InboxEntry`。返回一个只在 `Agent` 死掉时才 resolve 的 promise，永不 reject |
| `stop()` | 关上输入，让已经排队的走完，然后死 |
| `pauseOutput()` | 翻上输出开关：从下一批起不再取走。在途的活一概不碰 |
| `abort()` | 中止在途的请求与工具，然后翻上输出开关，然后报 `aborted` |
| `resumeOutput()` | 翻回输出开关。只动这一个开关，`state` 不碰 |
| `kill()` | 立刻死，排着的一切作废，不做任何收尾 |

「停」是两个正交问题的组合：停完之后还有没有命，以及现在要不要中止在途。

| | 让它自己收手 | 现在中止在途 |
|---|---|---|
| 以后不再跑（排队清空或作废） | `stop()` | `kill()` |
| 先不跑（排队留着） | `pauseOutput()` | `abort()` |

- `stop()` 与 `kill()` 动整条命；`pauseOutput()` 与 `abort()` 动下一批。
- `abort()` 必然含着「不再取走」：中止之后没法往下走。反过来不成立 —— `pauseOutput()` 不中止任何东西。
- `kill()` 不是更快一点的 `stop()`，它是不处理残存的 `stop()`。
- 六个方法重复调用都是空动作。只有 `send()` / `restore()` 会抛：`send()` 在已关门时抛 `closed`、在输入暂时关着时抛 `input_paused`；`restore()` 在已关门或 `InboxEntry` 形状不全时抛错。
- `stop()` 与 `kill()` 都不可撤销：死了就死透，复活就是新建一个。
- `start()` 返回的 promise 永不 reject。一次请求失败就是一次请求失败 —— 它落在那条消息的 `error` 上与 `failed` 事件上，循环接着等下一个 `InboxEntry`。

输出开关两边都放行：`resumeOutput()` 翻它，`stop()` 与 `kill()` 也放掉所有等在它上面的东西。少掉后面这一半，停在暂停上的循环会等一个永远不来的 `resumeOutput()`，`start()` 那个 promise 就永远不 resolve。

`stop()` 与 `kill()` 的顺序是定死的：先翻开关与关门，再跑钩子，最后才说「死」。于是订阅方听到 `stopped` / `killed` 时，开关、队列、`state` 三样都已经是死后该有的样子。

## 一次性与常驻

寿命在构造时定下（`lifetime: "resident" | "one-shot"`，缺省常驻）。它不只是活多久的差别，还是能干什么的差别。

| | 常驻 | 一次性 |
|---|---|---|
| 怎么起 | `start()`，起来之后等 `InboxEntry` | `runOnce()`，寿命塞在调用栈里 |
| 谁给它递 | 谁都行，多少次都行（`send()`） | 只有发起它的那一个调用方，而且只一次 |
| 怎么收尾 | 没人再递的时候 `stop()` | 自己收尾：第二次 `send()` 抛 `closed` |
| 结果将来才回来的工具 | 支持 | 不支持 |

最后一行是硬的：将来某个时刻才回来的结果，到那一刻必须还有人在收。一次性 `Agent` 的调用栈那时已经退回去了，没有人接。所以这类工具只能挂在常驻 `Agent` 上，而且要由装配那一侧提前拦住，不是跑起来才发现。

常驻 `Agent` 上没有「递一条进去再等它闲」这个动作。`sendAndWait()` 与 `runOnce()` 在它上面一律抛：常驻 `Agent` 随时可能被任何触发方递一条进来，「我等到它闲」没有可以挂靠的东西。只有一次性 `Agent` 有一条因果链 —— 调用方自己那一次调用。

| 入口 | 干什么 | 等不等 |
|---|---|---|
| `send(input?)` | 往 inbox 放一个 `InboxEntry` 就返回；已关门时抛 `closed`；不给 `input` = 只拧钥匙 | 不等 |
| `sendAndWait(input?, { signal })` | 需要就先起，递进去，等到闲，交回 `messages`（不关门） | 等 |
| `runOnce(input?, { signal })` | 起、`sendAndWait`、关门、等到死透，交回 `messages` | 等 |

`runOnce()` 不是第七个方法：它就是 `sendAndWait` 外面套一层收尾，而 `sendAndWait` 又是 `start` + `send` + 等闲的复合。跑完之后这个 `Agent` 就没了。

`sendAndWait()` 与 `runOnce()` 拒掉一切 `lifetime` 不是 `"one-shot"` 的 `Agent`。`runOnce()` 还拒已经 `start()` 过的 `Agent`，也拒 `messages` 为空且没有正文的调用 —— 没燃料的钥匙发出去是一个空请求。这几件都是调用方代码写错了，所以抛裸 `Error` 而不是 `AgentError`：那几个码是给会落到 `message.error`、会被从存储里读回来的失败用的。

## 循环

```ts
for await (const batch of inbox.asTakeAll()) {
  // a batch is in hand
}
```

队列既是 inbox 也是唤醒信号：空着的时候循环挂在队列自己的推送通知上，不必另造一个信号。那一条 `for await` 就是外循环；队列本身属于 `Agent` 内部，要点在于除了它没有第二套唤醒机制 —— 有两套就必然有一处忘记叫醒。`asTakeAll()` 来自 `@ai-zen/async-queue`，是 `takeAll()` 的生成器视图：空则挂起，有货一次取干。

```text
start() → outer loop
 └─ wait on the output gate                     ← once, before taking anything
    for await (batch of inbox.asTakeAll())
        state = "working"
        repair history                          ← the only place that looks back
        land this batch (one user message per entry with content, nothing for a key)
        report inboxTaken
        onOuterLoopStart → inner loop → onOuterLoopEnd
        queue empty → state = "idle"
        wait on the output gate                 ← once per batch, at the tail
```

在输出开关上等待有两处 —— 进去之前一次，每批尾部一次。这就是「批与批之间不取走」的实际含义：开关翻上的时候到达的 `InboxEntry` 留在队列里，看得见条数，可以落库，之后可以恢复。

`state` 只由循环的位置决定，别的什么都不参与：取到一批 → `working`；这批跑完且队列真空 → `idle`。输出开关不参与这个判断，所以「不取走期间到的那批跑完了」与「输出仍然不取走」是两个事实，都报得出来。

已经取出来的那一批算已经开始。`pauseOutput()` 从下一批生效，不把它收回：它可能已经落了消息，工具也可能跑了一半，塞回队头只会造成重复。要立刻停就用 `abort()`。

内循环在「刚才那次响应要了工具」时继续。它是 `while`，不是递归：每递归一层就多一个栈帧、多一份私有的局部状态，「现在走到第几层」就变得答不出来。一批之内，一次响应要的工具并行执行，结果消息按调用顺序写进 `messages`，不是按完成顺序。

内循环只有一个取走点：一次请求刚收尾、下一次还没开始的那一刻，它只看 `priority: "high"` 的 `InboxEntry`。低优先级的与钥匙它连看都不看，留给外循环。

## 状态与两道开关

三处，三个答案，谁也不替谁说话。

| 处 | 成员 | 说的是 | 谁改它 | 事件 |
|---|---|---|---|---|
| 对外那一格 | `state: "working" \| "idle"` | 手上有没有活 | 只有循环的位置 | `state:working` / `state:idle` |
| 输出 | `isOutputPaused` | 还取不取（`true` = 从下一批起不取） | `pauseOutput()` / `resumeOutput()` | `output:paused` / `output:resumed` |
| 输入 | `isInputPaused` | 还接不接递（`true` = `send()` 被拒） | `pauseInput()` / `resumeInput()`；`stop()` / `kill()` 是它的生产者 | `input:paused` / `input:resumed` |

一句话把两道开关分开：输入开关拦 `send()`，输出开关拦取走。输入关着的时候 `send()` 被挡回来（关门之后是 `closed`，只是暂时关着是 `input_paused`），而队列与手上那一批一件不动；输出翻上之后不取走，递照收、`InboxEntry` 留在队列里。两道开关都不参与 `state`。

`stop()` 与 `kill()` 自己把输入关上，此后它不再打开：队列已经宣告不会有新的了，这时放一条进去，等于把它交给一个没人取的队列。

- `pauseOutput()` 从下一批生效：手上那一批跑完。
- `abort()` 中止在途的活（请求与工具）并报 `aborted`；`Agent` 不死，只是输出开关翻上了。死是 `kill()` 的事。
- 每道开关各有自己的一对事件，当前值从活对象上现读（`agent.isOutputPaused` / `agent.isInputPaused`），不放在事件载荷里。两条事件互不冒充。
- 没有「出错」这一格：出错是事实，读那条消息的 `status` 与 `error`。也没有「死」这一格：死就是没有 `Agent` 这个对象。

其余一律读活对象，不存在第二份状态，也不依赖「事件一条都不能漏」：在不在干活读 `state`；还取不取、还接不接递读那两个现读；在想什么、在等哪几个工具读消息本身。

## inbox

`InboxEntry` 有两种形状。两种都是纯数据 —— 不带任何活引用 —— 因为它要存下来、再读回来。

```ts
// an entry with content: lands as one user message
interface InboxEntryWithContent {
  messageId?: string;                 // chosen by the sender, so a client can echo optimistically
  createdAt: string;                  // filled by core: the moment it arrived
  priority: "high" | "low";           // high: takeable inside the inner loop; low: outer loop only
  source: AgentNS.MessageSource;
  content: AgentNS.MessageContent;
}

// a key: wakes the loop up and lands nothing
interface InboxKey {
  createdAt: string;
  priority: "low";                    // the inner loop only looks at high, so a key is never taken there
  content?: undefined;
}
```

带正文的按 `priority` 分两档，按 `source` 分三种。`source` 全都是文字：`{ kind: "user" }`，`{ kind: "agent", label }` 指另一段会话，`{ kind: "system", label }` 指宿主、定时器或外部系统。每条 `role: user` 的消息都带一个 —— 宿主注入的隐藏消息也不例外 —— 于是「这是用户说的」只有一个判据：`source.kind === "user"`。

`source` 里不许放活的 `Agent` 引用：消息要落库，而 `Agent` 带着客户端、事件订阅和自己那份消息数组，序列化直接成环。要「点进去看那段会话」，需要的是会话 id，那是宿主的财产。

除 `user` 之外的每种来源，写进 `messages` 时内核都在正文前面加一行注释 —— 它写出来的就是下面这一行：

```text
// 这条消息来自 <label> 自动推送（<createdAt>）

<the content, unchanged>
```

正文是内容块数组的时候，这行注释变成最前面一个 `text` 块，其余块的位置不动：拼成字符串等于把图片块整段丢掉。时间用 `InboxEntry` 自己的 `createdAt`，不是「现在」：外部通知可能说的是很久以前发生的事，模型得能分辨。

不取走，只看队列里还有什么：

| 成员 | 给什么 |
|---|---|
| `inboxPending` | 还没被取走的 `InboxEntry`，按到达顺序 —— 数组是拷贝，每一条是同一个对象 |
| `inboxSize` | 队列里有几条 |

`restore(entries)` 把存下来的原样放回去：`createdAt` 不变，不补任何默认值，也不发 `inboxAdded`（行已经在存储里，恢复不是新变化）。它拒一次性 `Agent`（寿命在调用栈里，没有「重启之后接着等」这回事）、已关门或已被杀的 `Agent`，以及形状不全的 `InboxEntry` —— 半截的当场拒掉，一条不合格就一条都不放回去。

三个事实会报出来，inbox 每变一次就是其中一个：

| 事件 | 载荷 | 什么时候 |
|---|---|---|
| `inboxAdded` | `entry` | 放进了一个 |
| `inboxTaken` | `entries` | 这些离开了队列，它们的消息已经写进 `messages` |
| `inboxCleared` | `entries` | 队列被作废（`clearInbox()`），不是被取走 |

清空走的是队列自己的 `clear()`，不看两道开关：作废与取走是两个口。取走要看输出开关（不取时一件都不给，货还排着队），作废不看 —— 开关翻上的时候照样清得掉。

落库的次序只有一种排法不会丢东西。`send()` 那一路先落库、再入队：反过来，崩在两步之间，这一条只剩在内存里，进程一没就没发生过；先落库最坏的代价是同一条被再取一次，而那种重复认得出（`messageId` 在历史里）。取走那一路相反：消息先写进 `messages`，再报 `inboxTaken`。两个方向合起来是同一条规矩 —— 宁可重，不可丢。内核自己不认识存储，它只把这三个切点摆好，让落库那一侧只有这一种排法。

## 在循环开头修历史

外循环取下一批之前，把历史修一遍。这是唯一回头看的地方，它做三件事：把遗留的 `writing` / `pending` 消息定型，按「丢」的策略删掉不该留的，按「填」的策略补上没配对的工具结果。判断只用两样东西 —— 消息的 `status`，以及 `tool_calls` 与工具消息的配对 —— 于是中断、失败、崩溃在这里长得一样。

| 成员 | 取值 | 默认 | 决定什么 |
|---|---|---|---|
| `abortedToolRoundStrategy` | `"fill"` / `"drop"` | `"fill"` | 被中断的一组工具调用：留着并补上缺的那条结果（`abortedToolRoundReason`），还是整组删掉 |
| `abortedMessageStrategy` | `"drop"` / `"keep"` | `"drop"` | 被中断的 assistant 消息：删掉，还是留下已经写出来的那部分 |

两个都是构造选项。「丢」是真的删 —— 内存与存储里都删 —— 并报 `messageRemoved`；`omit` 是另一件事（消息还在，只是不再发出去）。

修在开头而不是结尾，有三个后果。只写一处：装载一份崩过的历史不需要特殊处理，宿主连「记得调」都不用。进去的时候一定是干净的：内循环里的构造请求体、数用量、看配对都可以无条件假设历史干净。用户还能看见真相：界面留着「说到一半被打断」与「工具没回话」，直到 `Agent` 真的重新开始，而不是按了停止就立刻被悄悄改写成完成。

## 事件

每条事件都带 `agent`、`seq`（这个 `Agent` 自己的计数器，从 1 起，只增）和 `at`。凡是带消息、`InboxEntry` 或流增量的，带的就是那个活对象本身，不是拷贝 —— 拷贝是第二份事实，交出去那一刻就开始过期。

| 事件 | 发生了什么 | 载荷 |
|---|---|---|
| `started` / `stopped` / `killed` | 起来了 / 排空之后死了 / 被杀 | — |
| `state:working` / `state:idle` | 对外那一格到了这个值 | `from` |
| `output:paused` / `output:resumed` | 从下一批起不取了 / 又开始取 | —（现读 `agent.isOutputPaused`） |
| `input:paused` / `input:resumed` | 递关了 / 又开了 | —（现读 `agent.isInputPaused`） |
| `aborted` | 有人按了停 | —（有没有东西被中止，读消息的 `status`） |
| `inboxAdded` / `inboxTaken` / `inboxCleared` | 来了一个 / 这些被取走 / 队列被作废 | `InboxEntry` 本身 |
| `messageAdded` / `messageChanged` / `messageRemoved` | 一条消息出现 / 就地变了 / 被删了 | 那条消息 |
| `messageFinished` | 这条消息的这一版是终版，不会再变 | 那条消息 |
| `delta` | 到了一片原始的流增量 | `chunk` + `source`（`{ message }` 或 `{ subAgent, toolCall }`） |
| `requestSent` / `responseFinished` | 请求发出去了 / 这次响应结束了 | 请求体 / 定型后的消息 |
| `turnStarted` / `turnFinished` | 一次请求与它引发的工具开始了 / 结束了 | assistant 占位消息，两边是同一个实例 |
| `toolStarted` / `toolFinished` | 一个工具开始了 / 结束了 | 工具调用 / 结果消息 |
| `subAgentStarted` / `subAgentFinished` | 一次委派开始了 / 结束了 | `SubAgent` 与工具调用 |
| `denied` | 钩子拒了，这一次根本没有跑 | `hook`、`reason`、结构化的 `detail` |
| `failed` | 跑了，失败了 | 一个 `AgentError`，有的话还有那条消息 |
| `observerFailed` | 某个订阅者抛了 | 事件名与错误 |

`seq` 让订阅者判出重复与缺口。`denied` 与 `failed` 是两个名字，因为之后的历史长得不一样：`denied` 一个字都不留，`failed` 留下一条半截的 assistant 消息，`status: "error"`。`reason` 是写给模型或人读的文案，`detail` 才是给程序看的。

订阅是旁路。`on(type, handler)` 返回退订函数；抛错的 handler 当场被接住，报成 `observerFailed`，不打扰 `Agent` —— 磁盘满不该打死正在被观察的那次请求。事件只是通知，不是唯一信息源：晚到、重复、丢一条都不影响正确性，读活对象就自愈。

## 钩子

`use(plugin)` 挂一个插件。钩子说的是循环里的一个位置，不是一个事实（事实是事件）。

| 钩子 | 能不能拒 | 位置 |
|---|---|---|
| `onInit` | 不能 | 注册之后，与寿命无关 |
| `onStart` / `onStop` / `onKill` | 不能 | 寿命的两端 |
| `onOutputPaused` / `onOutputResumed` | 不能 | 输出开关翻了 |
| `onAbort` | 不能 | 有人按了停（开关本来就翻着也照发） |
| `onIdle` | 不能 | 对外那一格变成 `idle` |
| `onOuterLoopStart` / `onOuterLoopEnd` | 不能 | 一批开始了 / 结束了 |
| `onInnerLoopStart` | 能 | assistant 占位消息还不存在的时候；也允许改写请求体 |
| `onInnerLoopEnd` | 不能 | 那次请求结束了 |
| `onToolStart` | 能 | 工具存在；问要不要跑它 |
| `onUnknownTool` | 能 | 工具不存在；问该回模型什么 |
| `onToolEnd` | 不能 | 工具跑完了（只对存在的工具） |
| `onSubAgentStart` / `onSubAgentEnd` | 只有 start 能 | 委派的边界 |

能拒的只有四个。`onOuterLoopStart` 不在里面：这批已经从队列里取出来了，拒了它就没主。关于一批的判决属于递之前。

钩子抛错的时候，能拒的那四个 fail-closed —— 它们是门，会放行的坏门不叫门 —— 其余钩子 fail-open，当作没说过话，接着问下一个插件。两种都报 `failed`；抛错的插件不能留下一个看着还活着、其实塞进去也不动的 `Agent`。

能拒的钩子返回字符串时，那个字符串就是工具消息的正文或拒绝的理由；内核不拿自己的措辞去包它 —— 那句文案本来就是要说给模型听的。`onInnerLoopStart` 在 assistant 占位消息造出来之前跑，所以拒了不会留下一条卡在 `pending` 的消息。它拿到的 `body` 是这一次要发出去的请求体，不是 `agent.messages`：要发出去的那一份与活着的那一份不是同一个东西，钩子可以直接改它。

同一个位置上钩子先于事件，只有一个例外：`state:*` 由状态 setter 在 `onIdle` 之前发出，`started` 在 `onStart` 之前发出 —— setter 是同步的边界，订阅者得能在钩子跑之前看见那个值。

## 错误

一个类，同一个实例出现在两处。

```ts
export type AgentErrorCode =
  | "request-failed"   // could not connect / no response
  | "stream-failed"    // a response came, but the stream broke or did not fit
  | "closed"           // the agent is finished: sending will never be taken again
  | "input_paused";    // input is closed right now: wait and send again

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown });
}
```

四个码各描述世界里的一件事。要分开的是后两个：`input_paused` 说的是等一等还能投，`closed` 说的是改投别处 —— 压成一个码，投递方只能拿「再试一次」去撞一个永远不会再收的队列。

同一个实例既是 `failed` 事件的载荷，也是它所归属那条消息的 `error`。`toJSON()` 给 `{ code, message }` 两格，足够从存储里把它重建出来（`AgentError.fromJSON()`）；`stack` 与 `cause` 由写那行的人决定要不要存。

错误的文字永远不进 `content`。`content` 是模型说过的话；配上「留」的策略，一条存下来的 `ECONNREFUSED` 会以模型自己说过的话的身份回到模型面前。`role: tool` 的消息是例外：它的 `content` 本来就是模型要读的结果。

内核只分类它知道的那一维（哪一部分失败）。错误可不可重试、401 是不是「密钥错了」、要不要退避、要不要重试，它一概不判 —— 那几样一旦进来，内核就得懂网络、懂厂商、懂幂等。

## 零件

| 导出 | 是什么 |
|---|---|
| `Message` | 消息类；`Message.System()`、`Message.User()`、`Message.Assistant()`、`Message.Tool()` 造一条，`id` 与 `createdAt` 由构造函数补 |
| `Tool` | 工具抽象基类：继承它并实现 `exec(ctx): Promise<MessageContent>`；定义放在 `function` 上 |
| `CallbackTool` | 用一个回调而不是子类定义的工具 |
| `ToolCallContext` | 工具收到的东西：`agent`、`tool_call`、`parsedArgs`、`parseError`、`resultMessage`、`signal` |
| `AgentToolLazy` | 把一个 `Agent` 当工具：按需造它、把它的事件转发给父级、跑一次并交回它说过的话 |
| `applyChunk` | 一片流增量就地攒进一条消息 —— 这件事唯一的实现 |
| `formatContent` | 内容块收敛成模型认识的字段；`__` 开头的键与不认识的块丢掉 |
| `sumUsage` / `addUsage` / `ZERO_USAGE` | 跨消息求和用量：消息自己的 `usage` 加上工具消息的 `subAgentUsage` |
| `reconcileAbortedToolRounds` / `reconcileAbortedMessages` | 修历史那两件事，单独导出以便复用与测试 |

`Tool.exec` 停不下循环：它返回什么，就是一条交回模型的工具消息。能停的两种办法是钩子拒绝和 `abort()`。参数烂、执行挂、工具不存在是同一件事 —— 没给出有效结果 —— 一条工具消息回给模型，循环不停、不重试。

## 不做什么

| 不做 | 为什么 |
|---|---|
| 重试、分类、降级 | 产品策略；引擎里的重试循环得懂网络、厂商与幂等 |
| 归一厂商错误码 | 每上一个 provider 就得改一次内核 |
| i18n | 引擎层的文字是英文；语言属于宿主 |
| 认识 Asset、端点或存储 | 顺着那条线会自己长成一个应用 |
| 空闲回收、引用计数、定时器 | 寿命只跟六个方法走 |
| 递归的内循环 | 每层多一个栈，「现在走到第几层」就说不清 |
| 全局的「已中止」标志或「出错」状态 | 全局标志是 `Agent` 沦落到需要人工复活的开始；错误是消息上的事实 |
| 错误文字进 `content` | 模型会把它读成自己说过的话 |
| 一次性 `Agent` 上结果将来才回来的工具 | 没有人留在那里收 |
| 常驻 `Agent` 上的 `sendAndWait()` / `runOnce()` | 它没有一条属于自己的因果链可等；那边只有 `send()` |

## 往下读

- [快速开始](getting-started.md) —— 不经过宿主装一个 `Agent`
- [只用 core 与 Scope](scope.md) —— 要能力（工具、skill、MCP）但不要运行时
- [架构](architecture.md) —— 为什么这么切、活物的四问、事件与持久化的落点
- [SDK](sdk.md) —— 在内核上装能力与运行时：`Scope`、模型解析、交接、唤醒与发话
