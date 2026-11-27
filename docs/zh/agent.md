# Agent

一个 agent 是磁盘上的一份 JSON，加上装配它时用到的那几个目录。`core` 只认识装配好的对象：队列、模型客户端、消息、工具。它不读配置文件，也不写磁盘。

## 定义文件

`<数据根>/agents/<id>.json`，文件名就是 id。

| 字段 | 含义 |
|---|---|
| `id` | 唯一标识，与文件名一致 |
| `name` | 显示名 |
| `messages` | 预设消息，通常只有一条 `system`。运行期这段历史的开头就是它 |
| `modelId` | 绑定的模型。留空则落到 `config.json` 的 `defaultModel` |
| `modelParams` | 请求参数覆盖，与模型的 `defaultParams` 做一次浅合并 |
| `permissions` | 四维能力白名单，见[能力](capabilities.md) |
| `function` | 有这一格就是子代理：装配后成为父 agent 手上的一把工具 |
| `custom` | `true` 时 SDK 初始化不会用出厂定义覆盖它 |

模型按三级解析：会话级覆盖 > 定义里的 `modelId` > `config.json` 的 `defaultModel`。三级都取不到时装配失败，错误里带上 `agentId`，不会退回某个出厂模型——否则界面写着 A，请求与账单落在 B。

`modelParams` 不解释键名，只做浅合并。因此同一个模型可以给编程用的 agent 配 `{"thinking":{"type":"enabled"},"reasoning_effort":"max"}`，给闲聊用的配 `{"thinking":{"type":"disabled"}}`，模型自己的定义不动。

`messages` 在装配时被复制一份：运行期的历史是与定义无关的另一个数组，追加、裁剪、标记 `omit` 都不会改到定义文件。

## 两种寿命

| | `resident`（缺省） | `one-shot` |
|---|---|---|
| 起法 | `start()` 之后等投递 | `runOnce()` 或 `sendAndWait()` |
| 投递次数 | 任意多次 | 一次。第二次投递抛 `closed` |
| 结束后 | 仍在，可以接着投 | 终结，不可复用 |
| 后台工具 | 有 `async_exec`、`async_timeout` | 没有：结果回来时调用栈已经退了 |
| 会话级工具 | 有 `post_message` 等 | 没有：它不属于任何一段会话 |

## 投递

```ts
agent.send("看一下这个目录");                       // 一句话，高优先级，来源 user
agent.send({ content: rows, priority: "low", source: { kind: "system", label: "cron" } });
agent.send();                                       // 不带正文：只唤醒，不落任何消息
```

`send()` 进队列即返回。投不进去时抛错，并且分得开两种原因：

| 错误码 | 含义 |
|---|---|
| `closed` | 这个 agent 已经终结，再等也不会有人取 |
| `input_paused` | 输入开关暂时关着，`resumeInput()` 之后还能投 |

取走的时机由优先级决定：

- `high`：内循环里工具执行完的间隙就可以取走。另一段会话寄来的话、后台任务的回投走这一档
- `low`：只在外循环取下一批时被看见，也就是本批彻底跑完之后

不带正文的条目只负责把 agent 从空闲叫起来：历史里一个字都不多。它用于「输入已经在消息里，只差触发一次」的情形，例如派出去的子代理。

## 队列与两处开关

一个 agent 只有一条队列，它同时是收件口、取件口与三处状态的来源：

| 状态 | 读法 | 谁改 |
|---|---|---|
| 在干 / 闲 | `agent.state` | 循环自己：取到一批是 `working`，本批跑完且队列真空是 `idle` |
| 是否还收投递 | `agent.isInputPaused` | `pauseInput()` / `resumeInput()`；`stop()` 与 `kill()` 会关上它 |
| 是否还取走 | `agent.isOutputPaused` | `pauseOutput()` / `resumeOutput()`；`abort()` 会翻上它 |

两处开关互不影响：不取走期间投进来的那批照跑，跑完照样报空闲；而报空闲不代表还收投递。

三个终止动作的区别：

| 动作 | 在途请求 | 排队中的条目 | 之后 |
|---|---|---|---|
| `abort()` | 中断 | 留着，不再取走 | 用 `resumeOutput()` 接着取 |
| `stop()` | 跑完 | 跑完存量 | 终结，投递抛 `closed` |
| `kill()` | 中断 | 作废（`clearInbox()`） | 立刻终结 |

