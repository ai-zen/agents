# 快速开始

## 前提

- Node.js 24 及以上：宿主使用内置的 `node:sqlite`
- pnpm（从源码构建时）
- 一个 OpenAI 兼容端点的密钥

数据根是这套运行时唯一的可写目录树，由环境变量 `AI_ZEN_DIR` 指定，缺省 `~/.ai-zen`。宿主与命令行读同一处。

## 用终端客户端

```bash
npm i -g @ai-zen/cli
ai
```

（从源码构建：`cd cli && npm run build`，入口是 `dist/index.js`，`bin` 里登记了 `ai`、`aiz`、`zen` 三个名字。）

`ai`（同 `aiz`、`zen`）在终端里启动交互界面。它先按顺序找宿主：显式地址 `--server <url>`、环境变量 `AI_ZEN_SERVER_URL`，都没有就读 `<数据根>/run/host.json` 里的地址与 `<数据根>/run/token` 里的凭证；连不上时按 `npx -y @ai-zen/agents-host@<版本范围> serve --ai-zen-dir <数据根>` 拉起一个，再等它开始监听。

两种模式，同一个进程只走其中一条：

| 调用方式 | 模式 |
|---|---|
| 带位置参数，或 stdin / stdout 不是 TTY | 纯 stdio：一次性调用，只把最终的助手文本写进 stdout，日志与进度走 stderr |
| 无参数且 stdin / stdout 都是 TTY，或带 `--tui` | 交互界面 |

常用参数：

```bash
ai "这个仓库用了哪些构建脚本"          # 一次性调用，不落库
ai --save "看完 src 后总结一下"        # 一次性调用，但写成一段真会话
ai --new                              # 进界面，开一段新会话，不续接这个目录上一次的
ai --server ws://192.168.1.10:8790    # 连指定的宿主
ai --server-status                    # 打印宿主状态，不拉起、不进界面
```

退出码：`0` 成功；`1` 已经跑起来之后的失败；`2` 命令本身用错（例如 `--tui` 但终端不是 TTY）。

## 配端点

第一次启动会写出 `<数据根>/config.json`，里面四个出厂端点的 `apiKey` 都是空串：

| 端点 id | 地址 |
|---|---|
| `openai` | `https://api.openai.com/v1` |
| `bigmodelcn` | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | `https://api.deepseek.com/v1`（声明了 Files API，本地文件走上传而不是内联） |
| `opencode-go` | 订阅式端点，模型清单随 SDK 一起发布 |

把要用的那一个填上密钥就能运行。默认 agent 绑的模型是 `deepseek-flash`，它属于 `deepseek` 端点。

## 从源码起宿主

```bash
pnpm install
pnpm -r --filter '@ai-zen/agents-host...' build

node packages/host/dist/cli.js serve
```

启动后打印五行：监听地址、版本、发现文件、日志目录、凭证文件。其余参数：

| 参数 | 含义 |
|---|---|
| `--port <n>` | 端口，缺省 8790 |
| `--host <addr>` | 监听地址 |
| `--public` | 监听所有网卡，供本机之外的客户端连接 |
| `--ai-zen-dir <dir>` | 数据根，覆盖 `AI_ZEN_DIR` |

```bash
node packages/host/dist/cli.js token create --note "笔记本"
node packages/host/dist/cli.js token list
node packages/host/dist/cli.js token revoke <id>
node packages/host/dist/cli.js stop
```

本机实例启动时会把本机客户端的凭证写进 `<数据根>/run/token`，本机不必再执行 `token create`。给别的设备用的凭证只能由 `token create` 创建，明文只在那一次的输出里出现；数据库里存的是摘要。

## 不装宿主

只要一个答案时，`core` 与 `sdk` 就够：

```bash
pnpm add @ai-zen/agents-core @ai-zen/agents-sdk
```

```ts
import {
  ConfigManager,
  DEFAULT_AGENT_ID,
  Scope,
  allInOne,
  createAgent,
} from "@ai-zen/agents-sdk";

const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
await config.bootstrap();

const scope = new Scope({
  getConfig: () => config.read(),
  agentsDir: `${base}/agents`,
  cwd: base,
}).use(...allInOne({}));
await scope.init();

const agent = await createAgent(scope, DEFAULT_AGENT_ID, { lifetime: "one-shot" });
const messages = await agent.runOnce("把这段错误日志归个类");
console.log(messages.at(-1)?.content);
```

这里没有数据库、没有常驻进程、没有对外接口。`bootstrap()` 补齐目录、`config.json`、默认 agent、默认子代理与出厂技能，已有文件不覆盖。

## 下一步

- 需要它常驻、能被反复投递、能在结果回来时被唤醒：[Agent](agent.md)
- 需要加自己的工具、技能、子代理：[能力](capabilities.md)
- 需要 MCP：[MCP](mcp.md)
- 需要多客户端、会话互发、进程重启后继续：[宿主](host.md)
