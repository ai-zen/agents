# Changelog

## [1.0.0-alpha.0] - 2026-09-30

### 💥 Breaking Changes

- **`Provider` 改名为 `Scope`（彻底移除，不留兼容别名）** — 原 `runtime/Provider.ts` 迁移为 `scope/Scope.ts`。所有 `provider` 字段 / 参数 / 变量一律改名 `scope`：`SdkAgent.provider` → `SdkAgent.scope`、`createAgent(scope, …)`、`createModel(scope, …)`、`createSubAgentTool(def, scope)`。`FilterOutput` / `ExcludeOptions` / `FilterOptions` 随之从 `runtime/Provider` 迁移到 `scope/Scope`。
- **能力来源"疏散"为 `ScopePlugin`（新增能力插件契约）** — `Scope` 退化为纯编排容器：只持 `config` / `cwd` / `env` / `agentsDir`，并编排三阶段管线（发现 → 过滤 → 实例化）。原先硬编码在 `Provider.refresh/filter/instantiate` 中的四类能力来源，拆成 **5 个标准插件**，各自自持发现状态与实例化逻辑：
  - `BuiltinToolsScopePlugin`（`id: "builtin"`）— 20 个内置工具类
  - `UserToolsScopePlugin`（`id: "user-tools"`）— `tools/*.js`
  - `SkillsScopePlugin`（`id: "skills"`）— `SKILL.md` + `load_skill` / `call_skill_sub_agent`
  - `McpScopePlugin`（`id: "mcp"`）— `mcp.json` + 私有 `McpConnectionManager` + `load_mcp` / `call_mcp_tool` / `read_mcp_resource`
  - `SubAgentsScopePlugin`（`id: "subagents"`）— `sub-agents/*.json`
- **`Scope` 不再接收能力来源路径、不再暴露聚合候选集** — `new Provider({ config, cwd, agentsDir, skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })` → `new Scope({ config, cwd, agentsDir })`。路径改由插件持有（可传绝对路径，或传相对路径由插件在 `discover()` 时基于 `scope.cwd` join）。`Scope` 不再有 `builtinTools` / `userTools` / `subagents` / `skills` / `mcps` / `mcpManager` 字段。
- **`Provider.create()` 移除** — 改为显式装配：`new Scope({...}).use(...plugins)` → `await scope.init()`。（静态 `create` 快捷方式暂时移除，未来再议。）
- **插件必须显式装配** — `Scope` 自身不注册任何默认插件；不装配即"空能力"。便捷工厂 `allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })` 恒返回 5 个标准插件，供一次性装配。

### 🚀 New Features

- **新增 `ScopePlugin` 扩展点** — 契约 `{ id; discover?; candidates; instantiate; dispose? }`，与 core 的 `AgentPlugin`（Agent 运行时钩子）互为独立扩展点：
  - `discover?(scope, { silent })` — 阶段 1 · 发现（可异步，内部重新扫描）
  - `candidates(scope, definition)` — 阶段 2 · 贡献四维候选名（含可用性判断，如同步 `isAvailable`）
  - `instantiate(scope, filtered)` — 阶段 3 · 按过滤后允许名产出 `Tool[]`
  - `dispose?()` — 释放（如 MCP 断开连接）
- **`Scope` 新增 API**：`use(...plugins)`（链式、可变参数）、`getPluginById(id)`（供外部/插件查询插件状态）、`plugins`（只读视图）、`init()` / `refresh({ silent })` / `filter()` / `instantiate()` / `buildTools()` / `dispose()`。`init()` 之后再 `use()` 抛错。
- **`dispose()` 与 `init()` 对称** — 逆序调用各插件 `dispose()`；`McpScopePlugin.dispose()` → `mcpManager.disconnectAll()`，MCP 长连接不再只依赖空闲超时。
- **`allInOne()` 便捷工厂** — 恒返回 5 个标准插件，顺序即优先级（`builtin → user-tools → skills → mcp → subagents`，去重时后注册覆盖先注册，用户工具仍可覆盖同名内置工具）。
- **`McpScopePlugin.hasConfig()`** — 供 `UnknownToolHintPlugin` 判断"是否有 MCP 配置"（替代对 `provider.mcpPaths` 的直接读取）。

### 🛠 Optimized

- **`UnknownToolHintPlugin` 构造改收 `{ scope }`** — 经 `scope.getPluginById(McpScopePlugin.ID)?.hasConfig()` 获知 MCP 配置，行为语义不变（有配置但 `call_mcp_tool` 被禁 → 提示权限；可用 → 引导使用；无配置 → 仅提示不存在）。
- **`AutoRefreshToolsPlugin`** — 改经 `agent.scope.refresh()` / `agent.scope.buildTools()`。
- **渐进式披露（懒加载）设计零改动** — `load_skill` / `call_skill_sub_agent` / `load_mcp` / `call_mcp_tool` / `read_mcp_resource` 的 schema、枚举披露（`createDisclosureParam`）、`include_manifest` 开关、`touch` 续期、`call_skill_sub_agent` 沿用父工具集并剔除自身防递归——全部**逐字保留**，仅从 `Provider.instantiate()` 平移到 `SkillsScopePlugin` / `McpScopePlugin` 的 `instantiate()`。权限语义（`tools` 维度拒绝 `load_*` 即切断披露通道；deny 掉的 skill/mcp 不进 enum）不变。

### 📄 Docs

- 新增 [`docs/sdk-design-v1.md`](docs/sdk-design-v1.md)（v1 设计真相源，含 Scope / ScopePlugin 架构、五插件、迁移指南）；旧文档更名为 [`docs/sdk-design-v0.md`](docs/sdk-design-v0.md)。

### ✅ Tests

- 全部测试迁移到 Scope + ScopePlugin：`capabilities.test.ts` 重写为按插件维度组织（内置 / SubAgent / Skill / MCP / 用户工具 + 生命周期），`createAgent` / `createModel` / `SdkAgent` / `UnknownToolHint` / `AutoRefreshTools` / `subAgentTools` / `integration` / `e2e-*` 同步更新。SDK 全量 **498 passed / 2 skipped**（含真实 DeepSeek API 的 chat / view-image e2e）。