`clearInbox()` 是「作废排队」，与「取走」是两个口：不取走期间它也照样清得掉。`restore(entries)` 把保存下来的条目原样放回队列，用于进程重启后恢复。

## 事件流

`agent.on(name, handler)` 返回退订函数。订阅是旁路：订阅者抛错不会打断 agent，错误本身会作为 `observerFailed` 报出来。

| 分组 | 事件 |
|---|---|
| 生命周期 | `started`、`stopped`、`killed`、`state:working`、`state:idle` |
| 开关与中断 | `output:paused`、`output:resumed`、`input:paused`、`input:resumed`、`aborted` |
| 队列 | `inboxAdded`、`inboxTaken`、`inboxCleared` |
| 消息与流 | `messageAdded`、`messageChanged`、`messageRemoved`、`messageFinished`、`delta` |
| 一次请求 | `turnStarted`、`requestSent`、`responseFinished`、`turnFinished` |
| 工具与委派 | `toolStarted`、`toolFinished`、`subAgentStarted`、`subAgentFinished` |
| 失败 | `denied`、`failed`、`observerFailed` |

每条事件都带三格：`agent`、`seq`（这个 agent 自己的单调序号，从 1 开始）、`at`（ISO 8601 时刻）。`seq` 用来判断重复与缺口，也用来回答「从哪接着写」。

载荷里带的是活对象本身，不是拷贝：拿到 `messageAdded` 的那条消息，之后它的 `status`、`content` 会随流式响应一起变。要一份此刻的快照，读 `agent.messages`。

## 异步结果回投

工具调用可以当场返回、结果稍后到达。三处走同一条路：

| 结果何时回来 | 投回什么 |
|---|---|
| `async_exec` 的命令结束 | 输出与退出码；超时被杀会写明 |
| `async_timeout` 到点 | 一条到点提醒 |
| MCP 服务端的长任务到达终态 | 一条通知，正文指向 `get_mcp_task_result` |

回投走 `send()`，来源是 `{ kind: "system", label: <工具名> }`，优先级是高——等结果的一方常常正在轮询，低优先级要等本批结束，而本批正停在轮询里，结果就投不进去。

收到的结果如果没人取：那段会话已经没有 agent、或队列已经关门时，投递抛错，这条结果被丢弃并记一行日志。它不会复活一段会话。

## 子代理

定义里带 `function` 的那份 JSON 会变成父 agent 手上的一把工具，参数由 `function.parameters` 决定：

```json
{
  "id": "sub-agent-default",
  "messages": [
    { "role": "system", "content": "You are a general-purpose sub-agent…" },
    { "role": "user", "content": "{{task}}" }
  ],
  "function": {
    "name": "sub_agent_default",
    "description": "General-purpose sub-agent…",
    "parameters": {
      "type": "object",
      "properties": { "task": { "type": "string" } },
      "required": ["task"],
      "additionalProperties": false
    }
  }
}
```

调用时：

1. 按参数深拷贝一份 `messages`，把字符串正文里的 `{{key}}` 换成 `parsedArgs[key]`
2. 子代理是一次性寿命，跑 `runOnce()`，父的中断信号直接传下去
3. 子代理的事件转发到父身上，载荷多两格：`subAgent`（这些事发生在谁身上）与 `via`（是哪一次委派引起的）。`state` 不转发：父那一格说的是父自己
4. 子代理及其孙级的 token 用量累加后记在这次工具结果消息的 `subAgentUsage` 上，随消息持久化

父模型只收到子代理最后一条消息的内容。中间几十次工具调用不进父的上下文。

## 中断之后的历史

被中断的请求会留下未定型的历史。每次取到新一批之前，agent 先按两条策略归一一次：

| 配置 | 取值 | 含义 |
|---|---|---|
| `abortedMessageStrategy` | `keep`（出厂） | 保留已输出的半截回答，恢复为 `completed`，下一次请求可以接着往下说 |
| | `drop`（core 缺省） | 丢弃，保持 `aborted`，不进下一次请求的上下文 |
| `abortedToolRoundStrategy` | `fill`（出厂） | 保留整轮：assistant 恢复为 `completed`，没跑出结果的工具补一条原因 |
| | `drop` | 整轮出列，assistant 与其结果都不再发给模型 |

两条都写在 `config.json` 上，也可以由 `createAgent()` 显式传入。服务方要求工具调用与结果一一配对，`fill` 因此是出厂取值。
