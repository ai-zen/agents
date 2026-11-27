# AI-Zen Agents

自己部署的 agent 运行时。agent 装配完成之后驻留：每收到一次投递处理一批，跑完回到空闲继续等；也可以只要一次调用、一个答案。模型走 OpenAI 兼容接口，会话、消息、凭证与能力都在自己的机器上。

## 一次调用

最小的用法是两个包，一次请求，一个答案：

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
await config.bootstrap(); // 建目录、写 config.json 与默认 agent

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

这里不需要宿主——没有数据库、没有常驻进程、没有对外接口，只有一次请求和一个答案。宿主是一台机器上的常驻服务，见「换成一台机器上的服务」。`core` 是 agent 本身（队列、请求与工具的循环、事件流），`sdk` 负责从文件装配它。

`bootstrap()` 写出的 `config.json` 里有四个出厂端点，`apiKey` 都是空串，填一个就能运行；默认 agent 绑的是 `deepseek-flash`。

## 同一个 agent 常驻

去掉 `lifetime` 就是常驻：它不再随那一次调用结束而终结，装配完成之后一直等待投递。

```ts
const agent = await createAgent(scope, DEFAULT_AGENT_ID);

agent.on("state:idle", () => {
  console.log(agent.messages.at(-1)?.content);
});

void agent.start();
agent.send("看一下这个目录");
agent.send("检查 package.json 的 scripts"); // 排在后面，不打断前一条
```

`send()` 投递完成即返回。agent 在后台处理，本批结束后回到空闲，事件流中出现 `state:idle`；队列里还有未处理的条目时，不会报空闲。

- 空闲的 agent 不发请求、不轮询、不占 CPU，只驻留在内存中
- 投递进入队列，处理过程中投进来的条目不会丢失，按优先级排队：高的在本批工具执行完的间隙取走，低的等本批结束
- 停止有三种：`abort()` 中断在途请求、本批不再往下取；`stop()` 停止接收新输入、存量处理完再终结；`kill()` 立刻终结并作废排队
- 事件流是唯一的观察方式：`started`、`messageAdded`、`delta`、`toolStarted`、`state:idle`……每条带这个 agent 自己的递增序号与时刻，界面、日志、另一个 agent 都通过订阅它得知发生了什么

`core` 没有 `run()` 这种「传入后等待结果」的入口，也没有轮询接口。一次性调用是常驻之上的封装：`runOnce()` 启动、投递一句、等空闲、关门。

**工具同样不阻塞。** 常驻的直接后果是将来返回的结果有接收方：`async_exec` 启动一条命令后立即返回，命令结束（正常退出、超时被杀、未能启动）时，把输出与退出码作为一条新消息投回这段会话。那一刻 agent 可能已经空闲，这条消息将它唤醒继续处理。

同一条路用在三处：

| 结果何时回来 | 投回什么 |
|---|---|
| `async_exec` 的命令结束 | 输出与退出码（超时被杀会写明） |
| `async_timeout` 到点 | 一条到点提醒 |
| MCP 服务端的长任务到达终态 | 一条通知，正文指向 `get_mcp_task_result` |

三条都按高优先级投递，理由是可靠性而非重要性：等待结果的一方常常正在轮询（`sleep`、反复取结果），低优先级要等本批结束，而本批正停在轮询里，结果无法投递进去。

三处对应的约束：一次性 agent 没有这两个后台工具，因为它没有「稍后存在的接收方」；会话已经不存在时通知被丢弃并记一行日志，不复活会话；`stop()` / `kill()` 会把这段会话名下未结束的命令与定时器一并终止，不留下孤儿进程。

## 加能力：往目录里放文件

内建 22 个工具，覆盖文件读写、命令执行、搜索、异步命令与图片生成查看。要增加自己的工具，就把文件放进目录：

```ts
.use(...allInOne({
  toolsPaths: [`${base}/tools`],
  skillsPaths: [`${base}/skills`],
  subAgentsPaths: [`${base}/sub-agents`],
  mcpPaths: [`${base}/mcp.json`],
}))
```

一个工具是一个文件，导出一个带 `function` 与 `exec` 的对象：

```js
// tools/echo.mjs
export default {
  function: {
    name: "echo",
    description: "把输入原样返回",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  async exec(args) {
    return args.text;
  },
};
```