## [0.12.0] - 2026-09-29

### 🚀 New Features

- **统一工具输出保护（`maxToolOutput`）** — `AppConfig` 新增 `maxToolOutput?: number`（字符数，缺省 32768；出厂 `DEFAULT_APP_CONFIG` 已写入该值）。新增输出保护骨架 `guardOutput()`（`capabilities/implements/builtin/outputGuard.ts`）：工具以三个回调自陈策略——`isOverLimit(content)`（工具自读 config 判定，含合计口径）、`dump(dir, content)`（落盘文件清单，缺省即"只警告不落盘"）、`buildWarning(ctx)`（返回体，含预览与统计）；骨架只负责"判定 → 未超限原样返回 / 超限时落盘"两件事。落盘目录为 `<os.tmpdir()>/ai-zen/tool-output/<工具名>-<时间戳>-<随机串>/`，每次调用独立互不覆盖，不做自清理（依赖系统对临时目录的策略）。已接入：
  - **`exec`** — `stdout + stderr` 合计超限即分文件落盘 `stdout.log` / `stderr.log`，返回警告 + 各流头尾预览（各 1000 字符）+ 字符数/行数统计，原 `exitCode` / `killed` / `terminated` 字段保留；
  - **`findText`** — 落盘 `result.json`，返回警告 + 头部预览（1000 字符）；既有 `maxMatches` / `maxFileSize` / `maxLineLength` 参数保持不变；
  - **`glob` / `ls`** — 落盘 `result.json`，返回警告 + 头部预览，并提示缩小范围的方式（更精确的 `pattern` / `exclude`，或改用 `glob`）；
  - **`readFile`** — 超限**不落盘**，仅返回警告并提示使用 `range` 分批读取。
  - 另导出 `headPreview()` / `headTailPreview()` 供各工具按需组织预览（预览文本由工具自行生成）。
- **`readFile` 新增 `range` 参数（可选）** — `range: [起始行, 起始列, 结束行, 结束列]`，行列均 0-based、`-1` 表示末位；如 `[0, 0, 100, -1]` 表示"第 0 行第 0 列读到第 100 行最后一列"。300KB 读取阈值保持不变——读取阈值（能否读）与输出阈值（是否落盘）互相独立。
- **新增 `inspectFile` 工具（`InspectFileTool`）** — 勘察文件结构概况，不做内容读取，与 `readFile` 的 `range` 配套（先看结构，再决定读取范围）。返回 `path` / `bytes` / `lines` / `chars` / `maxCol` / `lineIndexOfMaxCol`（0-based）/ `avgCol` / `lineEnding`（`LF` / `CRLF` / `mixed`）；可选 `withColCountMap: true` 返回"行索引 → 列数"对象映射。流式扫描，**不受 300KB 读取阈值限制**；列数按字符数计、不含行尾换行符；明细超限时不落盘，仅返回概况 + 提示"文件规模超出可处理范围"。内置工具类由 19 个增至 20 个。
- **`batchEdit` 输出精简** — 成功项不再回显原文与新文，全部成功时返回 `{ result: "success", replacedCount }`；存在未匹配项时返回 `{ result: "partial", replacedCount, failed: [{ oldText, newText, reason }] }`，仅回显有问题的原文与新文，避免大段文本回显撑大输出。
- **`AgentDefinition` 新增 `custom` 字段** — 为 `true` 时 SDK 初始化不触碰该 Agent 的内置内容（如默认提示词）。出厂 `DEFAULT_AGENT_DEFINITION` 携带 `custom: false`：`ensureDefaultAgent()` 在 `custom !== true` 时**仅同步出厂提示词**（`name` / `permissions` / `modelId` 等用户改动保留），提示词一致时不写盘、不动 `updatedAt`（比较时忽略随机生成的 message `id`，避免时间戳漂移）。
- **默认 Agent 提示词调整** — 去掉原有法则，改为两条：① 需要用户决策时，一次只问一个问题；② 当前对话基于 Node.js 驱动，可编写 Node.js 脚本执行复杂任务并通过 `exec` 工具运行。

### ✅ Tests

- 新增 `outputGuard.test.ts`（骨架：未超限原样返回 / 超限落盘并返回警告 / 无 `dump` 时只警告 / 目录隔离 / `headPreview` 与 `headTailPreview`）、`InspectFileTool.test.ts`（概况字段、`colCountMap` 映射、CRLF 与 mixed、末行无换行、空文件、300KB 以上文件、明细超限降级、目录与不存在路径）及各工具的超限/范围读取用例；`ConfigManager.bootstrap.test.ts` 覆盖 `custom: true` 跳过、仅同步提示词、一致时不写盘。SDK 全量 **499 passed / 6 skipped**

## [0.11.0] - 2026-09-28

### 💥 Breaking Changes

- **`createCallSkillSubAgentTool` 移除第三参 `provider`** — Skill 子 Agent 不再经 `provider.buildTools(parent.definition, …)` 重新解析工具集，改为**直接沿用父 Agent 的工具集**（`ctx.agent.tools`），仅剔除 `call_skill_sub_agent` 自身：Skill 子 Agent 作为一次性对话分身，沿用调用者的能力而不再走第二遍权限过滤，同时避免 skill 链式自递归。传入 `Provider` 的调用方需删除该实参

### 🚀 New Features

- **Skill 子 Agent 纳入统一委派边界** — `call_skill_sub_agent` 由 `AgentToolLazy` 承载（原为就地实现的 `CallbackTool`），因此与常规 SubAgent 工具共享同一套 `onSubAgentStart` / `onSubAgentEnd` 插件钩子与 `sub-agent-start` / `sub-agent-end` 事件。将护栏装配到 `ctx.subAgent` 的消费方（如上下文护栏）与渲染子 Agent 流式输出的消费方（如 CLI），自此均覆盖该路径

