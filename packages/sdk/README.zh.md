# @ai-zen/agents-sdk

AI-Zen SDK — 共享业务逻辑层，为 CLI 和 Desktop 提供统一的 Agent 运行时。开箱即用，包含预置厂商配置、默认 Agent 和 SubAgent。

## 真相源

**[`docs/sdk-design-v1.md`](./docs/sdk-design-v1.md)** 是本包的唯一设计真相源。所有实现必须与文档一致。（重构前的设计保留在 [`docs/sdk-design-v0.md`](./docs/sdk-design-v0.md)。）
## 架构

```
CLI ──┐
      ├── @ai-zen/agents-sdk ──┐
Desktop ──┘                    │
                          LLM API
```

## 模块分层

```
types         ← 纯类型，零业务依赖（含 ToolEnv 工具环境）
config        ← ConfigManager + constants：读写 config.json + 目录初始化 + 出厂默认
crud          ← 能力实体 CRUD（Agent 定义等；会话/草稿已下放给各端自行持久化）
runtime       ← 模型工厂 + Agent 组装 + 任务交接/迁移（可 `AbortSignal` 取消；createModel / createAgent / SdkAgent / HandoffService / HandoffGuardPlugin）
scope         ← Scope 编排容器 + ScopePlugin 契约 + PermissionEvaluator / disclosure + plugins/（5 个自包含能力来源：发现 + 工具 + 插件）
agent-plugins ← Agent 插件（autoMigrate、autoRefreshTools、contextGuard、unknownToolHint）
shared        ← 日志、错误
```

依赖方向：`agent-plugins → runtime → scope`；`runtime → scope / crud / shared / types`，`scope → types / shared`。上层依赖下层，反之不行。

## 核心概念

| 实体 | 说明 |
|------|------|
| **Scope** | 编排容器：全局上下文（`config` / `cwd` / `agentsDir`）+ 三阶段能力管线（发现 → 过滤 → 实例化）+ 插件注册表。经 `scope.use(...)` 显式装配 |
| **ScopePlugin** | 能力插件（v1 扩展点）：自持一类能力的发现状态、候选名与实例化（`discover` / `candidates` / `instantiate` / `dispose`）。内置 5 个标准插件，经 `allInOne()` 一键装配 |
| **ToolEnv** | 工具环境 `{ cwd, config }`，内置工具插件（`BuiltinToolsScopePlugin`）实例化工具时注入，作为相对路径解析与配置读取的基准 |
| **SdkCallbackTool** | 内置工具抽象基类：`env` 构造注入 + 子类实现 `call()` + `resolve()` 相对路径解析 |
| **SdkAgent** | 继承 Core Agent，携带 SDK 元数据，支持 `use()` 插件注册 |
| **AgentPlugin** | 插件接口（`onInit`, `onBeforeSend`, `onAfterSend`, `onInnerLoopStart`, `onInnerLoopEnd`, `onInnerLoopsStart`, `onInnerLoopsEnd`, `onToolCall`, `onUnknownTool`, `onSubAgentStart`, `onSubAgentEnd`） |
| **Endpoint** | API 端点（baseUrl + apiKey） |
| **Model** | 模型配置，绑定 Endpoint |
| **SubAgent** | 有 `function` 字段的 Agent，可被其他 Agent 作为工具调用 |

## 权限模型

四维度各自独立，allow/deny 互斥，无命中即拒绝，权限即披露（deny 掉的项对 LLM 完全不可见）。

```
Agent.permissions
  ├── tools:      { allow: string[] } | { deny: string[] }
  ├── skills:     { allow: string[] } | { deny: string[] }
  ├── mcps:       { allow: string[] } | { deny: string[] }
  └── subagents:  { allow: string[] } | { deny: string[] }
```

## 消费模式

```typescript
const scope = new Scope({
  config,
  cwd: "/path/to/workspace", // 每个 Scope 一个工作目录，多会话并行互不干扰
  agentsDir,
}).use(
  ...allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths }),
);
await scope.init();

const agent = await createAgent(scope, "my-agent");
const handoffService = new HandoffService({ handoffDir: "/work/.ai-zen/handoffs", skillDirs });
agent.use(new ContextGuardPlugin({ maxTokens, isSuspended: () => handoffService.busy }));
agent.use(new AutoMigratePlugin({ service: handoffService, maxTokens }));
agent.use(new AutoRefreshToolsPlugin());
agent.use(new UnknownToolHintPlugin({ scope }));
await agent.init();
await agent.send("你好");

await scope.dispose(); // 断开 MCP、释放插件资源
```

## 开发状态

| 模块 | 状态 |
|------|------|
| `types` | ✅ 已实现 — 核心实体、权限模型、MCP 类型完整 |
| `config` | ✅ 已实现 — ConfigManager + 出厂默认配置 + 一键 bootstrap |
| `crud` | ✅ 已实现 — Agent 等能力实体 CRUD（会话/草稿由各端自行持久化） |
| `scope` | ✅ 已实现 — Scope + ScopePlugin + 5 个标准插件（builtin / user-tools / skills / mcp / subagents）+ allInOne |
| `runtime` | ✅ 已实现 — createAgent、MCP 连接管理、任务迁移 |
| `agent-plugins` | ✅ 已实现 — AutoMigratePlugin / AutoRefreshToolsPlugin / ContextGuardPlugin / UnknownToolHintPlugin |
| `shared` | ✅ 已实现 — SdkError + 可注入 Logger |

## 内置工具

