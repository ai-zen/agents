# @ai-zen/agents-client

到 `agents-server` 的**连接层**：cli（TUI）与 desktop（main）共用同一份实现 —— 两个前端各写
一份，就会在握手、重连、凭证来源、错误码上慢慢分叉。

`private: true`，**不发版**（R69）：两个前端打包时各自把它**捆进自己的产物**，不依赖任何已发布
版本。所以包里没有 `main` / `exports` 那种「给外部装」的姿态，只留 `types` 与构建脚本供 monorepo
内的私有引用。

## 包里有什么

| 文件 | 职责 |
|---|---|
| `client.ts` | 一条 WS 上的 `Client`：`connect`（握手）/ `call` / `subscribe` / `close` / `reconnect` / `resume` |
| `connection.ts` | `ensureServer`：读 `<数据根>/run/server.json` 与 `run/token`，没有活实例就 `spawn agents-server serve`，轮询到「发现文件出现 + 握手成功」；**给了显式地址就只连、绝不拉起** |
| `settings.ts` | 连接设置（本机 / 远程地址 + 凭证 + 语言）的读写（`0600`、原子写）与措辞 |
| `resume.ts` | 补拉：`conversation.state` + `message.list({ after })`，以及「续传 / 全量」两种拼法 |
| `reconnect.ts` | 重连节奏（缺省无限重试，放弃与否由调用方决定）与「哪些失败不值得重试」 |
| `errors.ts` | `ClientError`：服务端业务码与文案原样搬运；只有「服务端不在场」那几句由客户端按语言给 |
| `address.ts` | 地址形状与 `ws://` URL 的唯一实现处（IPv6、子路径、`http→ws`） |
| `frames.ts` | JSON-RPC 2.0 的判别与构造（形状 `import type` 自服务端） |
| `testSupport/` | 用例用的假服务端（手写最小帧编解码，不引入 `ws`） |

## 契约不在这里重写

方法名、事件名、载荷、业务码、消息本体全部 `import type` 自 `@ai-zen/agents-server`
（`wire/{methods,events,states,frames,errors}.ts`）。所以：

```ts
const client = await Client.connect({ target, token, clientInfo, language: "zh" });

// 入参 / 出参由 MethodMap 推出来
const { state } = await client.call("conversation.state", { conversationId });
const version = await client.call("server.version"); // 无入参的方法省掉 params

// 事件按 EventMap 收窄
client.subscribe("message.delta", (payload) => payload.delta.content);

// 断线之后：重连 + 补拉
client.track(conversationId);          // 记住要跟着这段对话
client.onClose(() => void reconnectUntilConnected(client));
client.onResume((outcome) => { if (outcome.ok) setMessages(mergeResumed(local, outcome.resumed)); });
```

运行期**不 import** 服务端包：它的包根会把整个服务端（单根、SQLite worker、SDK 装配）拉进产物。