### 🛠 Optimized

- **Skill 子 Agent 的构建收敛到 `buildAgent`** — 子 Agent 的初始消息（`System(SKILL.md 内容)` + `User(task)`）改由 `buildAgent` 决定（依托 core 4.3.0 的 `messages` 可选），原先手写的 abort 联动与返回值处理一并删除，交由工具基类统一实现
- **校验失败改为抛错** — `skill_id` 不存在、或 Skill 未声明 `sub-agent: true` 时抛出错误（原为返回提示文本）；正常路径由 `skill_id` 枚举限定，不触发
- **依赖 `@ai-zen/agents-core` 升至 `^4.3.0`** — 依赖声明保持 `workspace:^`，由 pnpm 在发布时展开为 `^4.3.0`。core 4.3.0 使 `AgentToolLazy.messages` 变为可选

### ✅ Tests

- `skillTools.test.ts` 中 `createCallSkillSubAgentTool` 用例重写为围绕 `AgentToolLazy`：工具契约不变、未知 Skill 抛错、非子 Agent Skill 抛错、委派边界（`onSubAgentStart` 与 `sub-agent-start` 分发、子 Agent 沿用父工具集且剔除自身、初始消息取自 SKILL.md 与 `task`）；SDK 全量 **463 passed / 6 skipped**

## [0.10.0] - 2026-09-28

### 🚀 New Features

- **`load_mcp` 新增 `include_manifest` 开关（可选布尔，默认 `true`）** — 默认行为逐字不变（返回 `{ tools, resources }` 完整清单，tools 含完整 `inputSchema`）；显式传 `false` 时仅建立连接并返回摘要 `{ server, connected, tools: 数量, resources: 数量 }`，不返回任何工具/资源定义。用于「进程重启后连接已失效、但上文中已存在该清单」的场景：只重建连接，不重复向上下文灌入数十 KB 的工具定义，节省 token。完整清单仍留在 `McpConnectionManager` 内，`call_mcp_tool` / `read_mcp_resource` 行为不变；`server` 参数枚举、工具名表与 `DYNAMIC_TOOL_NAMES` 均未变动（前缀缓存结构不变）。失败路径与已连接路径的语义在两种模式下一致；`docs/sdk-design.md` §9 同步更新

### 🛠 Optimized

- **依赖 `@ai-zen/agents-core` 升至 `^4.2.0`** — 依赖声明保持 `workspace:^`，由 pnpm 在发布时展开为 `^4.2.0`。core 4.2.0 新增子 Agent 委派阻塞钩子 `onSubAgentStart` / `onSubAgentEnd`，并将原有事件 `sub-agent` 更名为 `sub-agent-start`（core 侧破坏性变更）；SDK 内部不监听该事件，源码无需适配。监听该事件的消费方需同步更名

### ✅ Tests

- `mcpTools.test.ts` 新增 4 个用例：静默 + 未连接、静默 + 已连接、显式 `true`、静默 + 连接失败；SDK 全量 **461 passed / 6 skipped**

## [0.9.4] - 2026-09-20

### 🔧 Fixed

- **MCP `sse` transport 改为真正的 SSE 连接（`SSEClientTransport`）** — 此前 `http` 与 `sse` 合并处理，统一使用 `StreamableHTTPClientTransport`（Streamable HTTP：POST 发送消息 + 可选 SSE 流），使配置声明 `type: "sse"` 的旧版 HTTP+SSE 服务器（GET 建立 SSE 流、POST 到 endpoint 发送消息）实际运行在不匹配的协议栈上。现按 transport 拆分：`http` → `StreamableHTTPClientTransport`，`sse` → `SSEClientTransport`（均为官方 SDK 内置实现）。`headers` 仍经 `requestInit` 透传，由 SDK 统一应用于 SSE 建流（GET）与消息发送（POST）请求；缺少 `url` 时的报错行为保持不变。`McpServerConfig.transport` 注释与 `docs/sdk-design.md` §10/§11 同步更新

### ✅ Tests

- 针对真实 MCP 服务器（`packages/test-project/mcp-servers/sse-server.mjs`，旧版 HTTP+SSE 协议）验证通过：建立连接、工具发现（`echo` / `add`）、工具调用、断开重连；并确认运行时 transport 实例为 `SSEClientTransport`

## [0.9.3] - 2026-09-01

### 🔧 Fixed

- **`createAgent` 不再污染 Agent 定义模板（`definition.messages` 引用隔离）** — 创建 Agent 时对 `definition.messages` 做模板快照（`[...(definition.messages ?? [])]`）而非直接引用。此前把定义数组直接传给 `AgentContext.messages`（mutable 运行时数组），对话期间 `append()` 会反向把完整对话历史写入 `definition.messages`，导致：
  - 任务迁移 `prune` 分支展开的是被污染的"完整历史"而非模板 → 旧消息既未被物理删除、也未被标记 `omit`，却能看到新注入的断点消息；
  - `omit` 分支的 `preserveCount` 因 `definition.messages` 与 `agent.messages` 指向同一数组而等于全长 → 历史消息无法被标记 `omit`；
  - `/new` 基于被污染的模板拷贝，新对话会继承旧历史。
  - 顺带修复 Agent 定义缺少 `messages` 字段（`undefined`）时创建 Agent 的崩溃问题（`?? []` 兜底）。

### ✅ Tests

- `createAgent.test.ts` 新增：`append` 不污染 `definition.messages`（引用隔离）；Agent 定义缺少 `messages` 字段时正常创建

## [0.9.2] - 2026-08-31

### 🎯 Optimized