改动之后调用 `scope.refresh()` 生效；宿主中由 `autoRefreshTools` 决定时机（每次请求前 / 每批开头 / 只靠 `/reload`）。

**能加什么由权限决定。** agent 定义里的 `permissions` 分四维——`tools`、`skills`、`mcps`、`subagents`，每维写 `allow` 或 `deny` 其中一种，支持 `*`：

```json
"permissions": {
  "tools": { "deny": ["rm", "exec"] },
  "skills": { "allow": ["*"] },
  "mcps": { "allow": ["fs-server"] },
  "subagents": { "allow": [] }
}
```

名单之外的名称不会出现在模型的工具清单里。模型看不到它，也就不会调用它——不是等调用发生之后再拒绝。某一维整维不写，等于这一维全部禁用。

## 渐进式披露：清单里只有入口

技能本身就是渐进式披露：清单里只放一个 `load_skill`，正文到用到时才读。这套做法在这里延伸到了 MCP 服务器与子代理——入口同样只有一把。

工具清单每次请求都要发送一遍，装多少能力，清单就有多长。所以技能、MCP、子代理都不把内容放进清单，只放一个入口：

| 入口 | 何时才读进上下文 |
|---|---|
| `load_skill` | 需要按某个流程执行时，读取那一个技能的正文 |
| `load_mcp` | 需要连接某台服务器时，建立连接并取回它的工具、资源、提示与技能清单 |
| `call_mcp_tool` | 调用该服务器上的具体工具，按它自己的 schema 传参 |
| `read_mcp_resource` · `get_mcp_task_result` | 读资源、取长任务的结果 |
| 每个子代理自己的入口 | 委派任务时由子代理自己那份上下文执行 |

无论配了多少台 MCP 服务器、多少个技能，这个 agent 的工具清单长度不变。候选名是枚举，模型从清单中选取，不需要猜名字；一台服务器都没配时，参数退化为自由文本，描述中会说明这一点。

连接本身也是按需的：发现阶段只读配置文件，不建立连接；`load_mcp` 那一刻才连；`include_manifest=false` 时只连接、不取清单。

## 换成一台机器上的服务

宿主负责三件进程之外的事：会话与历史落库（进程退出后仍然存在）、多个客户端同时连接、会话之间互相发话。它持有数据库、会话、工作区与凭证，在回环地址上提供接口，按需把会话装配成 agent。

```bash
pnpm -r --filter '@ai-zen/agents-host...' build

node packages/host/dist/cli.js serve            # 缺省监听回环地址 8790
node packages/host/dist/cli.js token create     # 给别的设备造一串凭证，明文只出现这一次
node packages/host/dist/cli.js token list
node packages/host/dist/cli.js token revoke <id>
node packages/host/dist/cli.js stop
```

`serve` 启动后打印监听地址、版本、发现文件、日志目录；本机实例另给一个凭证文件，本机客户端直接读取它，不必再造凭证。其余参数：`--port <n>`、`--host <addr>`、`--public`（允许非回环来源）、`--ai-zen-dir <dir>`。

数据库中存的是凭据摘要，创建之后再也读不回明文。终端客户端 `@ai-zen/cli` 是这些接口的一个使用者：一个可执行文件，管道与交互界面两种用法。

宿主不预装所有会话：一段会话被使用之前没有 agent，先唤醒、再投递；唤醒只填补「行在、agent 不在」这一格，不新建会话。进程退出也不影响会话——历史在数据库中，下次唤醒时按「历史 + 未取走的条目」装回同一个上下文。

## 会话之间可以直接说话

三把工具：`create_session`、`post_message`、`read_session_status`。

- 会话是平级的：开出来的那一段有自己的历史、工具与模型，不是父会话里的一次函数调用
- 发话不阻塞：`post_message` 投递完成即返回，对方正在处理时同样投递，它会在下一次工具间隙取走
- 双向：被开出来的那一段同样具备这三把工具，只少了 `create_session`，因此只能开一层
- `read_session_status` 只回答忙闲、名字与最近一句，不搬运历史——需要全文时用 `post_message` 询问

用途是并行：几段会话各负责一部分，结果互相传递；或者开一段新会话去做长任务，当前会话继续与用户对话。

## 上下文写满时交接，而不是压缩

