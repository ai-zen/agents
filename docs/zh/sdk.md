---
title: SDK
description: @ai-zen/agents-sdk 的公开 API：Scope、能力管线、权限模型、内置工具、插件与任务迁移。
outline: deep
---

# SDK

`@ai-zen/agents-sdk` 是建立在 `@ai-zen/agents-core` 之上的**引擎 / 能力层**，为 CLI / Desktop 提供统一 Agent 运行时。

- **安装**：`npm install @ai-zen/agents-sdk`（依赖 `@ai-zen/agents-core`，以 `workspace:^` 关联）。
- **设计真相源**：[`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md)（旧版 `sdk-design-v0.md` 为历史存档）。

## Scope —— 全局上下文 + 能力装配编排容器

`Scope` 是 SDK 的**唯一入口对象**。持有配置、工作目录、Agent 定义目录与一组能力插件（`ScopePlugin`），并整合「发现 → 过滤 → 实例化」三阶段。能力来源（内置/用户工具、Skill、MCP、SubAgent）全部疏散到插件，各自自持。

```ts
import { Scope, allInOne } from "@ai-zen/agents-sdk";

const scope = new Scope({
  config,                 // AppConfig（来自 ConfigManager）
  cwd: "/path/to/workspace",
  agentsDir: "~/.ai-zen/agents",
}).use(
  ...allInOne({                       // 恒返回 5 个标准能力插件
    subAgentsPaths: ["~/.ai-zen/sub-agents"],
    skillsPaths: ["~/.ai-zen/skills"],
    toolsPaths: ["~/.ai-zen/tools"],
    mcpPaths: ["~/.ai-zen/mcp.json"],
  }),
);
await scope.init();                   // 首次能力发现并锁定插件注册
```

关键字段与方法：

| 成员 | 说明 |
|------|------|
| `config` | 应用配置（端点、模型等） |
| `cwd` | 当前工作目录 —— 相对路径解析基准，也是 `ToolEnv.cwd` 的来源 |
| `env` | 工具环境 `{ cwd, config }`，实例化内置工具时注入 |
| `agentsDir` | Agent 定义目录（`createAgent` 用） |
| `plugins` | 已注册插件（只读视图） |
| `use(...plugins)` | 注册能力插件（链式、可变参数；须在 `init()` 之前） |
| `getPluginById(id)` | 按 id 查找插件（供外部或其它插件查询状态） |
| `async init()` | 首次全局发现，随后锁定插件注册 |
| `async refresh()` | 重新执行全局能力发现（遍历插件重新扫描文件系统） |
| `async dispose()` | 逆序释放各插件（如 MCP 断开连接）；与 `init()` 对称 |
| `filter(definition, options?)` | 阶段 2：按权限 + exclude + `isAvailable` 过滤，返回名称列表 |
| `instantiate(filtered)` | 阶段 3：名称 → Tool 实例 |
| `buildTools(definition, options?)` | `filter` + `instantiate` 一步完成 |

每个 `Scope` 对应一个工作目录；多个 Scope 可并行服务不同目录的会话，互不干扰。

## createAgent / SdkAgent

```ts
import { createAgent } from "@ai-zen/agents-sdk";

const agent = await createAgent(scope, config.defaultAgent ?? "default");
// agent 是 SdkAgent，可直接注册插件、发送消息
```

- `SdkAgent extends Agent`（来自 core），额外携带 `scope` 与 `definition`（含权限 `permissions`）。
- 权限统一从 `definition.permissions` 读取，不单独持有。

## 权限模型

四维度独立，`allow` / `deny` 互斥，无命中即拒绝。**权限即披露**：deny 掉的项对 LLM 完全不可见。

```
Agent.permissions
  ├── tools:      { allow: string[] } | { deny: string[] }
  ├── skills:     { allow: string[] } | { deny: string[] }
  ├── mcps:       { allow: string[] } | { deny: string[] }
  └── subagents:  { allow: string[] } | { deny: string[] }
```

规则：

1. 整个 `permissions` 缺失时，所有维度等同 `deny: ['*']`（全部拒绝）。
2. 存在时各维度独立判断；未配置的子维度 = 该维度 `deny: ['*']`。
3. `allow` 与 `deny` 不能同时配置（运行时抛错）。
4. 无命中 = 拒绝。
5. 通配符 `*` 匹配任意字符串。
6. 每个 Agent 的权限完全独立，不继承、不传递（`call_skill_sub_agent` 创建的临时 Skill 子 Agent 沿用调用者工具集、不再二次过滤，是有意的例外）。

匹配维度：`tools` 按工具名（如 `rm`）、`skills` 按 skill id、`mcps` 按 server 名、`subagents` 按 `function.name`。

## 内置工具（20 个类）

所有内置工具都是 `SdkCallbackTool` 子类，由 Scope 用 `ToolEnv` 实例化（每个 Scope 一套实例，注入其 `cwd`）。相对路径一律以 `ToolEnv.cwd` 解析，不依赖全局 `process.cwd()`。

| 工具 | 说明 |
|------|------|
| `cwd` / `read` / `inspect_file` / `write` / `mkdir` / `rm` / `glob` / `ls` / `exist` / `rename` / `copy` / `find_text` | 文件系统操作（`read` 可选 `range` 按行列范围读取；`inspect_file` 返回文件结构概况，流式扫描不受 300KB 限制） |
| `exec` / `spawn` | 执行命令（`exec` 支持 `timeout`；`spawn` 异步立即返回，支持 shell 重定向/管道） |
| `download_file` | 从 URL 下载并保存 |
| `batch_edit` / `edit` | 批量 / 单次替换文件文本（`batch_edit` 仅回显未匹配项）。**同一文件禁止并行 `edit`**：并行调用会各自读旧内容再写回、互相覆盖；同一文件多处修改请用 `batch_edit` 一次提交，只有不同文件才能并行 `edit` |
| `sleep` | 等待指定毫秒 |

按配置 / 模型条件注入的工具：

| 工具 | 注入条件 |
|------|----------|
| `generate_image` | 仅当配置了 `defaultImageModel` |
| `view_image` | 仅视觉模型（该 Agent 的 `modelId` 解析到 `Model.vision === true`） |

### 本地文件 → 内容块（统一入口）

`fileToContentSection()`（`shared/content-blocks.ts`，已从包入口导出）是「文件转内容块」的唯一入口。输入 `{ source, endpoint, model, signal?, maxInlineBytes?, deps? }`，返回 `{ section, transport, bytes, warning? }`；`source` 支持 `path` / `url` / `data`(Uint8Array) / `base64` 四种来源。传输方式据此自动选择：

| 条件 | 结果 |
|------|------|
| http(s) URL | `image_url`（不上传、不内联） |
| 端点声明 `capabilities.filesApi`（出厂仅 `deepseek`） | Files API 上传 → `file` 块（`file_id`）；失败自动降级为 base64 |
| 其余端点 + 图片 | `image_url` + base64 data URL |
| 其余端点 + 非图片 | `file` 块 + `file_data`（base64 data URL） |
| 模型 `vision === false` 且是图片 | 退化为 `text`（只给路径提示） |
| 内联体积 > `maxInlineBytes`（默认 8 MiB）且无法上传 | 报错（不静默塞进请求体） |

要点：

- **能力判定不再靠端点 id**：旧实现写死 `endpoint.id === "deepseek"`，用户改端点 id 就失效；现改为 `Endpoint.capabilities.filesApi` 能力位，自建端点声明即可享受上传
- **端点按当前模型反查**（`resolveModelAndEndpoint(config, ctx.agent.model)`）：`file_id` 是端点维度资源，传错端点会 not found
- **上传缓存**：`端点id + 绝对路径 + mtime + size → file_id`（最多 200 条），同一文件不重复上传
- `view_image`、`call_mcp_tool`、`read_mcp_resource` 的媒体归一均复用此模块：MCP 返回的图片/二进制不再一律 base64 内联，端点有 Files API 能力时上传为 `file_id`；转换失败退化为文本说明而不是丢掉媒体块
- 内存来源（MCP 给的 base64）**不做「解码再编码」**：内联时原样透传保证字节级一致，只有真要上传时才解码，缓存键用内容 sha256
- **非视觉模型自动退化**：`Model.vision !== true` 时图片（含 MCP 返回的）退化为一行文本提示，避免 `image_url` 被服务端 4xx 拒掉
- `call_mcp_tool` 与 `read_mcp_resource` 共用同一套输出保护：文本超限落盘 `result.txt` 并返回头尾预览，媒体块原位保留
- **公共 API**：`fileToContentSection` / `resolveModelAndEndpoint` / `supportsFilesApi` / `mimeOf` / `toDataUrl` / `base64ByteLength` / `contentHash` / `clearUploadCache` / `MIME_BY_EXT` / `DEFAULT_MAX_INLINE_BYTES` 均从包入口导出；上层应用（CLI / Desktop）构造媒体消息时直接复用，不要自己判断「上传还是内联」

工具的可用性由各工具自己的 `isAvailable(config, definition)` 声明，在 `buildTools` / `filter` 阶段过滤；发现层不做任何过滤。

工具输出保护：`AppConfig.maxToolOutput`（字符数，缺省 32768）是输出统一上限，超限时由各工具自行处置——`exec` 分文件落盘 `stdout.log` / `stderr.log`（返回各流头尾预览），`find_text` / `glob` / `ls` 落盘 `result.json`（返回头部预览），`read` 仅警告并提示用 `range` 分批读取。落盘目录为 `<tmpdir>/ai-zen/tool-output/<工具名>-<时间戳>-<随机串>/`，每次调用独立。注意 300KB 是**读取**阈值（能否读），与输出阈值是两回事。

`SdkCallbackTool` 抽象基类：

```ts
abstract class SdkCallbackTool extends Tool {
  readonly env: ToolEnv;
  isAvailable?(config: AppConfig, definition: AgentDefinition): boolean;
  abstract call(input: unknown, ctx?: ToolCallContext): unknown | Promise<unknown>;
  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent>;  // string 原样 / 内容块透传 / 其余 JSON 序列化
  resolve(p: string): string;   // 相对路径解析到 env.cwd
}
```

## 思考强度（reasoning effort）

档位**不是**全局统一枚举：各端点接受的值域不同，同一家不同型号也不同（智谱 GLM-5.3 系对 `medium` 直接报错）。所以能力声明在**模型**上（防 400），档位值存在 **Agent** 上（同一模型可给不同人格配不同强度）。

| 层 | 字段 | 作用 |
|----|------|------|
| 模型 | `Model.reasoning: { efforts, disable? }` | 物理能力上限（厂商官方文档口径，不推测） |
| Agent | `AgentDefinition.reasoningEffort?: ReasoningEffort` | 该 Agent 的实际档位，覆盖模型 `defaultParams` 里的对应参数 |

出厂声明（依据官方文档）：

| 端点 | 可调档位 | 能否关闭思考 |
|------|---------|-------------|
| DeepSeek（`/guides/thinking_mode`） | `low` / `high` / `max` | 能：`thinking.type = "disabled"` |
| 智谱 GLM-5.3 / 5.3-FLASH / 5.3-FLASHX | `low` / `high` / `max`（**其余输入报错**） | **不能**：传 `disabled` 会报错 |
| 智谱 GLM-4.7 | 不可调（`efforts: []`） | 不能（强制思考，且无 `reasoning_effort` 参数） |
| OpenAI（`Shared.ReasoningEffort`） | `minimal` / `low` / `medium` / `high` | 能：`reasoning_effort = "none"` |

写入形态由 `disable` 决定：

- `disable: "thinking"` → 同时维护 `thinking.type` 与 `reasoning_effort`（DeepSeek）
- `disable: "effort-none"` → **只写** `reasoning_effort`（OpenAI 没有 `thinking` 参数，写它会被当未知参数）
- 未声明 `disable` → 只写 `reasoning_effort`，传 `off` 直接抛错（智谱 5.3 系）

公共 API（均从包入口导出）：

| 函数 | 作用 |
|------|------|
| `resolveReasoningEffort(model, definition)` | 实际生效档位（Agent 优先，非法则回退模型默认） |
| `resolveModelParams(model, definition)` | 把 Agent 档位覆盖应用到模型参数（`createModel` 用） |
| `applyReasoningEffort(params, model, effort)` | 按能力声明写入，非法档位抛错 |
| `modelEfforts` / `modelAllowedEfforts` / `readReasoningEffort` / `isReasoningEffort` / `capabilityOf` | 能力与现状读取 |

类型：`ReasoningEffort`（`off` / `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）、`ReasoningCapability`。

`createModel(scope, modelId, { reasoningEffort })` 的第三参由 `createAgent` 从 `definition.reasoningEffort` 传入 —— 同一个模型可以给不同 Agent 配不同强度（编程 Agent `max`、闲聊 Agent `low`），而模型自身的 `defaultParams` 保持不变。

## 上下文阈值（tokenThresholds）

`Model.tokenThresholds` 有两条线，都是**绝对值**（配置里写多少就是多少，不乘任何系数）：

| 字段 | 语义 | 消费方 |
|------|------|--------|
| `handoff` | 软线：响应返回后 `usage.prompt_tokens` 超过它 → 触发任务交接 | `AutoMigratePlugin` |
| `guard` | 硬线：每次请求**前**用量超过它 → 抛 `ContextOverflowError` 中断本轮 | `ContextGuardPlugin` |

- `guard` 应当明显大于 `handoff`（出厂取 `handoff × 1.5` 并**写成整数**），给交接回合额外的 1~2 次请求留余量
- 两条线都与「模型的真实上下文窗口」无关：窗口是厂商事实，阈值是我们对「用量到了怎么办」的策略
- 想调松就调大数字——改成绝对值就是为了让安全边界可预测，而不是隐式乘以某个 ratio（旧的 `ratio` / `suspendedRatio` 已删除）
- 历史字段 `maxContextTokens`（单值）与 `maxContextChars`（字符口径已淘汰）由 `ConfigManager.read()` 读取时迁移：前者成为 `handoff`，后者按 `floor(chars / 4)` 折成 tokens，`guard` 按 1.5 倍补一次，旧键随即删除；`ensureDefaultConfig()` 检测到差异才写盘

## 核心实体类型

| 实体 | 说明 | 存储 |
|------|------|------|
| `Endpoint` | API 端点（baseUrl + apiKey + 可选 `capabilities.filesApi`） | `config.json` |
| `Model` | 模型配置，绑定一个 Endpoint，可声明 `reasoning`（思考强度能力上限） | `config.json` |
| `ImageModel` | 图片生成模型配置 | `config.json` |
| `AgentDefinition` | 可对话 AI 人格（提示词、权限、可选工具签名、可选思考档位 `reasoningEffort`）；有 `function` 即视为 SubAgent；`custom: true` 表示用户自定义（初始化不同步内置提示词） | `agents/*.json` |
| `ToolEnv` | `{ cwd, config }`，内置工具构造时注入 | 内存态 |
| `SdkCallbackTool` | 内置工具抽象基类 | 内存态 |

## 内置插件

| 插件 | 说明 |
|------|------|
| `AutoMigratePlugin` | 上下文超限时自动触发任务迁移；实际流程委托给注入的 `HandoffService`（`resolveMode` 选执行者，`busy` 防递归） |
| `AutoRefreshToolsPlugin` | 每次 `send()` 前重新刷新工具列表 |
| `ContextGuardPlugin` | 上下文安全护栏；超硬上限（`maxTokens × ratio`）时在请求前抛 `ContextOverflowError` |
| `UnknownToolHintPlugin` | 未知工具的 MCP 智能提示（显式 `agent.use` 注册） |

## ConfigManager 与出厂默认

```ts
import { ConfigManager } from "@ai-zen/agents-sdk";

const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config, agent, subAgent } = await mgr.bootstrap();   // 一键初始化（幂等）
```

- 预置端点（OpenAI / 智谱 / DeepSeek）、8 个模型（含视觉模型 `vision: true`）、3 个图片模型、默认选项。
- 出厂默认 MCP 服务器（`socket-pty`、`chrome-devtools`）首启写入 `~/.ai-zen/mcp.json`，已存在不覆盖。
- 所有 `ensure*` 操作对已存在文件不覆盖，用户配置永不丢失。

## 任务交接与迁移（HandoffService）

两层，一条管道：

- `handoff()` —— 停工、核实真实状态、写交接文档、校验（失败降级）。**不动会话**；
- `migrate()` —— `handoff()` 之后按 `strategy` 清历史，并注入一条只含文档路径的断点消息。

文档模板**不在代码里**：来自 `handoff` Skill（`~/.ai-zen/skills/handoff/SKILL.md`），由 `ConfigManager.bootstrap()` 释放并随版本同步（frontmatter 写 `metadata.custom: "true"` 可退出同步）。代码只负责读 Skill、注入、校验文件、读不到时用内置最小兜底模板。

两种执行者：`self`（默认——原 agent 在自己会话里写，上下文与工具完整）与 `summary`（一次独立调用，无工具）。`self` 失败时**单向**降级为 `summary`。

```ts
import { HandoffService, AutoMigratePlugin, ContextGuardPlugin } from "@ai-zen/agents-sdk";

const handoffService = new HandoffService({
  handoffDir: "/work/.ai-zen/handoffs",
  skillDirs: ["/work/.ai-zen/skills", "~/.ai-zen/skills"],
  onHandoff: (hctx) => { /* 存档旧历史（此时已包含交接回合） */ },
  onMigrated: (hctx) => { hctx.agent.lastUsage = undefined; },
});

agent.use(new ContextGuardPlugin({ maxTokens: 250_000, isSuspended: () => handoffService.busy }));
agent.use(new AutoMigratePlugin({ service: handoffService, maxTokens: 250_000 }));
```

- 策略 `strategy`：`omit`（默认，历史标记 `omit: true` 保留可审计）/ `prune`（物理剔除）。
- `service.busy` 期间自动迁移插件让行（防递归），护栏放宽到 `× 2`（交接回合不被误杀，仍保留熔断）。
- `HandoffGuardPlugin` 仅在交接回合生效：拦截 `edit` / `rm` / `rename` 等，`write` 只放行交接文档（软拒绝，把模型引回正题）。
- 不重建 Agent，仅重建消息列表；交接失败不会丢原消息。



## 消费模式（完整）

详见 [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) 的「消费模式（完整示例）」与「与 Core 的边界」章节。

## 相关文档

- [快速开始](getting-started.md)
- [架构](architecture.md)
- [Core API](core.md) —— 运行时底层 API
- [MCP](mcp.md) —— SDK 的 MCP 连接管理
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) —— SDK 设计真相源