- **默认 Agent 提示词重构（`DEFAULT_AGENT_DEFINITION`）** — 精简并统一风格：
  - 人格设定调整为"幽默风趣、严谨可靠"
  - 原有 8 条原则压缩为一条核心规则：遇到任何不明确、不确定、有矛盾或可能影响结果的状况，立即停下并直接询问用户，而不是自行脑补、猜测或硬干
  - 新增"惜字如金"原则：只交代结果与必要说明，执行过程（工具调用、读写、搜索等）用户均已可见，不必再复述，以节省 token
  - 保留护栏：主动调用工具、如实汇报、并只在你被指定的工作范围内行事
  - 注入"当前操作系统"信息，动态使用 `process.platform`，适配不同平台
- **`ViewImageTool` 增加本地 URL 校验** — 新增 `isLocalUrl()`，拒绝 `file://` 协议及指向本机回环地址（`localhost`/`127.0.0.1`/`[::1]`/`0.0.0.0`）的 http(s) URL（API 服务商无法下载访问），在调用早期直接报错；`function.description` 与 `path_or_url` 参数说明同步补充"不支持本地 URL，本地图片请使用文件路径"

## [0.9.1] - 2026-08-28

### 🔧 Fixed

- **SDK-produced messages now always carry an `id`, aligned with core 4.1.0's required `Message.id`** — `TaskMigrationService.createPostMessages()` returns a `Message.User`, and the default agent / sub-agent definitions (`DEFAULT_AGENT_DEFINITION` / `DEFAULT_SUBAGENT_DEFINITION`) build their messages via `Message.System` / `Message.User`. This removes the last places where a bare object literal `{ role, content }` was assigned to `AgentNS.Message`, which would now fail to compile under core 4.1.0 (where `Message.id` is non-optional). Consumers no longer need to patch a missing `id` on SDK-generated messages (e.g. a desktop-side `ensureId` bridge)
- **No breaking change to public API** — only internal message construction was switched to the `Message` factory methods; exported types and method signatures are unchanged

### ✅ Tests

- SDK suite re-checked green against core 4.1.0 (`Message.id` required)

## [0.9.0] - 2026-08-28

### 🎯 Optimized

- **`TaskMigrationService.migrate` gains a `strategy` switch** — controls how history is handled after migration:
  - **`omit` (default)**: history messages are marked `omit: true` (kept in `agent.messages` for audit/replay, but `Agent.formatHistory()` filters them out), and a "conversation breakpoint" message (handoff doc + handover instructions, role=user) is appended as the new context start. The sequence sent to the model becomes `[definition.messages, breakpoint message]`. Reuses Core's existing `omit` mechanism — no Core changes needed.
  - **`prune`**: physically drops history, keeping only `definition.messages` + breakpoint message (the previous replace behavior).
  - The default can be set via `strategy` when constructing `TaskMigrationService`, and overridden per `migrate()` call (`MigrationStrategy` type is exported).
  - `agent.messages` is rebuilt via a **shallow copy** to avoid mutating objects referenced by `definition.messages` (prevents polluting the template).
  - `historyText` (fed to the model to generate the handoff doc) now **filters omitted history**, so repeated migrations don't re-feed old omitted history to the model.
  - `AutoMigratePlugin` still only decides *when* to trigger — no changes needed.

### ✅ Tests

- `TaskMigrationService` / `AutoMigratePlugin` assertions updated to the omit semantics (history marked omit + trailing breakpoint + system prompt preserved).
- New case: `historyText` filters already-omitted history.
- New case: `strategy=prune` (constructor default + `migrate` param override) physically drops history.

## [0.8.0] - 2026-08-24

### ⚠️ Breaking

- **`TaskMigrationService` is now an instantiated, self-contained migration service** — it holds no model call of its own: `migrate()` reuses the passed `agent`'s own `client` / `model` / `modelConfig` to generate the handoff document, so it needs no `Provider` and no standalone "migration Agent" object (and no duplicated `config + modelId` model wiring). `migrate()` is an instance method that serializes history, calls the model to generate the handoff document, and replaces `agent.messages`.
  - `TaskMigrationServiceOptions` = `{ client?, model?, modelConfig?, onBeforeMigrate?, onMigrated?, logger? }` — pass `client`/`model`/`modelConfig` to override the model call used for the handoff; when omitted, `migrate()` falls back to the passed `agent`'s own config
  - `migrate({ agent, promptTokens?, maxTokens? })` — `agent` is the only runtime param (its `client`/`model`/`modelConfig` back the model call); the migration hooks are flat on the service instance (no `hooks` wrapper)
- **`AutoMigratePlugin` narrowed to a trigger-only role** — constructor takes `{ service, maxTokens }`; it only detects token overflow in `onAfterSend` and delegates to `service.migrate({ agent, promptTokens, maxTokens })`. No hooks on the plugin.
- **Removed** — `TaskMigrationService.createAgentDefinition` (the service calls the model directly, so a standalone migration Agent definition is unnecessary) and `BuildMigrationAgentOptions`; `MigrationContext` no longer carries `migrationAgent` (records `model` instead).
- **New exports** — `MigrationContext`, `TaskMigrationServiceOptions`.

### 🛠 Optimized

- `serializeMessages` moved from `AutoMigratePlugin` private to `TaskMigrationService` public static.
- The pure-tool statics (`createPrompt` / `createPostMessages` / `serializeMessages`) remain `static`; the instance `migrate()` reuses the passed `agent`'s model client. The "should migrate" check (`promptTokens > maxTokens`) lives in `AutoMigratePlugin` (the trigger side), not on the service.
- Migration failure still leaves `agent.messages` unchanged (atomic); hook errors are caught and logged, never interrupting the migration flow.

### ✅ Tests

- `TaskMigrationService`: statics (`createPrompt` / `createPostMessages` / `serializeMessages`) + `migrate` (model call, hook contexts, failure atomicity) — all green.
- `AutoMigratePlugin`: trigger-only behavior (overflow → `service.migrate`; below threshold / no usage → no model call).

## [0.7.1] - 2026-08-25

### 🚀 New Features