模型定义上有两条阈值：`tokenThresholds.handoff` 是软线，越过之后 agent 空闲时交接；`tokenThresholds.guard` 是硬线，每次请求前比对，越线就拒掉这一次请求。出厂口径是窗口的 40% 与 80%。

触线之后 agent 停止推进，只做两件事：先核实真实状态（只许只读——`read`、`glob`、`find_text`、`git status`、`git diff` 这类，不许改代码、不许提交），再把结果写入一份 markdown。

**它与压缩的区别在产物是什么。**

| | 压缩 | 交接 |
|---|---|---|
| 产物 | 模型上下文里的一段文本，这一代结束即消失 | 项目目录里的一份 markdown：`<项目>/.ai-zen/handoffs/<时间戳>.md` |
| 内容 | 由模型自行决定保留什么，读者无法判断遗漏 | 固定九节：对话断点、任务目标、现状、已完成、未完成、关键决定、约束与偏好、文件索引、接手第一步 |
| 真实性 | 只能从对话中推断 | 写入之前先核实：分支与提交、未提交改动、测试是否通过、端口是否在运行、依赖是否安装；无法核实的必须写 `⚠️ Unverified`，禁止推测 |
| 可否审阅 | 不能，只有形状 | 能：直接打开阅读、两次交接可以 diff、可以进版本库、可以交给他人审阅 |

由此有三件事成立：

- **可审计**：任何人读得到「当时为什么这么做、哪些确实完成、哪些尚未了结」，不必依赖一段摘要
- **可追溯**：宿主把这次交接落成数据库中的三条记录——一条只带文档路径的断点消息、一条「交接文档已写到 <路径>」的通知、一段 `nameSource` 为 `handoff` 的存档会话行；原会话的历史整段挂到那一段上，仍然可以回看
- **可交给他人续接**：文档是纯 markdown，断点消息只带路径，续接不依赖这套运行时。换一个开发者、换一个编程智能体、换一台机器，读那份文档就能继续

交接之后的记忆是「原模板 + 一条只带文档路径的断点消息」。不装宿主时旧消息标记 `omit` 保留在数组中、不再发送给模型；宿主那一路整段剔除，因为它们已经在存档会话里。

交接文档的九节格式与写作规则本身是一份出厂技能（`skills/handoff/SKILL.md`），可以直接修改。

## 花费

模型调用按请求计费，成本只有两个来源：请求的次数，以及每次请求的输入长度。

| 机制 | 省在哪里 |
|---|---|
| 前缀缓存 | 请求体按白名单重建，不带消息 id 与时间戳，同一段对话的发送前缀逐字节稳定；端点声明了 `providerSessionHeader` 时还会带上一个稳定标识（宿主用会话 id，进程重启后不变），服务方据此命中前缀缓存 |
| 渐进式披露 | 技能正文、MCP 远端工具、子代理细节都不进工具清单，只在用到的那一刻进入上下文 |
| 工具输出上限 | 单次工具输出超过 32768 字符（可配）时，超长的那一段不整段进入上下文：`exec` 这类工具把全文落盘，模型只拿到头尾预览与路径 |
| 委派隔离 | 子代理有自己的历史与工具，父那一侧只收到它最后一条内容与累计用量；中间几十次工具调用不进父的上下文 |
| 辅助请求另算 | 会话自动起名与交接摘要走单独的一次性调用：不流式、不带工具；起名只发送前 2000 字符，两者都可以指定比主模型便宜的模型 |
| 越线不发 | 硬线之上直接拒掉这一次请求，不为一次注定失败的请求付费 |
| 结果投回 | 长命令与定时器不必挂着等待，也就不必用 `sleep` 反复轮询——每次轮询都是一次全量输入 |
| 中断不重来 | 被中断的半截回答可以保留（`abortedMessageStrategy: keep`），下一次接着往下说；工具轮次整轮归一（`fill`），不会因为一次中断整段重做 |
| 用量可查 | 每条 assistant 消息上带着这一次请求的 token 用量，累加即这段会话的实际消耗 |

`self` 方式交接本身要多跑 1~2 次全量输入，那一次的输入比平时长，换掉的是一份会持续增长的历史。

## 参考

### 组成

