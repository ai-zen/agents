# @ai-zen/agents-protocol

**两进程之间的线上契约**：怎么找到对方 / 怎么说话 / 说什么形状。

它原来是 `@ai-zen/agents-server` 里的一个子路径（`./protocol`）。搬出来的理由只有一条：
**契约是双方的东西**——住在其中一方家里，包依赖图就必然是 `client → server`，于是「客户端
不该拖进服务端实现」只能靠纪律（只许走子路径、产物依赖图必须闭合）维持。搬出来之后那条边
**根本不存在**：`server` 与 `client` 都只依赖本包，谁都不依赖谁。

## 三句话定义职责

| 管 | 不管 |
|---|---|
| 线上契约：方法名表、事件名表、载荷形状、错误码表、帧编解码、发现文件形状、`callOnce` | 任何业务判断、任何状态机、任何 UI 概念 |

换句话说：本包里没有一行代码知道「会话该怎么存活」「工作区是什么」，只有它们**在线上的样子**。
判据很硬 —— 一个类型 / 函数该不该在这里，看它会不会出现在帧的两端：会，就归这里；只在某一侧
内部用，就不归。

## 包里有什么

| 文件 | 职责 |
|---|---|
| `frames.ts` | JSON-lines 帧编解码（`encodeFrame` / `FrameDecoder`）、单帧上限、`ProtocolError` |
| `messages.ts` | 握手与请求/响应帧的形状（`hello` / `RequestFrame` / `ResponseFrame`）、`PROTOCOL_VERSION` |
| `sessions.ts` | `session.*` / `workspace.*` / `events.watch` 的方法名与载荷；**三张事件表**（`AGENT_EVENTS` 9 条 = core 原名 + `SESSION_EVENTS` 7 条 + `SERVER_EVENTS` 1 条） |
| `config.ts` | `config.*` / `agent.*` 的方法名与载荷 |
| `assets.ts` | `asset.*`（只读资产清单） |
| `daemon.ts` | 内置方法 `ping` / `status` / `shutdown` |
| `discovery.ts` | `<aiZenDir>/run/server.json` 的形状与原子读写 |
| `host.ts` | `isLoopbackHost`（服务端绑地址、客户端判「服务端在不在这台机器上」共用一份） |
| `phase.ts` | 生成阶段的形状（`PhaseKind` / `PhaseInfo` / `ToolCallRef`） |
| `errors.ts` | 错误码表 `ERROR_CODES` 与 `codedError` / `isCodedError` / `codeOf` |
| `model.ts` | 数据模型的类型出口（从 `@ai-zen/agents-core` **类型级**转出 `Message` / `Usage` / `ToolCall`） |
| `call-once.ts` | `callOnce`：连上 → 握手 → 发一帧 → 等回执 → 挂断（诊断 / 收摊 / 探活共用的一份） |

## 三条硬约束（都能用命令检验）

### 1. 运行期零第三方依赖

只 import 本包的兄弟模块与 `node:*`。唯一跨出去的是 `model.ts` 里对 `@ai-zen/agents-core`
的 `import type` —— 类型在编译后抹掉，不进运行时依赖图（所以桌面端 main 这类打包产物引用本包
时，不会把 openai / MCP SDK 拖进去）。

```bash
# 列出所有 import 语句里出现的模块说明符，再滤掉测试、node:* 与类型转出（`@ai-zen/agents-core`）
grep -rn '^import\|^\} from' src/ | grep -v '\.test\.' | grep -v 'node:' | grep -v 'agents-core'
# 期望：输出里只剩相对路径（`./frames.js` 之类）—— 那就是「零第三方依赖」的样子
```

> 检查命令必须锚在行首（`^import` / `^\} from`）**且滤掉 `*.test.ts`**。不锚的话，本文件与各模块
> 文档注释里那些 `import … from "…"` 的例子会被自己 grep 到；不滤测试的话，`vitest` 会被当成
> 运行期依赖 —— 两种都会得出错误结论（前一条在 client 包里踩过）。

产物侧再验一次（`dist/*.js` 里只该有相对路径与 `node:*`）：

```bash
cd packages/protocol && npm run build
grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u
```

### 2. 不反向依赖任何实现

协议不认识 `daemon/`、`domain/`、`lib/`（那是服务端内部实现的分层）。它曾经有一条反向
的 `import type`：`sessions.ts` 从服务端的阶段状态机里取 `PhaseInfo` —— 于是「线上载荷
的形状」由某一侧的内部状态机拥有（D2 修掉了它，形状现在就在本包的 `phase.ts`）。

```bash
grep -rn 'service/\|daemon/\|domain/\|lib/' src/   # 必须为空
```

### 3. 只转出类型，不转出运行期值

`Role` 是 `enum`（运行期有对象）。它只能出现在**类型位置**（`Message["role"]`），不许
`export { Role }` —— 那等于把 core 拖进本包的运行时依赖图。

```bash
# 行首是 ` *` 的是**注释行**：`model.ts` 的文件头用散文说着「绝不许 `export { Role }`」，
# 不滤就会把这句拒绝当成违规（门禁只该扫代码行，修的是命令不是注释）
grep -rn 'export {.*Role' src/ | grep -v '^\S*:[0-9]*: *\*'   # 必须为空
```

## 用法

```ts
import { callOnce, DAEMON_METHODS, ERROR_CODES, SESSION_EVENTS, type SessionEvent } from "@ai-zen/agents-protocol";

const status = await callOnce({ host: "127.0.0.1", port: 8790 }, DAEMON_METHODS.status);
```

已经有一条长连接（要事件、要多次调用）就别用它 —— 那是 `@ai-zen/agents-client` 的
`SocketServerClient` 的事。`callOnce` 只回答「问一句」这种需求（诊断 / 收摊 / 探活）。