- **`FindTextTool` (findText) gains three-layer output protection** — prevents search results from blowing up the context window:
  - **`maxMatches`** (default 200) — caps the total number of matches; once reached, scanning stops and the result is marked `truncated`
  - **`maxFileSize`** (default 300KB, aligned with `ReadFileTool`) — files larger than this are **skipped** rather than rejected, so an oversized file doesn't block the whole search
  - **`maxLineLength`** (default 200) — each matched line's `content` and the regex `match` substring are truncated (with a trailing `…`)
  - All three are optional parameters that can be overridden by the caller; when truncated the result returns `{ truncated: true, totalMatches, results }`, while non-truncated results keep the original JSON array shape (backward compatible)

## [0.7.0] - 2026-08-14

### ⚠️ Breaking

- **`@ai-zen/agents-core` upgraded to 4.0.0** — the SDK now runs on the **official OpenAI SDK**: `createModel(provider, modelId)` returns `{ client, model, modelConfig }` (an `openai` client + model name + params spread into the request) instead of a `ChatCompletionModel`; `SdkAgent` / `createAgent` construct with `{ client, model, modelConfig }`; `GenerateImageTool` calls `client.images.generate`
- **Plugin mechanism promoted to core** — `AgentPlugin` / `SendContext` / `HookResult` now live in `@ai-zen/agents-core` (re-exported by the SDK for compatibility). `SdkAgent` no longer implements its own `use` / `init` / hook iteration, and the `onUnknownTool` property hack is gone — it inherits everything from Core `Agent`
- **`SdkAgent.defaultUnknownTool` override removed** — the MCP-aware unknown-tool hint moved out of the class into a standalone plugin (see `UnknownToolHintPlugin` below); Core `Agent` now keeps only a simple built-in hint
- **`SdkAgent.permissions` field removed** — the Agent no longer carries its own `permissions` copy; read `agent.definition.permissions` instead (single source of truth). `AutoRefreshToolsPlugin` and `call_skill_sub_agent` were updated accordingly
- **`ContextGuardPlugin` default `ratio` changed from 1.2 to 1.5** — the guard now trips at 50% over `maxTokens` (user setting) instead of 20%

### 🚀 New Features

- **`UnknownToolHintPlugin`** — new standalone plugin providing the MCP-aware unknown-tool hint (replaces the removed `SdkAgent.defaultUnknownTool` override). Register explicitly: `agent.use(new UnknownToolHintPlugin({ provider }))`; without it, unknown tools fall back to Core's simple built-in hint
- **`Model.vision` field + self-declared tool availability** — models can be marked `vision: true`. `SdkCallbackTool` gains `isAvailable(config, definition)`: tools **self-declare** availability by directly inspecting the full app config and agent definition (e.g. `GenerateImageTool` requires `defaultImageModel`, `ViewImageTool` requires a vision model). All **19 built-in tools** live in `BUILTIN_TOOL_CLASSES` (discovery does no filtering); `Provider.filter`/`buildTools` take the `AgentDefinition` and call `isAvailable` at build time (when the model is already known) to filter the final tool set — no hard-coded tool names, and no runtime duplication (vision checks live only in `ViewImageTool.isAvailable`)
- **`ViewImageTool`** — let the Agent view/analyze an image (vision models only): a network URL returns an `image_url` content block; a local path is auto-uploaded via the Files API (`client.files.create`, `purpose: "user_data"`) and returned as a `file` content block (no base64). Always registered as a built-in candidate; filtered out by `buildTools` for non-vision models (a runtime check remains as a defensive guard)
- **`GenerateImageTool` returns a plain string** — it always returns JSON text with the image URLs plus `viewImage` / `downloadFile` hints; how the generated image is consumed (view / download / forward) is left to the model and the caller, instead of forcing image content blocks on vision models
- **`SdkCallbackTool.exec` passes content-section arrays through** — aligned with Core's `Tool.exec` returning `AgentNS.MessageContent`; other values are still JSON-serialized

### 🎯 Optimized

- `createAgent` / `subAgentTools` / `skillTools` adapted to the new Agent constructor (`{ client, model, modelConfig }`)
- The plugins (`AutoMigratePlugin` / `AutoRefreshToolsPlugin` / `ContextGuardPlugin` / `UnknownToolHintPlugin`) now type their hooks from core's `AgentPlugin` / `HookResult`

### ✅ Tests

- Adapted `createModel` / `SdkAgent` / `Provider` / `createAgent` / `AutoRefreshToolsPlugin` / `ContextGuardPlugin` / `skillTools` / e2e tests to the core 4.0.0 API — all green (incl. real DeepSeek API e2e)

## [0.6.0] - 2026-08-14

### ⚠️ Breaking

- **`SdkCallbackTool` constructor no longer takes `function` — construction is now `super({ env })` only** — the tool definition (`function`) is declared by each tool as a **class-body field**, colocated with its `call` implementation. The constructor now takes an options container (`SdkCallbackToolOptions`, currently containing `env` as its core field and open to future extension). Any custom tool previously writing `super({ function, env })` must move its `function` definition into a class-body field and call `super({ env })`. `SdkCallbackToolOptions` is exported for external consumers
- **`SdkCallbackTool.call` now forwards the full `ToolCallContext`** — `call(input)` becomes `call(input, ctx?)`. Concrete tools may read the second argument (e.g. `ctx?.signal`) for abort support. This is additive (optional argument), so existing single-argument `call`s keep compiling
- **`@ai-zen/agents-core` upgraded to 3.4.0** — the `Tool` base class no longer requires passing `function`/`type` via its constructor; `CallbackTool` / `AgentToolLazy.buildAgent` no longer use `this`-injection and now receive `(parsed_args, ctx)`. SDK callbacks that previously read `this.agent` now read `ctx.agent` instead (`call_skill_sub_agent` in skillTools, `buildAgent` in subAgentTools)

### 🛠 Optimized