| 包 | 负责什么 |
|---|---|
| `@ai-zen/agents-core` | Agent 本身：一条输入队列、请求与工具的循环、一条事件流。不读配置文件，不写磁盘 |
| `@ai-zen/agents-sdk` | 能力装配与配置：定义文件、工具、技能、子代理、MCP 装配成一个能运行的 agent；常驻运行时、交接也在这层 |
| `@ai-zen/agents-host` | 常驻进程：数据库、会话、工作区、凭证与资产，回环地址上的接口 |
| `@ai-zen/cli` | 终端客户端，管道与交互界面两种用法 |
| `@ai-zen/agents-client` | 连接宿主的客户端库（内部包，`cli` 使用） |
| `@ai-zen/agents-logger` | 写文件的日志实现 |
| `@ai-zen/fake-llm` | 测试用的假模型服务 |

### 数据根

由 `AI_ZEN_DIR` 指定，缺省 `~/.ai-zen`：

```
~/.ai-zen/
├── config.json        端点、模型、默认模型、上下文阈值等
├── agents/            每个 agent 一份定义，文件名即 id
├── sub-agents/        子代理定义（带 function 字段的 agent 定义）
├── skills/            技能目录，一个技能一个子目录
├── tools/             用户工具，一个文件一个工具
├── mcp.json           MCP 服务器
├── ai-zen.db          会话、消息、工作区、资产、凭证
├── logs/
└── run/               host.json（连接地址）、token（本机凭证）、next-version.json
```

### agent 定义

`<数据根>/agents/default.json` 就是完整的 agent：系统提示在 `messages` 里，模型绑在 `modelId` 上，能力由 `permissions` 限定，请求参数写在 `modelParams` 里。

```json
{
  "id": "default",
  "name": "Default Assistant",
  "messages": [{ "role": "system", "content": "You are a helpful assistant." }],
  "modelId": "deepseek-flash",
  "permissions": {
    "tools": { "allow": ["*"] },
    "skills": { "allow": ["*"] },
    "mcps": { "allow": ["*"] },
    "subagents": { "allow": ["*"] }
  },
  "modelParams": { "thinking": { "type": "enabled" } }
}
```

模型按三级解析：会话级覆盖 > 定义里的 `modelId` > `config.json` 的 `defaultModel`。三级都取不到就报错，并指出是哪份定义没有绑定模型。`modelParams` 与模型的 `defaultParams` 做一次浅合并，因此同一个模型可以给编程用的 agent 配高强度推理，给闲聊用的关掉思考。

### 能力目录的层次

同名以近的为准，由近及远四层：

1. `<项目>/.ai-zen/skills`
2. `<项目>/.agents/{skills,tools,sub-agents}`
3. `<数据根>/{skills,tools,sub-agents}`
4. `~/.agents/skills`

MCP 另有五层文件（项目根的 `mcp.json`、`<项目>/.ai-zen/mcp.json`、`<项目>/.agents/mcp.json`、`<数据根>/mcp.json`、`~/.agents/mcp.json`），合并成一份有效清单。

工具文件是 `.js` / `.mjs`，由 `import()` 求值，因此加载时挡掉 `process.exit` 与 `process.abort`，把 `console` 改指 stderr，单个文件超过 5 秒未加载完成即放弃。

### 内置工具

`cwd`、`read`、`inspect_file`、`write`、`edit`、`batch_edit`、`find_text`、`glob`、`ls`、`exist`、`mkdir`、`rm`、`rename`、`copy`、`exec`、`spawn`、`sleep`、`download_file`、`async_exec`、`async_timeout`、`generate_image`、`view_image`。

一次性 agent（`lifetime: "one-shot"`）不具备 `post_message`、`create_session`、`read_session_status`、`async_exec`、`async_timeout`：它不属于任何一段会话，也没有「稍后存在的接收方」，这些工具对它只有必然失败的路径。

## 开发

各包构建入口在根目录：`pnpm build-core`、`pnpm build-logger`、`pnpm build-sdk`、`pnpm build-host`、`pnpm build-client`、`pnpm build-fake-llm`。`pnpm test` 先构建依赖再依次跑各包。

端到端套件需要真实端口、真实磁盘与真实 WebSocket，不在 `pnpm test` 之内：

```bash
cd packages/host
npx vitest run                                  # 域内用例：不起端口、不写真实磁盘
npx vitest run --config vitest.e2e.config.ts    # 端到端
```

## 许可

MIT
