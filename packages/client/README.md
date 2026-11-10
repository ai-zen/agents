# @ai-zen/agents-client

到 `agents-server` 的**连接层**：服务发现与拉起、帧编解码、会话与配置门面。
CLI（TUI）与 Desktop（main）共用同一份实现 —— 以前它住在 `cli/src/server-client/`，
桌面端要接入就只能抄一遍，而抄出来的两份会在 `hello` 握手、重连、错误码上慢慢分叉。

## 包里有什么

| 文件 | 职责 |
|---|---|
| `ensure-server.ts` | 读 `<aiZenDir>/run/server.json`；探活失败就 detached 拉起 `agents-server serve`，轮询到 `ping` 通 |
| `socket-server-client.ts` | 一条 TCP + JSON-lines 连接：`hello` 握手、在飞调用、事件分发、断开通知 |
| `sessions.ts` | `session.*` / `workspace.*` 的类型化门面（`RemoteSessions`） |
| `config-port.ts` | 配置面（`ConfigPort`）：`config.*` / `agent.*` / `mcp.*`，以及「默认 Agent / 默认模型 / 会话级模型与参数」这些窄方法 |
| `status.ts` | `--server-status` 背后的只读诊断（不拉起） |
| `local-host.ts` | 「服务端是不是在这台机器上」→ 决定要不要把客户端 cwd 当工作区递上去 |
| `mcp.ts` | `mcp.json` 的形状（类型；读写归服务端） |
| 协议 | `@ai-zen/agents-server/protocol` 原样转出：方法名常量、结果类型、帧编解码、发现文件形状 |

## 三条硬约束（都能用 grep 检验）

### 1. 只走 `@ai-zen/agents-server/protocol`，不走服务端本体

桌面的 main 是打包产物：import 图上出现 `@ai-zen/agents-server` 的**主入口**，整套服务端实现
（连带 `@ai-zen/agents-sdk`、MCP SDK、openai）就会被塞进安装包。生产代码里只允许这个子路径：

```bash
grep -rn '@ai-zen/agents-server"' src/ --include=*.ts | grep -v '\.test\.ts'   # 必须为空
```

（`*.test.ts` 例外：用例要起**真 Daemon**，那是 `@ai-zen/agents-server` 根入口才有的东西。
测试代码不进产物，所以不影响上一条。）

### 2. 产物的运行期依赖图必须闭合

```bash
cd packages/client && npm run build
grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u
```

期望输出只有 `@ai-zen/agents-server/protocol`、同级相对路径、`node:*` 三类。
`@ai-zen/agents-sdk` 只会以 `import type` 出现在 `dist/*.d.ts` 里（`AppConfig` /
`AgentDefinition` / `ReasoningPresets` 是配置与定义在两端的**共同形状**），产物里已被擦除。

> 检查命令必须锚在行首的 `^import`。不锚的话，本包文档注释里那句 `import type … from
> "@ai-zen/agents-sdk"` 会被自己 grep 到，得出「拖了 sdk」的错误结论 —— 这一步实际踩过。

### 3. 不读进程级全局

`aiZenDir`（配置根）与 `clientInfo`（握手自称的身份）都由**组装根**注入：CLI 在
`src/server-client/index.ts`、桌面端在 main 的启动处各读一次 env / `app.getVersion()`。
两者都是「应用级事实」，本包是库，拍不了这个板 —— 否则桌面端拉起服务端时会自称是 CLI。

## 用法

```ts
import { createRemoteConfigPort, RemoteSessions, ensureServer } from "@ai-zen/agents-client";

const clientInfo = { name: "@ai-zen/desktop", version: app.getVersion() };
const { client } = await ensureServer({ aiZenDir, clientInfo });
await new RemoteSessions(client).watch();
const config = createRemoteConfigPort({ aiZenDir, clientInfo });
```

已经有一条连接（或想自己管生命周期）就给 `{ client }` / `{ connect }`，此时
`aiZenDir` + `clientInfo` 可以不给 —— 它们只在**需要自己拉起服务端**时被读。