- **All 18 built-in tools now declare their `function` definition as a class-body field** — the definition lives next to the `call` implementation (single source of truth), instead of being passed separately through the constructor
- Aligned SDK tool context access with core's explicit `(parsed_args, ctx)` convention
- **Per-tool abort signal support** — high-value tools now honor interruption via `ctx?.signal`:
  - **`sleep`** — listening for abort on the wait timer, returning early so a long wait is interrupted instead of blocking
  - **`exec`** — killing the child process on abort (marking `terminated: "aborted"` distinct from `"timeout"`), with a fallback to avoid hanging if the signal kills the shell
  - **`downloadFile`** — passing the signal to `fetch`, and cleaning up any partially-written file on abort
  - **`generateImage`** — passing the signal to the image-model request (the underlying `fetch` already supports it), returning an aborted result on interruption
  - **`glob` / `findText`** — checking `ctx.signal` during directory-tree traversal (and after each file read), stopping the scan early and returning the partial results with an `aborted` flag when interrupted
- **MCP tool signal forwarding** — `call_mcp_tool` and `read_mcp_resource` now forward `ctx.signal` into the underlying MCP SDK `callTool` / `readResource` request options, so a remote call can be interrupted
- **Sub-agent abort linkage** — sub-agent tools (`AgentTool`, `AgentToolLazy`; used by `createSubAgentTool` and `call_skill_sub_agent`) now listen for the outer `ctx.signal` and call `agent.abort()` on the child agent, so a long-running sub-agent is stopped when the parent call is aborted

### ✅ Tests

- Updated `SdkCallbackTool` / `capabilities` tests for the new `function` assignment and `super({ env })` construction; added a test asserting `SdkCallbackTool.call` receives the forwarded `ToolCallContext`
- **Added abort tests** for `sleep` (early return + immediate abort), `exec` (child killed + `terminated: "aborted"`), `downloadFile` (abort cleanup of the partial file), `generateImage` (aborted result), `glob`/`findText` (early scan stop), plus MCP `callTool`/`readResource` signal forwarding and sub-agent abort linkage. SDK suite now at **435 passed**, **3 skipped**; core at **198 passed**, **17 skipped**

## [0.5.7] - 2026-08-13

### 🛠 Optimized

- **`@ai-zen/agents-core` dependency upgraded to 3.3.1** — dual-set inner-loop task semantics + unified Assistant placeholder at inner-loop start; SDK 426 tests (incl. real DeepSeek e2e) all pass, fully compatible

## [0.5.6] - 2026-08-14

### 🚀 New Features

- **`AgentPlugin` gains the `onToolCall` interception hook** — corresponding to Core 3.3.0's `onToolCall` hook: fired before every tool call execution, receiving the **same `ToolCallContext` instance** that is passed to `Tool.exec(ctx)`. Returning a string rejects the tool (not executed; the reason is returned to the LLM as the tool result and the conversation continues to the next round); returning `undefined` allows execution. Multiple plugins run in registration order and any one returning a string rejects (short-circuit). `SdkAgent.send()` wraps this hook into plugin iteration before delegating to `super.send()`, isomorphic with the existing inner-loop hooks, and clears it afterwards

### 🛠 Optimized

- **`@ai-zen/agents-core` dependency upgraded to 3.3.0** — `FunctionCallContext` was unified into `ToolCallContext` (a single class spanning interception decision → execution). SDK internal references (`SdkCallbackTool.exec`, skill / sub-agent tool callbacks) are synced to `ToolCallContext`, while the deprecated `FunctionCallContext` alias is retained for backward compatibility

## [0.5.5] - 2026-08-13

### 📄 Docs

- **README translated to English** — the main `README.md` is now English-first, with the original Chinese content preserved as `README.zh.md`
- **Package metadata standardized** — `description` unified to English across packages

## [0.5.4] - 2026-08-05

### 🚀 New Features

- **`ExecAsyncTool` (exec_async) now uniformly uses shell parsing** — removed the manual word-splitting logic on Unix; all platforms now execute via `spawn(command, [], { shell: true })`. The tool description explicitly tells the agent it does not capture output itself; to retain/inspect output, use shell redirection to a file (`>` / `>>`) in the command, and shell syntax such as pipes (`|`) is supported

### 🎯 Optimized

- **`ExecTool` (exec) `timeout` is now required** — schema `required` expanded from `["command"]` to `["command", "timeout"]`; the `call()` type signature is `timeout: number` (required), with double validation at runtime (throws on missing / non-positive / non-finite). With `timeout` required, commands are always protected by a timeout and cannot run indefinitely
- **Timeout reason clearly reported to the agent** — when `exec` is killed by a timeout (`error.killed` is `true`), the returned structure adds a `terminated: "timeout"` field. This compensates for Node not automatically writing a timeout notice to stderr, letting the agent clearly determine that the command was terminated by a timeout and respond accordingly

## [0.5.3] - 2026-08-05

### 🚀 New Features

- **Default mcp.json with socket-pty released on init** — `ConfigManager.bootstrap()` adds `ensureDefaultMcpConfig()`, which on first run writes a default MCP config (incl. the socket-pty terminal server, `command: npx -y @ai-zen/socket-pty mcp`) to `~/.ai-zen/mcp.json`; idempotent, does not overwrite if the file exists. Added `readMcpConfig()` / `writeMcpConfig()` methods, and exported `DEFAULT_MCP_CONFIG` constant
- **`load_mcp` passes through server description** — `McpServerConfig` gains an optional `description?` field, no longer discarded by `discoverMcpServers`; the `server` parameter enum in `load_mcp` is built as `- {id}: {description}` so the LLM can see each server's description (isomorphic with `load_skill`)
- **New `ContextGuardPlugin` context safety guard** — before each inner loop's request (`onInnerLoopStart`, outside the try block in Core), checks the previous round's `usage.prompt_tokens`; when it exceeds `maxTokens × ratio` (default 1.2, i.e. 20% over threshold), throws `ContextOverflowError` to interrupt the conversation, preventing context runaway from reading oversized files. Responsibilities are separated from `AutoMigratePlugin` and the ranges complement each other; no Core changes needed

