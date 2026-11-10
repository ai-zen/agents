# @ai-zen/agents-client

到 `agents-server` 的**连接层**：服务发现与拉起、帧编解码、会话与配置门面。
CLI（TUI）与 Desktop（main）共用同一份实现 —— 以前它住在 `cli/src/server-client/`，
桌面端要接入就只能抄一遍，而抄出来的两份会在 `hello` 握手、重连、错误码上慢慢分叉。

## 包里有什么

| 文件 | 职责 |
|---|---|
| `ensure-server.ts` | 读 `<aiZenDir>/run/server.json`；探活（`callOnce` 问一句 `ping`）失败就 detached 拉起 `agents-server serve`，轮询到 `ping` 通 |
| `socket-server-client.ts` | 一条 TCP + JSON-lines 连接：`hello` 握手、在飞调用、事件分发、断开通知 |
| `sessions.ts` | `session.*` / `workspace.*` 的类型化门面（`RemoteSessions`） |
| `config-port.ts` | 配置面（`ConfigPort`）：`config.*` / `agent.*` / `mcp.*`，以及「默认 Agent / 默认模型 / 会话级模型与参数」这些窄方法 |
| `status.ts` | `--server-status` 背后的只读诊断（不拉起，`callOnce` 问一句 `status`） |
| `local-host.ts` | 「服务端是不是在这台机器上」→ 决定要不要把客户端 cwd 当工作区递上去 |
| `mcp.ts` | `mcp.json` 的形状（类型；读写归服务端） |
| `stream-merge.ts` | 「本地流式增量」与「服务端快照」的合并规则（`mergeStreamedSnapshot`，纯函数、与传输无关） |
| 协议 | `@ai-zen/agents-protocol` 原样转出：方法名常量、结果类型、帧编解码、发现文件形状、数据模型类型 |

## 三条硬约束（都能用命令检验）

### 1. 运行期只依赖 `@ai-zen/agents-protocol`

`dependencies` 里只有它一项 —— 这不再是「纪律」，是**结构**：client 与 server 之间没有边，
两侧都只依赖协议包。

```bash
node -e 'console.log(Object.keys(require("./packages/client/package.json").dependencies))'
# 只有 [ "@ai-zen/agents-protocol" ]
```

`devDependencies` 里另有三个 workspace 包，都只为**类型与用例**，不进产物：

| 包 | 为什么还在 |
|---|---|
| `@ai-zen/agents-sdk` | `config-port.ts` 的公开类型要 `AppConfig` / `AgentDefinition` / `ReasoningPresets`（线上传的是 `unknown`，客户端兑现成类型）。**只在 `import type` 里出现**，产物 `dist/*.js` 里没有它 —— 但 `dist/*.d.ts` 里有，所以它不能删干净 |
| `@ai-zen/agents-server` | 用例要起**真 Daemon**（`Daemon` / `writeDescriptor` / `encodeFrame`）；另外 `ensure-server` 拉起服务端时要 `require.resolve` 它的 `bin`。测试代码不进产物 |
| `@ai-zen/agents-core` | 用例要真的 `AgentNS.Role` 真值造数据（`stream-merge.test.ts`） |

### 2. 产物的运行期依赖图必须闭合

```bash
cd packages/client && npm run build
grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u
```

期望输出只有 `@ai-zen/agents-protocol`、同级相对路径、`node:*` 三类。
`@ai-zen/agents-sdk`（`AppConfig` / `AgentDefinition` / `ReasoningPresets`）只以 `import type`
出现在 `dist/*.d.ts` 里，产物运行期不加载它。

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