内置工具全部类化（继承 `SdkCallbackTool`），由内置工具插件（`BuiltinToolsScopePlugin`）用 `ToolEnv` 实例化——每个 Scope 一套实例，`cwd` 注入，相对路径以 `Scope.cwd` 为基准，不依赖全局 `process.cwd()`。

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `read` | 读取文件（可选 `range` 按行列范围读取；输出超限仅警告并提示用 `range` 分批） |
| `inspect_file` | 勘察文件结构概况（行数、列数分布等），流式扫描不受 300KB 限制 |
| `write` | 写入文件 |
| `exec` | 执行命令（支持 `timeout` 超时参数；stdout+stderr 超限时分文件落盘 `stdout.log` / `stderr.log`） |
| `spawn` | 异步执行命令，启动后立即返回，不等待结果 |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 使用 glob 模式扫描查找文件（输出超限落盘 `result.json`） |
| `ls` | 列出目录内容（输出超限落盘 `result.json`） |
| `exist` | 检查文件或目录是否存在 |
| `find_text` | 在文件中搜索文本或正则（输出超限落盘 `result.json`） |
| `download_file` | 从 URL 下载文件并保存到本地 |
| `rename` | 重命名或移动文件/目录 |
| `copy` | 复制文件或目录 |
| `batch_edit` | 批量编辑文件文本（仅回显未匹配项，成功项只计数） |
| `edit` | 编辑文件中的文本 |
| `sleep` | 等待指定毫秒数后继续 |

条件注入（按当前模型 / 配置决定是否注册）：

| 工具 | 注入条件 | 说明 |
|------|----------|------|
| `generate_image` | 配置了 `defaultImageModel` 才注册 | 根据文字描述生成图片 |
| `view_image` | 仅视觉模型可用（Agent 的 `modelId` 解析为 `vision: true` 的模型） | 查看/分析图片：本地图片自动经 Files API 上传，网络 URL 直接引用 |

工具输出保护：`AppConfig.maxToolOutput`（字符数，缺省 32768）是工具输出的统一上限，超限时由各工具自行处置——`exec` 分文件落盘 `stdout.log` / `stderr.log`（返回各流头尾预览），`find_text` / `glob` / `ls` 落盘 `result.json`（返回头部预览），`read` 仅警告并提示用 `range` 分批读取。落盘目录为 `<tmpdir>/ai-zen/tool-output/<工具名>-<时间戳>-<随机串>/`，每次调用独立、不自清理。详见 [`docs/sdk-design-v1.md` §12](docs/sdk-design-v1.md)。

中断策略进配置：`AppConfig.abortedMessageStrategy`（`keep` / `drop`，出厂 `keep`——中断后模型能接着半截往下说）与 `AppConfig.abortedToolRoundStrategy`（`fill` / `drop`，出厂 `fill`——整轮进出，`tool_calls` 必须与结果配对）。`createAgent()` 不传参数时直接取 `scope.config`，于是策略只有一个真相源。

## 内置插件

| 插件 | 说明 |
|------|------|
| `AutoMigratePlugin` | 上下文超限时自动触发任务迁移（历史按 `strategy` 处理：默认 `omit` 标记保留可审计，可选 `prune` 物理剔除），委托注入的 `HandoffService`；`resolveMode` 让调用方决定交接执行者或跳过本轮；`service.busy` 期间让行，避免「交接→迁移→交接」递归 |
| `AutoRefreshToolsPlugin` | 每次 `send()` 前重新扫描文件系统，刷新工具列表 |
| `ContextGuardPlugin` | 上下文安全护栏 — 每轮发请求前检测上一轮 `usage.prompt_tokens`，超过 `maxTokens × ratio`（默认 1.5，即 +50%）时抛 `ContextOverflowError` 中断对话，防止读入超大文件导致上下文失控 |
| `UnknownToolHintPlugin` | 未知工具智能提示 — LLM 调用不存在的工具时，根据 MCP 配置引导使用 `call_mcp_tool` / 提示权限问题（调用方显式 `agent.use` 注册） |

## 语言

SDK 是 **English-only**：所有面向模型与面向用户的文案（工具 schema 描述、出厂提示词、运行期注入语、工具返回值、错误信息、出厂 catalog 数据）都是**固定英文字面量**。没有 locale 字段、没有语言包、没有运行期切换。界面语言完全属于各端（CLI 的 `i18n/`、Desktop 的语言设置）。

这是**性能边界**，不是图省事 —— **SDK 的行为与性能不得随用户语言变化**：

- **阈值是绝对量。** `Model.tokenThresholds.handoff` / `guard` 与 `AppConfig.maxToolOutput` 都以 token / 字符的绝对值为判据。工具 schema 换个语言就是另一组 token 数 —— 交接与上下文阻断会在**不同的实际内容量**上触发。同一份 `config.json` 在不同语言下跑出不同行为。
- **schema 成本每轮都付。** 描述文字随每次请求重发，token 差异是摊在每一轮上的持续开销，会改变请求体积、上下文占用与费用，而不是一次性成本。
- **缓存前缀不再可比。** prompt 缓存按前缀匹配；语言一旦进入 SDK，同一条代码路径就有了多个前缀形态，基准测试失去单一变量。
- **基准与排查需要单一形态。** 性能数据、bug 复现、工具调用成功率都要能横向比较；行为若随 locale 漂移，任何结论都得先问「你是什么语言」。

「模型跟随用户语言」由一条语言中立的 system prompt 指令承担 —— `Always reply in the same language the user writes in.` —— 按**每条消息**自适应，比按安装实例绑定 locale 更准确，也不需要 SDK 参与。完整论述见 [`docs/sdk-design-v1.md` §1](docs/sdk-design-v1.md)。

## 设计原则

参见项目根 [`PRINCIPLES.md`](../../PRINCIPLES.md)：

1. 逻辑自洽
2. 设计为先，文档为准
3. 对称、统一
4. 去除过度设计
5. 奥卡姆剃刀
6. 即时重构，保持分层
7. 测试是基石