### 🆕 New Exports

- `DEFAULT_MCP_CONFIG` (constants), `ContextGuardPlugin`, `ContextOverflowError`

## [0.5.2] - 2026-08-03

### 🚀 New Features

- **`AgentPlugin` gains `onInnerLoopsStart` / `onInnerLoopsEnd` hooks** — corresponding to Core 3.2.0's whole-group inner-loop start/end hooks (each fires once per `send`). `SdkAgent.send()` wraps these two hooks into plugin iteration before/after delegating to `super.send()`, isomorphic with the per-round `onInnerLoopStart` / `onInnerLoopEnd`. Plugins can access the current agent, the sent content, and the message snapshot via `ctx`

## [0.5.1] - 2026-08-03

### 🛠 Optimized

- **`@ai-zen/agents-core` dependency upgraded and switched to a range version** — from `workspace:*` (replaced with the exact version `3.0.1` at publish time) to `workspace:^` (published as `^3.1.0`). Since core 3.1.0, `Message` auto-generates an `id` in the constructor, so messages passed through the SDK carry a stable id; the range version means subsequent core minor/patch upgrades no longer require a separate SDK release

## [0.5.0] - 2026-07-29

### 💥 Breaking Changes

- **All built-in tools are now classes** — the 17 built-in tools changed from singleton `CallbackTool` instances to classes (`CwdTool`, `ReadFileTool`, `WriteFileTool`, `ExecTool`, etc., PascalCase naming) extending the new abstract base `SdkCallbackTool`. The `BUILTIN_TOOLS` singleton registry was replaced with the `BUILTIN_TOOL_CLASSES` class registry (`Array<new (env: ToolEnv) => SdkCallbackTool>`)
- **`generateImage` classed as `GenerateImageTool`** — removed the factory function `createGenerateImageTool(config)`; constructor signature unified with other built-in tools as `(env: ToolEnv)`. Still conditionally registered via `config.defaultImageModel`, not part of the static `BUILTIN_TOOL_CLASSES` registry
- **`discoverBuiltinTools` signature changed** — from `discoverBuiltinTools(config: AppConfig)` to `discoverBuiltinTools(env: ToolEnv)`, instantiating tool classes with `env`
- **`Provider` gains `cwd` and `env`** — `cwd` defaults to `process.cwd()` and is the base for relative path resolution; `env: ToolEnv` (`{ cwd, config }`) is established at construction and used by `refresh()` to instantiate built-in tools. **Tools no longer depend on the global `process.cwd()`**; each Provider can be bound to a different working directory
- **Conversation/draft product layer removed** — `Conversation` / `Draft` types, `ConversationRepository`, `DraftRepository`, `AutoDraftPlugin`, and their tests were all removed. Conversation and draft persistence are delegated to each consumer (CLI/Desktop), which may reuse `EntityRepository`
- **`index.ts` export changes** — removed `Conversation`/`Draft`/`ConversationRepository`/`DraftRepository`/`AutoDraftPlugin`/`BUILTIN_TOOLS`/`execAsyncTool`/`sleepTool`/`createGenerateImageTool`; added `ToolEnv`, `SdkCallbackTool`, `BUILTIN_TOOL_CLASSES`, `GenerateImageTool`, and the 17 tool classes

### 🚀 New Features

- **`ToolEnv` interface** — tool environment `{ cwd, config }`, injected at tool construction, serving as the base for relative path resolution and config reads
- **`SdkCallbackTool` abstract base** — `env` constructor injection + subclass `call()` + `exec()` bridge + `resolve()` relative path resolution (public, easy to call directly in tests)

### 🎯 Optimized

- **Multi-session parallelism** — `cwd` moved down to the Provider (`ToolEnv.cwd`); multiple Providers can serve sessions in different working directories in parallel without interference
- **Per-Provider tool instances** — each Provider instantiates its own set of tools via `discoverBuiltinTools(env)`, eliminating global singleton state

## [0.4.0] - 2026-07-29

### 💥 Breaking Changes

- **`load_mcp` return value changed from plain text to structured JSON** — now returns `{ tools, resources }`, where tools include the complete `inputSchema` (parameter JSON Schema) and resources include `uri`, `name`, `description`, `mimeType`. The LLM gets precise parameter structure instead of guessing from description text
- **`load_mcp` no longer returns a `prompts` field** — prompts are for the UI layer and are not exposed to Agents
- **`createLogger()` replaced with the global singletons `getLogger()` / `setLogger()`** — logging no longer supports multiple instances; all SDK-internal modules uniformly obtain the same instance via `getLogger()`
- **`index.ts` export changes** — `createLogger` → `getLogger` / `setLogger`

### 🎯 Optimized

- **`load_mcp` prints the full manifest to the log after a successful connection** — complete JSON with tools, resources, and prompts, for easier debugging
- **SDK-internal logging unified** — `console.warn`/`console.error` in `mcps.ts`, `skills.ts`, `usertools.ts`, and `McpConnectionManager.ts` all changed to `getLogger().warn`/`getLogger().error`

## [0.3.4] - 2026-07-27

### 🎯 Optimized

- **`AutoMigratePlugin` hook renamed** — `onHandoff` → `onMigrated`, with clearer semantics: use `onBeforeMigrate` before migration (at which point `agent.messages` is still the full old history) and `onMigrated` after migration completes (the handoff document has been injected)
- **`conversation-runner.ts` save logic fixed** — saving the old conversation moved from `onMigrated` (formerly `onHandoff`) to `onBeforeMigrate`, ensuring the complete old conversation history is saved rather than the post-migration new messages

## [0.3.3] - 2026-07-27

### 🎯 Optimized

- **Default SubAgent System Prompt gains two mandatory requirements**:
  1. Refuse to execute when information is unclear/ambiguous/missing; ask for clarification
  2. Point out contradictions when conflicting information is present; ask for clarification
- **Default Agent System Prompt adds a principle**: "Ask when contradictory — if the user's instructions contain contradictions, point them out and request clarification instead of deciding on your own"
- **Default SubAgent `function.description` and `task` parameter description** updated in sync, emphasizing that unclear information will lead to refusal

## [0.3.2] - 2026-07-26

### 💥 Breaking Changes

- **All `EntityRepository` methods are now async** — `list()`, `read()`, `write()`, `delete()` now return `Promise`, requiring `await`
- **All `DraftRepository` methods are now async** — `read()`, `write()`, `delete()` require `await`
- **All `ConfigManager` methods are now async** — `read()`, `write()`, `ensureDirs()`, `ensureDefaultAgent()`, `ensureDefaultSubAgent()`, `ensureDefaultConfig()`, `bootstrap()` all require `await`
- **`createAgent()` is `async` again** — as the underlying repositories became async, `createAgent(provider, agentId)` requires `await`
- **`AutoDraftPlugin.checkDraftForRestore()` is now async** — requires `await`

### 🎯 Optimized

- **Synchronous file I/O fully eliminated** — all `existsSync`, `readFileSync`, `writeFileSync`, `readdirSync`, `mkdirSync`, `unlinkSync`, `renameSync` in production code replaced with the `fs.promises` async API, avoiding event-loop blocking
- **`skillTools.ts`** — `readdirSync` in the tool callback replaced with `fs.promises.readdir`

### ✅ Tests

- 7 test files updated in sync to `async`/`await`; test helpers also use `fs.promises`

## [0.3.1] - 2026-07-26

### 💥 Breaking Changes

- **`Provider` moved to `runtime`, merging `Capabilities`** — deleted `capabilities/Capabilities.ts` and the original `runtime/Provider.ts`; Provider now directly exposes `filter()`, `buildTools()`, `instantiate()`, `refresh()`
- **`getMcpManager()` removed** — `mcpManager` changed from a lazy getter to being constructed directly as `new McpConnectionManager()` (when mcpPaths exist), a `readonly` property
- **Field renames** — `builtinInstances` → `builtinTools`, `userInstances` → `userTools`, `subagentDefs` → `subagents`
- **`createModel` signature changed** — from `createModel(config, modelId)` to `createModel(provider, modelId)`; callers no longer need the `.config` destructure
- **`SdkAgent` drops the `caps` field** — only `provider` remains

### 🚀 New Features

- **User tool ESM support** — removed the `node:vm` sandbox, uniformly using `import()` to load `.js` / `.mjs` files; each `refresh()` appends a timestamp querystring to prevent caching
- **`CallbackTool` replaces `createToolFromObject`** — the `{ function, exec }` format maps directly to `CallbackTool`

### 🎯 Optimized

- **Default Agent system prompt updated** — condensed to five principles: think hard, be truthful, follow instructions, safety first, win battles
- **Default SubAgent `function.description` optimized** — emphasizes that the main Agent must provide complete task context

### 🗑 Removed

- Deleted `capabilities/Provider.ts` (moved back to `runtime/Provider.ts`)
- Deleted the `createToolFromObject` utility function
- Deleted `TODO.md` and `TODO2.md`
- Test fixtures migrated from `.js` to `.mjs`

## [0.2.6] - 2026-07-20

### 🔧 Fixed

- **Default SubAgent function name and description insufficient for the LLM to recognize it as a sub-agent** — `function.name` changed from `general_assistant` to `sub_agent_default`; `function.description` rewritten with detailed wording, clarifying the sub-agent identity and capability boundary. The parameter name changed from `query` to `task` to align with the design spec; the system prompt clarifies the role
- **`DEFAULT_SUBAGENT_ID` changed from `general-assistant` to `sub-agent-default`** — filename matches the function name for easy recognition

## [0.2.5] - 2026-07-20

### 🔧 Fixed

- **`DEFAULT_SUBAGENT_DEFINITION` missing `permissions` config** — the default SubAgent `general-assistant` had no permissions, so every dimension effectively became `deny: ['*']`, making it completely unable to use any tool/skill/MCP/SubAgent. Now completed per the design spec, with only the `subagents` dimension set to `deny: ['*']` to prevent recursive calls

## [0.2.4] - 2026-07-20

### 🔧 Fixed

- **`load_skill` no longer injects a System message** — instead returns the full SKILL.md content plus the Skill directory path and file list directly in the tool return value, fully transparent to the LLM
- **`SkillInfo` gains a `dirPath` field** — records the absolute path of the directory containing SKILL.md
- **`McpConnectionManager.doConnect` calls methods on demand per server capabilities** — only invokes the corresponding method for declared capabilities, avoiding Method not found for undeclared ones
- **`McpConnectionManager.doConnect` wraps each list call in try/catch** — a failure to fetch one capability does not affect the others

## [0.2.3] - 2026-07-20

### 🔧 Fixed

- **`AgentRepository` — uses `EntityRepository` instead of direct file operations** — adopting the base repository for unified logic

## [0.2.2] - 2026-07-20

### 🔧 Fixed

- **`SdkAgent.send()` — `ctx.messages` no longer references `this.messages` directly** — changed to a shallow-copied snapshot, ensuring the message array is owned solely by the agent
- **`AutoMigratePlugin` — no longer creates a new Agent instance** — directly replaces the `agent.messages` array, preserving all references, plugin bindings, and event listeners
- **`AutoMigratePlugin` — adds a log notice before migration** — uses `log.warn` to output the migration start notice

### 🎯 Optimized

- **`AutoMigratePlugin` — `onHandoff` signature simplified** — from `(doc, oldAgent, newAgent)` to `(doc, agent)`, since the agent is the same object
- **`TaskMigrationService.createPrompt()` — streamlined prompt** — explicitly requires only the handoff document as output, no explanations

### ✅ Tests

- Added exact assertions for the message array **length before/after migration** (3 before → 2 after)
- Added assertions that the message array **length and content stay unchanged** on migration failure
