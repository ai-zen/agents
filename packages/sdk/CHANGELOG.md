# Changelog

## [1.0.0-alpha.19] - 2026-10-27

### 🐛 修复

- **日志不再绕过 `getLogger()`：`[load_mcp]` 等日志会直接打到宿主终端** —— 4 个模块此前在**模块顶层**执行 `const log = getLogger()`，而 `getLogger()` 当时返回的是 `{ info: console.log, ... }`。模块求值那一刻，`console.log` 的**函数引用**就被冻进了常量；此后宿主调用 `setLogger()` 换掉的是内部 `currentLogger` 变量，**改不动已经抓走的引用**。后果：宿主怎么接管日志都没用 —— CLI 的 Ink TUI 里加载 MCP 时，`load_mcp` 会把整份 tools / resources 清单直接砸在渲染区外面，把界面撕成乱码。

  现在 4 处全部改为**运行时取 logger**（`getLogger().info(...)` 等），`setLogger()` 立即生效：

  - `scope/plugins/mcp/mcpTools.ts` —— `[load_mcp]` 两条 info（摘要 + 完整清单）；
  - `scope/plugins/skills/discover.ts` —— `[skills]` 一条 warn；
  - `agent-plugins/AutoMigratePlugin.ts` —— `[autoMigrate]` 一条 error；
  - `scope/plugins/skills/skillTools.ts` —— 顶层快照**从未被调用**（死代码），连同 `getLogger` import 一并删除。

  至此 SDK 内 10 处日志调用全部经由 `getLogger()` 这一个出口，宿主 `setLogger()` 换什么就走什么，不再存在 console 旁路。

### ✅ 测试

- 全量 **57 文件 / 602 例通过**（6 skipped）。
- 端到端对照验证：同一段「先求值模块 → 再 `setLogger` → 调用 `load_mcp`」的代码，旧版日志直写 stdout、日志文件为空；新版 stdout 干净、日志完整落盘。

## [1.0.0-alpha.18] - 2026-10-22

### 🔧 行为变更（不兼容）

- **模型的唯一真相源改为 `AgentDefinition.modelId`，`AppConfig.defaultModel` 删除** —— 此前模型有两处来源：Agent 定义里的 `modelId` 优先，缺失时回退 `config.defaultModel`。而 CLI 等客户端还会在**会话存档**里另记一份模型名用于展示。三份值一旦分叉，就会出现「界面写着 DeepSeek、请求却发给 GLM」的静默错位：用户看到 401 却怎么切都切不回来（切换命令按显示层判断「已经是当前模型」直接返回，实际模型从未改变）。现在：
  - `AppConfig` 删除 `defaultModel` 字段，出厂配置同步删除；`migrateConfig` 会把磁盘上的旧字段**清掉**（一次性，写入后不再出现）；
  - `createAgent` 只读 `definition.modelId`，**缺失直接报错**，不再有任何隐式回退；
  - `ViewImageTool.isAvailable` / `resolveModelAndEndpoint` 同步去掉 `defaultModel` 兜底，反查不到即视为「无端点」，让调用方走降级路径而不是猜一个模型。
- **`DEFAULT_AGENT_DEFINITION.modelId = "deepseek-flash"`（新增导出 `DEFAULT_MODEL_ID`）** —— 出厂默认 Agent 自带模型 ID，装完即用，不再依赖配置层的默认值。
- **升级兼容：`ensureDefaultAgent()` 会为缺 `modelId` 的历史 Agent 补上** —— 优先沿用老的 `config.defaultModel`（若该模型仍在清单里），否则回落到出厂 `deepseek-flash`，因此升级不会改变用户正在用的模型。

### ✅ 测试

- 全量 **57 文件 / 602 例通过**（6 skipped）。
- 新增/改写重点：`createAgent` 缺 `modelId` 必须抛错、`ensureDefaultAgent` 补齐并落盘、`migrateConfig` 清除废弃字段且不就地改原对象、`resolveModelAndEndpoint` 未命中返回 `null` 端点、MCP / 图片工具按 `ctx.agent.model` 反查端点（不再靠默认模型兜底）。

## [1.0.0-alpha.16] - 2026-10-22

### 🔧 行为变更（不兼容，向上修复）

- **升级 `@ai-zen/agents-core` 至 `4.5.2`：请求体里的固定字段不再被 `modelParams` 覆盖** —— core 之前把模型参数 spread 在请求体**最后**（`{ model, messages, tools, stream, stream_options, ...modelConfig }`），而 `modelConfig` 来自用户可编辑的 `Model.defaultParams` / `AgentDefinition.modelParams`。一旦其中出现同名键就会静默生效：最惨的是 `stream: false`，它会把流式关掉而调用方仍在按异步流解析，整轮直接失败。现在顺序反过来，固定字段永远胜出，非固定键（`temperature` / `reasoning_effort` / 厂商特有 `thinking` 等）照常透传。

  对本 SDK 的实际影响：`AgentDefinition.modelParams` 里写 `model` / `messages` / `tools` / `stream` / `stream_options` 将不再有任何效果。正常配置（温度、思考参数）不受影响。

### ✅ 测试

- 依赖的 core 侧新增 3 例（非固定键透传、固定键被忽略、无 `modelConfig` 时请求体只含框架字段）。SDK 自身 **57 文件 / 600 例通过**（6 skipped）。

## [1.0.0-alpha.15] - 2026-10-22

### 🔧 行为变更（不兼容）

- **SDK 不再「消费」思考档位，只保留表本身** —— alpha.14 把「档位 → 请求参数」的整套解析塞进了 SDK 运行时：`applyReasoningEffort` / `modelLevels` / `resolveReasoningEffort` / `resolveModelParams`，还要 `Scope.reasoningPresets` 注入、Agent 上存档位名、运行时查表拼参数。但 `low` / `high` / `max` / `off` 是**产品语义，不是协议事实**，SDK 唯一客观知道的是「请求参数长什么样」——那本来就由 `defaultParams` 承载。现在：
  - **删除 `shared/reasoning.ts` 的全部 API**（`applyReasoningEffort` / `modelLevels` / `presetOf` / `readReasoningEffort` / `resolveReasoningEffort` / `resolveModelParams`）以及 `Scope.reasoningPresets`；
  - **保留**思考预设的**定义与出厂内容**（`ReasoningPresets` / `ReasoningPreset` / `ReasoningPatch` 类型、`config/reasoning-presets.ts`、`ConfigManager.readReasoningPresets()` / `ensureReasoningPresets()`）—— 它是 CLI / 桌面端等客户端**共享的资产**（「智谱 5.3 只认 low/high/max」这种知识不该被每个客户端各写一遍），但那只是**数据**，SDK 不拿它生成请求参数。
- **`AgentDefinition.reasoningEffort` → `AgentDefinition.modelParams?: ModelParams`** —— Agent 级覆盖从「档位名」变成「具体参数」。客户端读到表、拿档位补丁，在**写入配置时**就把它展开存进 `modelParams` 里。于是**配置即事实**：运行期不查表、不推导。
- **`createModel(scope, modelId, overrides?: ModelParams)`** —— 第三参从 `Pick<AgentDefinition, "reasoningEffort">` 变成裸的参数对象，内部只有一行：
  ```ts
  modelConfig = { ...model.defaultParams, ...overrides };
  ```
  浅合并（嵌套对象整体替换），没有覆盖时原样返回 `defaultParams`。SDK 从此不解释任何键名，也不知道 `thinking` / `reasoning_effort` 是什么。SubAgent 指定独立 `modelId` 时同样应用自己的 `modelParams`。
- **`Model.reasoningPreset` 保留**，语义改为「引用策略表的键」，供客户端判断该模型能选哪几档；SDK 只保证它能随模型配置一起读写与出厂同步，不消费。

### 🐛 修复

- **迁移 `Model.reasoning` 旧字段（alpha.13 遗留）** —— 未标 `custom` 的模型会被出厂定义整块覆盖，但**标了 `custom: true` 的会原地保留**，于是留下一个无人认识的 `reasoning`，同时因为缺 `reasoningPreset` 而被客户端判定为「不可调档」。`ConfigManager.read()` 现在会删掉该旧字段，并按同 id 的出厂模型补回 `reasoningPreset`；id 不在出厂清单的（真·自建模型）只删不补。只处理「旧字段存在」这一种情况，用户后续主动删掉 `reasoningPreset` 不会被反复补回来。

### ✅ 测试

- `src/runtime/createModel.test.ts` 新增 6 例锁住合并语义：无覆盖原样返回、空覆盖等同无覆盖、同名键覆盖而其它键保留、模型无 `defaultParams` 时覆盖即全部、**浅合并不做深合并**（换档位不残留旧子键）、两个 Agent 各配一套互不影响。
- `src/config/migrate.test.ts` 新增 6 例（19 例合计）。
- 删除 `src/shared/reasoning.test.ts`（26 例，运行时解析已移除）；`src/config/reasoning-presets.test.ts`（11 例）保留 —— 表还在 SDK。
- 全量 **57 文件 / 600 例通过**（6 skipped）。

## [1.0.0-alpha.14] - 2026-10-22

### 🔧 行为变更（不兼容）

- **思考能力声明从「模型字段」改为「策略表」** —— alpha.13 那版用 `Model.reasoning: { efforts, disable? }` 表达厂商差异，结果三处结构性缺陷：`disable` 一词双义（既指关闭方式又指能力）、`off` 靠拼接而非声明（`disable ? ["off", ...efforts] : efforts`）、用全局 `ReasoningEffort` 枚举假装各家档位等价。现在改为**档位 → 请求参数补丁**的声明式表：
  - 新增 `<basePath>/reasoning-presets.json`（与 `config.json` 同级），出厂内容见 `config/reasoning-presets.ts`；
  - `Model.reasoning?` → **`Model.reasoningPreset?: string`**（引用策略名；缺省 = 不可调档）；
  - `AgentDefinition.reasoningEffort` 类型 `ReasoningEffort` → **`string`**（档位名由策略表定义，不再用假枚举假装统一）；
  - 删除 `ReasoningEffort` / `ReasoningCapability` 类型与 `capabilityOf` / `modelEfforts` / `modelAllowedEfforts` / `isReasoningEffort` 函数；
  - 函数签名统一以 `(model, presets, …)` 开头：`readReasoningEffort(model, presets, params?)`、`applyReasoningEffort(model, presets, level, params?)`、`resolveReasoningEffort(model, presets, definition?)`、`resolveModelParams(model, presets, definition?)`；
  - `Scope` 新增 `reasoningPresets`（与 `config` 平级注入，不做全局单例）。

  换来三个结构性保证，全部来自表的形状、代码零分支：① 可选档位 = `Object.keys(levels)`；② 能否关闭思考 = 表里有没有 `off` 键；③ 「哪些参数键属于思考」= 整张表出现过的键的并集（写入前按此剔除旧值，`max` → `off` 不再残留 `reasoning_effort`，模型换策略也不会反刍上一套参数）。

- **`applyReasoningEffort` 的档位校验更严** —— 策略里没有该档位直接抛错（旧版对未声明能力的模型给的是「不支持档位」文案），错误信息带上策略名与可选档位列表。

### 🚀 新功能

- **`ConfigManager.readReasoningPresets()` / `ensureReasoningPresets()`** —— 策略表的读写与出厂同步。同步粒度**到单个策略**，规则与出厂模型同步同构：文件缺失即写种子；`custom: true` 的策略冻结；未标的用出厂版覆盖；用户自建的非出厂策略永远保留。`bootstrap()` 会自动调用。文件缺失或损坏时 `readReasoningPresets()` 回落到出厂种子，不让上层拿到空表。
- **`presetOf(model, presets)` / `modelLevels(model, presets)`** —— 策略查找与可选档位读取（`modelLevels` 取代旧的 `modelEfforts` + `modelAllowedEfforts` 两个函数：`off` 现在只是表里的一行，没有「档位」与「关闭」的二分）。
- **包入口补导出 `TokenThresholds` / `ReasoningPatch` / `ReasoningPreset` / `ReasoningPresets`** —— alpha.13 漏了这几个类型的导出（原 `7b10196` 补丁并入本版本）。

### ✅ 测试

- `src/shared/reasoning.test.ts` 重写（26 例）：出厂表协议事实（OpenAI 表无 `thinking` 键、`zhipu-5.3` 表无 `off`、DeepSeek 用 `thinking.type` 关闭）、可调档位 = 表的键、反查取最具体匹配、写入剔除旧键、往返一致、Agent 声明非法回退模型默认、原型链污染名字（`constructor`）不生效。
- `src/config/reasoning-presets.test.ts` 新增（11 例）：落盘位置、首次释放、幂等不写盘、未标 `custom` 被覆盖、标了 `custom` 冻结、用户自建策略保留、损坏/数组内容回落种子、`bootstrap()` 顺带释放。

### 📄 文档

- `docs/{zh,en}/sdk.md`：「思考强度」章节重写为「思考预设（reasoning presets）」，含策略表结构、出厂策略对照表、三个结构性保证、新 API 表与 `Scope` 注入示例。
- 顺手修掉 alpha.13 之后就过期的示例：`ContextGuardPlugin({ maxTokens, isSuspended })` → `{ guardTokens }`、`AutoMigratePlugin({ maxTokens })` → `{ handoffTokens }`、「交接回合护栏放宽 × 2」的旧描述。

## [1.0.0-alpha.13] - 2026-10-22

### 💥 Breaking Changes

- **`Model.maxContextTokens` / `maxContextChars` → `Model.tokenThresholds: { handoff, guard }`** —— 旧名字一直在误导（它既不是上下文窗口，也不是单一概念）。现在拆成两条**绝对值**：
  - `handoff`：软线，响应返回后 `prompt_tokens` 超过它触发任务交接（`AutoMigratePlugin`）；
  - `guard`：硬线，请求前用量超过它抛 `ContextOverflowError` 中断本轮（`ContextGuardPlugin`）。
  - `maxContextChars` 直接淘汰（字符口径早于 token 口径，两者并存只会让「按哪个判」长期含糊）。
  - 迁移由 `config/migrate.ts` 完成，`ConfigManager.read()` 读到即迁、`ensureDefaultConfig()` 检测差异才写盘：`maxContextTokens` → `handoff`，`maxContextChars` → `floor(/4)`，缺 `guard` 时按 1.5 倍折算一次（保持迁移前行为），旧键随即删除。
- **`ContextGuardPlugin` 的 `ratio` / `suspendedRatio` / `isSuspended` 全部删除** —— 它们只是「相对阈值」的产物。现在 `new ContextGuardPlugin({ guardTokens })` 一个绝对数就够：想调松就把数字改大。代价是**交接回合不再有 2.0 倍的额外放宽**，若需要该缓冲请把 `guard` 配得更大（出厂取 `handoff × 1.5`，并写成整数）。
- **`ContextOverflowError(promptTokens, guardTokens)`** —— 去掉 `maxTokens` / `ratio` / `threshold` 三个派生字段，改为直接暴露被越过的 `guardTokens`。
- **`AutoMigratePlugin` 的 `maxTokens` → `handoffTokens`**，`AutoMigrateTriggerInfo.maxTokens` → `handoffTokens`，`HandoffService` 的 `HandoffParams.maxTokens` / `HandoffContext.maxTokens` → `handoffTokens`（仅字段改名，语义不变：交接阈值）。

### ✨ 新增

- **思考强度（reasoning effort）能力位** —— 档位此前完全没有建模，CLI 只能手改 `defaultParams`，而各家端点接受的值域并不相同（智谱 GLM-5.3 系对 `medium` 直接报错、对 `thinking.type = "disabled"` 也报错）。现在分三层：
  - `Model.reasoning: { efforts: ReasoningEffort[], disable?: "thinking" | "effort-none" }` —— **物理能力上限**，按厂商官方文档声明（防 400）；
  - `AgentDefinition.reasoningEffort?: ReasoningEffort` —— 该 Agent 的实际档位，在 `createModel` 阶段覆盖模型 `defaultParams`。于是同一模型可以给不同 Agent 配不同强度（编程 Agent `max`、闲聊 Agent `low`、闲聊小号 `off`）。
  - 刻意**没有**做 Agent 侧的档位白名单（`reasoningEfforts`）：它解决的是伪需求（真正会 400 的是端点能力，那已由模型声明兜住），却引入「差一个 s」的命名陷阱与一层交集规则。
- **`shared/reasoning.ts`**（公共 API，均从包入口导出）：`resolveReasoningEffort()`、`resolveModelParams()`、`applyReasoningEffort()`（按声明写入，非法档位抛错）、`modelEfforts()` / `modelAllowedEfforts()` / `readReasoningEffort()` / `isReasoningEffort()` / `capabilityOf()`，以及 `ReasoningEffort` / `ReasoningCapability` 类型。
- **写入形态由声明决定**：`disable: "thinking"` → 同时维护 `thinking.type` 与 `reasoning_effort`（DeepSeek）；`disable: "effort-none"` → 只写 `reasoning_effort`（OpenAI 没有 `thinking` 参数，写它会被当未知参数）；未声明 `disable` → 只写 `reasoning_effort`，`off` 直接抛错（智谱 5.3 系）。
- **出厂模型按官方文档声明能力**（依据已写入 `constants.ts` 注释）：
  - `deepseek-flash` → `low/high/max`，可关闭（`api-docs.deepseek.com/guides/thinking_mode`）
  - `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` → `low/high/max`，**不可关闭**（`docs.bigmodel.cn/cn/guide/capabilities/thinking`）
  - `glm-4.7-flash` → 不可调（强制思考，`reasoning_effort` 仅 5.2+ 支持）
  - `gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna` → `minimal/low/medium/high`，可用 `reasoning_effort: "none"` 关闭
  - 未声明的模型一律视为不可调档，不推测

### 🔧 变更

- **`createModel(scope, modelId)` → `createModel(scope, modelId, overrides?: Pick<AgentDefinition, "reasoningEffort">)`** —— 新增的可选第三参由 `createAgent` 传入 `definition.reasoningEffort`。不传时行为与以前完全一致（原样返回模型 `defaultParams`）。

### ✅ 测试

- 新增 `shared/reasoning.test.ts` 22 例：能力声明与出厂清单一致性、`off` 只对有 `disable` 的模型开放、GLM-5.3 设 `medium` 与 `off` 均抛错、OpenAI 永不写 `thinking` 键、往返一致性、Agent 覆盖与回退。
- 新增 `config/migrate.test.ts` 13 例：旧字段迁移（tokens / chars / 两者 / 都无 / 脏值）、`guard` 折算、已是新形状时不迁移、不改入参、部分迁移时未变条目保持同一引用。
- 全量 **57 文件 / 599 用例** 通过（6 skipped），`tsc --noEmit` 与 `build` 零错误。

### 📄 Docs

- `docs/{zh,en}/sdk.md` 新增「思考强度（reasoning effort）」小节（三层模型、出厂声明表、写入形态、公共 API），核心实体表补充 `Model.reasoning` 与 Agent 的两个档位字段。

## [1.0.0-alpha.12] - 2026-10-22

### 💥 Breaking Changes

- **`createReadMcpResourceTool(mcpManager)` → `createReadMcpResourceTool(mcpManager, env: ToolEnv)`** —— 与 alpha.11 的 `createCallMcpTool` 对齐：`env` 用于读取 `maxToolOutput` 并解析当前模型绑定的端点。直接调用该工厂的下游需补第二参。
- **`view_image` 不再依赖 `deepseek` 端点** —— 此前本地图片固定上传到 `id === "deepseek"` 的端点，未配置时直接报「未配置 deepseek 端点，无法上传本地图片」。现在按能力位决定：声明 `capabilities.filesApi` 的端点走上传，其余走 base64 内联，没有 deepseek 也能查看本地图片。返回文案随之变化（含传输方式与降级说明）。
- **`Endpoint` 新增可选字段 `capabilities`** —— 类型层面非破坏性（可选），但语义重要：缺省视为「无特殊能力」，即不做上传。

### ✨ 新增

- **「本地文件 → 内容块」统一入口 `shared/content-blocks.ts`**。这段逻辑此前散落三处各自为政（`ViewImageTool` 硬编码端点 id、MCP 媒体块归一、CLI 侧再实现一遍），现在收敛为一处：
  - `fileToContentSection({ source, endpoint, model, signal, maxInlineBytes, deps })` → `{ section, transport, bytes, warning? }`；`source` 支持 `path` / `url` / `data`（`Uint8Array`）/ `base64` 四种来源。
  - 决策链：http(s) URL → `image_url`；端点有 Files API → 上传得 `file_id`（失败**自动降级**为内联）；其余端点 + 图片 → `image_url` + base64 data URL；其余端点 + 非图片 → `file` 块 + `file_data`；非视觉模型 + 图片 → 文本提示；内联超限且无法上传 → 抛错（不静默塞进请求体）。
  - 配套：`resolveModelAndEndpoint()`（按发给 API 的模型名反查模型与端点）、`supportsFilesApi()`、`mimeOf()` / `toDataUrl()` / `base64ByteLength()` / `contentHash()`、`clearUploadCache()`、`DEFAULT_MAX_INLINE_BYTES`（8 MiB）。
  - **已从包入口 `src/index.ts` 导出为公共 API**（`fileToContentSection` / `resolveModelAndEndpoint` / `supportsFilesApi` / `mimeOf` / `toDataUrl` / `base64ByteLength` / `contentHash` / `clearUploadCache` / `MIME_BY_EXT` / `DEFAULT_MAX_INLINE_BYTES`，以及 `FileSource` / `FileToSectionInput` / `FileToSectionResult` / `ContentTransport` / `UploadFn` / `EndpointCapabilities` 类型）。上层应用构造媒体消息时直接复用，不要各自再实现一遍「上传 or 内联」。
  - 上传缓存：路径来源用「端点 id + 绝对路径 + mtime + size」，内存来源用内容 sha256（同一张图不重复上传），上限 200 条。
  - `deps.upload` 可注入，便于测试与替换上传实现。
- **`Endpoint.capabilities.filesApi` 能力位** —— 出厂仅 `deepseek` 标记为 `true`（description 同步说明）。判据从「端点 id 是不是 deepseek」改为能力位，用户自建端点只要声明即可享受上传。

### 🔧 修复

- **MCP 媒体不再一律 base64 内联**：`call_mcp_tool` 的 `image` / `audio` / `resource.blob` 改走统一入口，端点有 Files API 能力时上传后以 `file_id` 发送，请求体不再随历史反复膨胀；转换失败**不丢块**，退化为一条文本说明，避免整个工具调用因媒体问题失败。
- **`read_mcp_resource` 的二进制资源被静默丢弃**：此前只拼 `contents[].text`，图片 / PDF 等 `blob` 内容直接消失。新增 `resourceToMessageSection()`——注意 `readResource` 的 contents 形如 `{ uri, mimeType?, text|blob }`，**没有 `type` 判别字段**，不能复用 `toMessageSection`（否则文本资源会被 JSON 化）；`blob` 交给统一入口。
- **`read_mcp_resource` 接入输出保护**：与 `call_mcp_tool` 共用同一套口径——文本超限落盘 `result.txt` 并返回头尾预览，媒体块原位保留；返回形态同样是「仅文本 → 字符串 / 含媒体 → 内容块数组」。
- **非视觉模型退化**：`Model.vision !== true` 时图片退化为一行文本提示（本地路径来源与 MCP 内存 base64 来源均生效），避免 `image_url` 被服务端 4xx 拒掉。
- **`edit` 并发护栏**：`edit` / `batch_edit` 工具描述明确「同一文件禁止并行 `edit`，多处修改改用 `batch_edit`，只有不同文件才能并行」——描述层劝阻（不引入运行时锁）。

### ✅ 测试

- 新增 `shared/content-blocks.test.ts` 16 例；`mcpTools.test.ts` 扩展覆盖媒体统一入口、非视觉退化、`read` 超限落盘与混排保序；`ViewImageTool` / `EditTool` / `BatchEditTool` 断言同步到新语义。
- 全量 **55 文件 / 569 用例**通过（6 skipped），`tsc --noEmit` 与 `build` 零错误。

### 📄 Docs

- `docs/{zh,en}/sdk.md` 新增「本地文件 → 内容块（统一入口）」小节、`Endpoint` 能力位与 MCP 媒体 / 退化 / 输出保护说明。
- `docs/{zh,en}/mcp.md` 同步 `call_mcp_tool` / `read_mcp_resource` 的媒体传输方式与输出保护口径。


## [1.0.0-alpha.11] - 2026-10-20

### 💥 Breaking Changes

- **`createCallMcpTool(mcpManager)` → `createCallMcpTool(mcpManager, env: ToolEnv)`** —— 新增的 `env` 只用于读取 `maxToolOutput`，由 `McpScopePlugin.instantiate` 传入 `scope.env`。直接调用该工厂的下游需补第二参。

### ✨ 新增

- **`call_mcp_tool` 输出保护**：MCP 工具是最容易一次吐出上百 KB 甚至上 MB JSON 的通道，此前完全裸返回。现在文本部分超过 `maxToolOutput`（默认 32768 字符）时，完整文本落盘为 `result.txt`，只返回警告 + 头尾预览（`outputTooLarge` / `chars` / `head` / `tail` / `files`）。复用内置工具同一套 `outputGuard` 骨架与同一配置口径，不另立阈值。
- **媒体内容块原样透传**：`image` → `image_url`（`data:<mimeType>;base64,...`）、`audio` → `file`（`file_data` 内联 data URL）、`resource.blob` 按 mimeType 分流到 `image_url` / `file`。媒体**不参与字符计数、不落盘、不丢弃**——只对文本做保护。
- **返回形态**：仅文本 → 纯字符串（与历史一致）；含媒体 → 内容块数组。

### 🔧 修复

- **非文本内容块被静默丢弃**：旧实现只取 `type === "text"`，`image` / `audio` / `resource` / `resource_link` 全部被扔掉，模型只知道「有个块没给我」。现在媒体透传、`resource.text` 并入正文、`resource_link` 转为 `[资源链接] name · uri · mimeType` 线索、未知类型（如 `tool_use`）退化为 JSON 文本。
- **内容块顺序**：严格按 MCP `content[]` 原始顺序逐块映射，文本夹在图片中间也保持原位。超限时只保留一个警告块占据原**首个**文本块的位置，其余文本落盘、媒体原位不动——即使文本夹在两图之间，图注与图片的对应关系也不会被打乱。
- **判定口径**：用全部文本的字符**总数**判超限，不逐块判（否则 N 段各 3 万字符都不超限、合起来却能灌爆）。

### ✅ 测试

- `mcpTools.test.ts` 38 例（新增内容块映射 8 例、输出保护 4 例、保序 4 例）。全量 **54 文件 / 542 用例**通过，`tsc --noEmit` 与 `build` 零错误。

### 📄 Docs

- `docs/sdk-design-v1.md` §9 `call_mcp_tool` 补充内容块映射表、输出保护口径与超限保序折叠规则；`../docs/{zh,en}/mcp.md` 及网站镜像同步。


## [1.0.0-alpha.10] - 2026-10-20

### 💥 Breaking Changes

- **`TaskMigrationService` → `HandoffService`，并拆成 `handoff()` / `migrate()` 两层** —— 「交接」（写交接文档）与「迁移」（交接 + 开新会话）此前混在一个方法里，现在概念与 API 一一对应：
  - `handoff(params)`：停工 → 核实 → 写文档 → 校验（失败降级）。**不改动会话**；
  - `migrate(params)`：`handoff()` 之后按 `strategy` 清历史并注入断点消息。
  - 类型随迁：`MigrationContext` → `HandoffContext`（新增 `mode` / `requestedMode` / `handoffPath` / `migrating`），`TaskMigrationServiceOptions` → `HandoffServiceOptions`（新增 `handoffDir` / `mode` / `skillDirs` / `minHandoffBytes`）。
  - 钩子重命名：`onBeforeMigrate` → `onBeforeHandoff`，新增 `onHandoff`（文档写好、清历史之前）。
- **交接文档改由「原 agent 在自己会话里写」（`mode: "self"`，默认）**，而非另起一次独立的摘要调用。原实现把历史序列化成 `[role]: content` 后交给一个无工具、无原会话上下文的调用，工具名与调用参数在序列化时全部丢失，写文档的一方也无法核实分支/改动/测试状态，只能靠推演——这是文档质量差的根因。现在的 `self` 回合：原 agent 保留全部上下文与工具，可 `read` / `exec` / `git status` 核实后落盘。
- **`summary`（旧的独立摘要）保留为逃生模式**，并作为 `self` 失败时的**单向**降级目标（无 `write` 工具 / 文件缺失或过小（重试一次）/ 工具或护栏报错）。反向永不发生——那会在上下文最满的时刻再加一次全量请求。
- **`AutoMigrateOptions` 新增 `resolveMode`**，把「用谁交接」从插件继承转移到回调：返回 `HandoffMode` 或 `null`（跳过本次迁移）。原 CLI 的 `AutoMigrateConfirmPlugin` 子类因此退化为纯回调。

### ✨ 新增

- **`HandoffGuardPlugin`**：交接回合的一次性工具守卫。只放行 `write` 到交接文档（绝对路径归一后比较），拒绝 `edit` / `batch_edit` / `rm` / `rename` / `mkdir` / `copy`。拒绝返回字符串（软拒绝）而非抛错——抛错会被 core 标记为 Error + `isPreventDefault`，整轮交接直接死。边界如实记录：挡不住 `exec`，它降低误操作概率，不是沙箱。
- **`ContextGuardPlugin` 新增 `isSuspended` / `suspendedRatio`**：交接回合（`service.busy`）把硬上限从 `× 1.5` 放宽到 `× 2`，既不被误杀又保留熔断。
- **出厂 Skill 机制**：`ConfigManager.ensureFactorySkills()` 在 `bootstrap()` 中释放 / 同步 `skills/handoff/SKILL.md`。覆盖策略与 `syncManagedModels` 同构——frontmatter 标 `metadata.custom: "true"` 视为用户自有、永不覆盖；否则随版本同步。内容以字符串常量内联在 `config/factory-skills.ts`（`tsc` 直接编译，无需打包非 TS 资源）。
- **交接模板的唯一真相源改为 Skill**：`HANDOFF_SECTIONS` / `createPrompt()` 已删除，代码只保留「读 Skill → 注入 → 校验文件 → 读不到时用 `FALLBACK_HANDOFF_TEMPLATE`」。Skill 只讲「怎么写」，代码只讲「写到哪、有什么能力」（本体系无模板变量引擎，不发明占位符）。
- `HandoffService.createHandoffFileName()`（`<YYYYMMDD-HHmmss>-<会话id前8位>.md`）、`createHandoffInstruction()`、`createPostMessages(handoffPath)`（断点**只给路径**，由接手方 `read`）。

### 🔧 修复

- **交接触发的无限递归**：交接回合本身是一次 `send()`，其 `onAfterSend` 会再次进入 `AutoMigratePlugin`。现以 `service.busy` 让行（`handoff()` / `migrate()` 共用一把锁，顺带拒绝重入）。
- **交接回合被自己触发/被护栏击杀**：交接恰好发生在上下文最满的时刻。除 `busy` 让行外，交接回合开跑前清空 `agent.lastUsage`（纵深防御），并由调用方在迁移后清空（否则护栏拿交接回合用量误杀新会话第一条消息）。

### ✅ 测试

- 新增 `HandoffService.test.ts`（24 例）、`HandoffGuardPlugin.test.ts`（7 例）、`factory-skills.test.ts`（7 例）；重写 `AutoMigratePlugin.test.ts`、`ContextGuardPlugin.test.ts`（新增 `isSuspended` 4 例）。全量 **54 文件 / 525 用例**通过，`tsc --noEmit` 与 `build` 零错误。

### 📄 Docs

- `docs/sdk-design-v1.md` §18 重写为「任务交接（HandoffService）」（两层语义、Template 单一真相源、两种执行者、自交接三道保险、接口、断点只给路径）；§17 插件章节、目录树与消费示例同步。
- `README.md` / `README.zh.md`、`../docs/{en,zh}/sdk.md`、`architecture.md`、`getting-started.md` 及网站镜像同步。


## [1.0.0-alpha.9] - 2026-10-14

### ⚠️ Dependency

- **`@ai-zen/agents-core` bumped to `^4.5.1`** — docs-only patch; no SDK source change.

### 📄 Docs

- Corrected the factory-defaults description in `docs/sdk-design-v1.md`: the preset **model count is 8** (was 7), and `DEFAULT_MCP_CONFIG` ships **two** servers (`socket-pty` + `chrome-devtools`).

## [1.0.0-alpha.8] - 2026-10-14

### ⚠️ Dependency

- **`@ai-zen/agents-core` bumped to `^4.5.0`** — picks up `AgentNS.Message.subAgentUsage` and the `sumUsage()` primitive. The skill sub-agent tool (`call_skill_sub_agent`) is built on `AgentToolLazy`, so it inherits the delegation-boundary stamping with no SDK source change.

## [1.0.0-alpha.7] - 2026-10-14

### ⚠️ Dependency

- **`@ai-zen/agents-core` bumped to `^4.4.0`** — picks up `AgentNS.Message.usage` (per-message token usage, stamped from the final stream chunk). No SDK source change; the `workspace:^` range resolves to `^4.4.0` on publish.

## [1.0.0-alpha.6] - 2026-10-13

### 💥 Breaking Changes

- **`exec_async` renamed to `spawn`** — the tool wraps `child_process.spawn` and returns `{ success, pid, message }`, so the new name matches both the implementation and the "start a process, get its pid" contract. It also pairs cleanly with `exec`: `exec` runs and **waits** (captures output, has a `timeout`), `spawn` starts and **returns immediately**. Permission lists, skill `allowed-tools` and any prompt naming `exec_async` must switch to `spawn`. The behaviour is otherwise unchanged — still shell-parsed, still does **not** capture output (redirect to a file if you need it).
- **Built-in tool classes renamed to match their new tool names** — `ReadFileTool` → `ReadTool`, `WriteFileTool` → `WriteTool`, `ExecAsyncTool` → `SpawnTool`, with the source files renamed to match. The classes re-exported from `@ai-zen/agents-sdk` change accordingly, so consumers importing them by name must update.

## [1.0.0-alpha.5] - 2026-10-13

### 💥 Breaking Changes

- **All built-in tool names unified on `snake_case`** — the multi-word tools that used camelCase were renamed. A tool name is the API contract the model sees and is matched **verbatim** by the permission system, so any `permissions.allow` / `deny` list, skill `allowed-tools` entry or prompt that names a tool must be updated:

  | old | new |
  |---|---|
  | `readFile` | `read` |
  | `writeFile` | `write` |
  | `inspectFile` | `inspect_file` |
  | `findText` | `find_text` |
  | `batchEdit` | `batch_edit` |
  | `downloadFile` | `download_file` |
  | `generateImage` | `generate_image` |
  | `viewImage` | `view_image` |

  Single-word tools (`cwd`, `edit`, `glob`, `ls`, `mkdir`, `rm`, `rename`, `copy`, `exec`, `exist`, `sleep`), the already-`snake_case` `exec_async`, the MCP / skill wrapper tools and core's `indexed_search` are unchanged. Tool descriptions and docs were updated in the same pass.

### 🔧 Changed

- **Dependency `@ai-zen/agents-core` bumped to `^4.3.2`** (carries the `indexedSearch` → `indexed_search` rename).

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.5`.

## [1.0.0-alpha.4] - 2026-10-13

### 🔧 Changed

- **Dependency `@ai-zen/agents-core` bumped to `^4.3.1`** (declared as `workspace:^`, expanded to `^4.3.1` at publish time). Pulls in core 4.3.1's fix for interrupted parallel tool rounds — the assistant message carrying `tool_calls` and its results now stay all-in or all-out, so an interrupted parallel tool call no longer leaves orphan `tool` results that the server rejects. `AgentContext` gains `abortedToolRoundStrategy` (default `"fill"`) and `abortedToolRoundReason`; set `agent.abortedToolRoundStrategy = "drop"` to drop the whole round instead

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.4`.

## [1.0.0-alpha.3] - 2026-10-03

### 🔧 Fixed

- **`generateImage` `model` parameter description no longer points at a host-CLI command** — the description used to read "配置中的图片模型可通过 'aiz config show' 查看" (the configured image models can be viewed via `aiz config show`). Since tool descriptions ship inside every request's `tools` payload, that hint propagated into **every layer** of the agent stack: the model would `exec("aiz config show")`, but the CLI resolves a bare `aiz config show` invocation as stdio mode with the instruction `config show` — i.e. a **brand-new agent** — whose own `generateImage` description repeats the very same hint, producing a self-referential recursion that keeps spawning nested agents. The parameter now reads "若指定的模型不存在，本工具会返回当前可用的模型列表" (if the specified model does not exist, this tool returns the list of currently available models), which matches the actual `!imageModel` branch in `call()` and stops the model from shelling out to the host CLI.

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.3`.

## [1.0.0-alpha.2] - 2026-10-03

### 🚀 New Features

- **`chrome-devtools` added to the factory default MCP config** — `DEFAULT_MCP_CONFIG` now ships two servers instead of one: alongside `socket-pty`, a freshly released `~/.ai-zen/mcp.json` includes `chrome-devtools` (`npx -y chrome-devtools-mcp@latest`, Google's official `chrome-devtools-mcp`), so browser debugging and automation work out of the box — page navigation, performance traces, network and console inspection, screenshots. Existing `mcp.json` files are still never overwritten, so user configurations (including custom flags such as `--executablePath`) are untouched. Defined in `packages/sdk/src/config/constants.ts`, released by `ConfigManager.ensureDefaultMcpConfig()`.

### ✅ Tests

- `ConfigManager.bootstrap.test.ts` now asserts the factory-default `mcp.json` carries both `socket-pty` and `chrome-devtools` (the latter resolved from the `chrome-devtools-mcp` package via `npx`), covering both the `bootstrap()` and `ensureDefaultMcpConfig()` paths.

### 📄 Docs

- Factory-default MCP descriptions in `docs/zh/mcp.md` / `docs/en/mcp.md` and `docs/zh/sdk.md` / `docs/en/sdk.md` now list both `socket-pty` and `chrome-devtools`.
- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.2`.

## [1.0.0-alpha.1] - 2026-10-03

### 💥 Breaking Changes

- **Factory model catalog refreshed (verified against vendor sources on 2026-10-03)** — every stale or retired model ID in `DEFAULT_APP_CONFIG.models` is replaced:
  - **OpenAI**: `gpt-5.5` → `gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna`
  - **Zhipu**: `glm-5.1` / `glm-5v-turbo` → `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx`
  - **DeepSeek**: `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` → `deepseek-flash`. The two V4-Flash variants were retired by the vendor, and V4-Pro requests are routed to V4.1-Flash.
  - Defaults: `defaultModel` / `defaultMigrationModel` move from `deepseek-v4-flash` to `deepseek-flash`.
- **`Model.maxContextTokens` semantics clarified — it is the task-migration (handoff) trigger threshold, not the model context window** — `AutoMigratePlugin` does not estimate or learn: it only compares `usage.prompt_tokens` from the API response against this value. The previous comment read "上下文窗口 token 上限" ("context window token limit"), which is why values had been filled in with raw window sizes. Values are now ~25% of the real window (250K for ≥1M-window models), except `glm-4.7-flash` (200K window) which uses 100K.

### 🚀 New Features

- **Managed model catalog sync (`custom` opt-out)** — `ConfigManager.ensureDefaultConfig()` now reconciles the factory catalog on every `bootstrap()`. Entries in `models` / `imageModels` that do **not** carry `custom: true` are dropped and replaced by the latest `DEFAULT_APP_CONFIG` definitions; entries marked `custom: true` are treated as user-owned and kept verbatim (user wins on id collision, no duplicates). A dangling `defaultModel` / `defaultImageModel` / `defaultMigrationModel` falls back to the factory default, so no reference is ever left pointing at a removed model. `endpoints` are never managed. The sync is idempotent — it only writes when something actually changed. Implemented in `ConfigManager.syncManagedModels`.
- **`Model` / `ImageModel` gained an optional `custom?: boolean` field** — marks an entry as user-owned so the factory sync leaves it untouched.

### ✅ Tests

- Added coverage for the model catalog sync: stale non-custom entries replaced, `custom: true` entries preserved, user version winning on id collision without duplication, image models reconciled, dangling default IDs falling back, and idempotency across repeated calls.
- E2E model IDs updated to the current vendor names (`deepseek-flash`).

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.1`.
- `DEFAULT_APP_CONFIG` row in `sdk-design-v0.md` updated to the new model catalog.

## [1.0.0-alpha.0] - 2026-09-30

### 💥 Breaking Changes

- **`Provider` renamed to `Scope` (fully removed, no compatibility alias)** — `runtime/Provider.ts` is migrated to `scope/Scope.ts`. All `provider` fields / params / variables are renamed to `scope`: `SdkAgent.provider` → `SdkAgent.scope`, `createAgent(scope, …)`, `createModel(scope, …)`, `createSubAgentTool(def, scope)`. `FilterOutput` / `ExcludeOptions` / `FilterOptions` move from `runtime/Provider` to `scope/Scope` accordingly.
- **Capability sources "delegated" to `ScopePlugin` (new capability-plugin contract)** — `Scope` degrades to a pure orchestration container: it only holds `config` / `cwd` / `env` / `agentsDir` and orchestrates the three-stage pipeline (discover → filter → instantiate). The four capability sources previously hard-coded in `Provider.refresh/filter/instantiate` are split into **5 standard plugins**, each self-containing its discovery state and instantiation logic:
  - `BuiltinToolsScopePlugin` (`id: "builtin"`) — 20 built-in tool classes
  - `UserToolsScopePlugin` (`id: "user-tools"`) — `tools/*.js`
  - `SkillsScopePlugin` (`id: "skills"`) — `SKILL.md` + `load_skill` / `call_skill_sub_agent`
  - `McpScopePlugin` (`id: "mcp"`) — `mcp.json` + a private `McpConnectionManager` + `load_mcp` / `call_mcp_tool` / `read_mcp_resource`
  - `SubAgentsScopePlugin` (`id: "subagents"`) — `sub-agents/*.json`
- **`Scope` no longer accepts capability-source paths, nor exposes an aggregated candidate set** — `new Provider({ config, cwd, agentsDir, skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })` → `new Scope({ config, cwd, agentsDir })`. Paths are now held by the plugins (pass absolute paths, or pass relative ones that each plugin joins against `scope.cwd` during `discover()`). `Scope` no longer has `builtinTools` / `userTools` / `subagents` / `skills` / `mcps` / `mcpManager` fields.
- **`Provider.create()` removed** — replaced by explicit assembly: `new Scope({...}).use(...plugins)` → `await scope.init()`. (The static `create` shortcut is removed for now, to be revisited later.)
- **Plugins must be assembled explicitly** — `Scope` registers no default plugins itself; without assembly it has "empty capabilities". The convenience factory `allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })` always returns the 5 standard plugins for one-shot assembly.

### 🚀 New Features

- **New `ScopePlugin` extension point** — contract `{ id; discover?; candidates; instantiate; dispose? }`, an extension point independent of core's `AgentPlugin` (Agent runtime hooks):
  - `discover?(scope, { silent })` — stage 1 · discovery (may be async, re-scans internally)
  - `candidates(scope, definition)` — stage 2 · contribute four-dimension candidate names (including availability checks, e.g. a synchronous `isAvailable`)
  - `instantiate(scope, filtered)` — stage 3 · produce `Tool[]` from the allowed names after filtering
  - `dispose?()` — release (e.g. disconnect MCP)
- **New `Scope` API**: `use(...plugins)` (chainable, variadic), `getPluginById(id)` (for external code / plugins to query plugin state), `plugins` (read-only view), `init()` / `refresh({ silent })` / `filter()` / `instantiate()` / `buildTools()` / `dispose()`. Calling `use()` after `init()` throws.
- **`dispose()` symmetric with `init()`** — calls each plugin's `dispose()` in reverse order; `McpScopePlugin.dispose()` → `mcpManager.disconnectAll()`, so MCP long-lived connections no longer rely solely on an idle timeout.
- **`allInOne()` convenience factory** — always returns the 5 standard plugins; order is priority (`builtin → user-tools → skills → mcp → subagents`; on dedupe, later registrations override earlier ones, so user tools can still override same-named built-in tools).
- **`McpScopePlugin.hasConfig()`** — lets `UnknownToolHintPlugin` determine "whether MCP config exists" (replacing a direct read of `provider.mcpPaths`).

### 🛠 Optimized

- **`UnknownToolHintPlugin` constructor now takes `{ scope }`** — it learns the MCP config via `scope.getPluginById(McpScopePlugin.ID)?.hasConfig()`; behavior semantics are unchanged (config present but `call_mcp_tool` denied → hint about permission; available → guide usage; no config → just hint that it doesn't exist).
- **`AutoRefreshToolsPlugin`** — now goes through `agent.scope.refresh()` / `agent.scope.buildTools()`.
- **Progressive-disclosure (lazy-loading) design unchanged** — the schema of `load_skill` / `call_skill_sub_agent` / `load_mcp` / `call_mcp_tool` / `read_mcp_resource`, enum disclosure (`createDisclosureParam`), the `include_manifest` switch, `touch` renewal, and `call_skill_sub_agent` reusing the parent tool set while excluding itself to prevent recursion — all **preserved verbatim**, merely moved from `Provider.instantiate()` to the `instantiate()` of `SkillsScopePlugin` / `McpScopePlugin`. Permission semantics are unchanged (denying `load_*` on the `tools` dimension cuts off the disclosure channel; denied skills/mcps never enter an enum).

### 📄 Docs

- Added [`docs/sdk-design-v1.md`](docs/sdk-design-v1.md) (the v1 design source of truth, covering the Scope / ScopePlugin architecture, the five plugins, and a migration guide); the old doc is renamed to [`docs/sdk-design-v0.md`](docs/sdk-design-v0.md).

### ✅ Tests

- All tests migrated to Scope + ScopePlugin: `capabilities.test.ts` rewritten to be organized by plugin dimension (built-in / SubAgent / Skill / MCP / user tools + lifecycle), with `createAgent` / `createModel` / `SdkAgent` / `UnknownToolHint` / `AutoRefreshTools` / `subAgentTools` / `integration` / `e2e-*` updated accordingly. SDK suite: **498 passed / 2 skipped** (including chat / view-image e2e against the real DeepSeek API).

## [0.12.0] - 2026-09-29

### 🚀 New Features

- **Unified tool output protection (`maxToolOutput`)** — `AppConfig` gains `maxToolOutput?: number` (in characters, default 32768; the factory `DEFAULT_APP_CONFIG` already writes this value). New output-protection skeleton `guardOutput()` (`capabilities/implements/builtin/outputGuard.ts`): tools declare their policy via three callbacks — `isOverLimit(content)` (the tool reads config itself to decide, including a combined measure), `dump(dir, content)` (the dumped-file list; the default is "warn only, no dump"), `buildWarning(ctx)` (the return body, with preview and stats); the skeleton only does two things: "decide → return as-is when under the limit / dump when over". The dump directory is `<os.tmpdir()>/ai-zen/tool-output/<tool>-<timestamp>-<random>/`, isolated and non-overwriting per call, with no self-cleanup (relying on the OS's policy for temp directories). Wired into:
  - **`exec`** — when `stdout + stderr` combined exceed the limit, they are dumped to separate files `stdout.log` / `stderr.log`, returning a warning + head/tail preview per stream (1000 chars each) + char/line counts; the original `exitCode` / `killed` / `terminated` fields are preserved;
  - **`findText`** — dumps `result.json`, returns a warning + head preview (1000 chars); the existing `maxMatches` / `maxFileSize` / `maxLineLength` params are unchanged;
  - **`glob` / `ls`** — dumps `result.json`, returns a warning + head preview, and hints how to narrow the scope (a more precise `pattern` / `exclude`, or switching to `glob`);
  - **`readFile`** — does **not** dump on overflow, only returns a warning and suggests batched reads via `range`.
  - Also exports `headPreview()` / `headTailPreview()` for tools to build previews as needed (the preview text is generated by each tool itself).
- **`readFile` gains a `range` param (optional)** — `range: [startLine, startCol, endLine, endCol]`, all 0-based, with `-1` meaning the last index; e.g. `[0, 0, 100, -1]` means "read from line 0 col 0 through line 100's last column". The 300KB read threshold is unchanged — the read threshold (whether a file can be read) and the output threshold (whether to dump) are independent.
- **New `inspectFile` tool (`InspectFileTool`)** — surveys a file's structural overview without reading content, complementing `readFile`'s `range` (look at the structure first, then decide the read range). Returns `path` / `bytes` / `lines` / `chars` / `maxCol` / `lineIndexOfMaxCol` (0-based) / `avgCol` / `lineEnding` (`LF` / `CRLF` / `mixed`); an optional `withColCountMap: true` returns a "line index → column count" object map. Streamed scan, **not limited by the 300KB read threshold**; columns are counted as characters, excluding the line-ending newline; on overflow the detail is not dumped, only the overview plus a hint that "the file scale exceeds the processable range". Built-in tool classes increased from 19 to 20.
- **`batchEdit` output slimmed down** — successful items no longer echo the old and new text; when all succeed it returns `{ result: "success", replacedCount }`; when there are unmatched items it returns `{ result: "partial", replacedCount, failed: [{ oldText, newText, reason }] }`, echoing only the problematic old and new text, so large blocks aren't echoed back to inflate the output.
- **`AgentDefinition` gains a `custom` field** — when `true`, SDK init does not touch the Agent's built-in content (e.g. the default prompt). The factory `DEFAULT_AGENT_DEFINITION` carries `custom: false`: `ensureDefaultAgent()` **syncs only the factory prompt** when `custom !== true` (user changes to `name` / `permissions` / `modelId` etc. are preserved), and when the prompt is identical it writes nothing and leaves `updatedAt` untouched (randomly generated message `id`s are ignored in the comparison to avoid timestamp drift).
- **Default Agent prompt adjusted** — the original rules are replaced by two: ① when a user decision is needed, ask only one question at a time; ② the current conversation is Node.js-driven, so you can write Node.js scripts to perform complex tasks and run them via the `exec` tool.

### ✅ Tests

- Added `outputGuard.test.ts` (skeleton: return as-is under the limit / dump + warning over the limit / warn-only without `dump` / directory isolation / `headPreview` and `headTailPreview`), `InspectFileTool.test.ts` (overview fields, the `colCountMap` map, CRLF and mixed, no trailing newline on the last line, empty files, files over 300KB, detail-overflow degradation, directories and non-existent paths), and overflow/range-read cases for each tool; `ConfigManager.bootstrap.test.ts` covers `custom: true` skipping, syncing only the prompt, and not writing when identical. SDK suite: **499 passed / 6 skipped**

## [0.11.0] - 2026-09-28

### 💥 Breaking Changes

- **`createCallSkillSubAgentTool` drops the third param `provider`** — the Skill sub-agent no longer re-resolves its tool set via `provider.buildTools(parent.definition, …)`; instead it **reuses the parent Agent's tool set directly** (`ctx.agent.tools`), excluding only `call_skill_sub_agent` itself: as a one-shot conversational clone, the Skill sub-agent reuses the caller's capabilities without a second permission pass, while also preventing chained skill self-recursion. Callers that passed a `Provider` must drop that argument

### 🚀 New Features

- **Skill sub-agent brought into the unified delegation boundary** — `call_skill_sub_agent` is now backed by `AgentToolLazy` (previously an in-place `CallbackTool`), so it shares the same `onSubAgentStart` / `onSubAgentEnd` plugin hooks and `sub-agent-start` / `sub-agent-end` events as regular SubAgent tools. Consumers that plug guards into `ctx.subAgent` (e.g. a context guard) and those that render sub-agent streaming output (e.g. the CLI) now cover this path

### 🛠 Optimized

- **Skill sub-agent construction consolidated into `buildAgent`** — the sub-agent's initial messages (`System(SKILL.md content)` + `User(task)`) are now decided by `buildAgent` (leveraging core 4.3.0's optional `messages`); the previously hand-written abort linkage and return-value handling are deleted, delegated to the tool base class for a unified implementation
- **Validation failures now throw** — a missing `skill_id`, or a Skill that doesn't declare `sub-agent: true`, now throws an error (previously it returned a hint text); the normal path is constrained by the `skill_id` enum, so it isn't triggered
- **Dependency `@ai-zen/agents-core` bumped to `^4.3.0`** — the dependency declaration stays `workspace:^`, expanded to `^4.3.0` by pnpm at publish time. core 4.3.0 makes `AgentToolLazy.messages` optional

### ✅ Tests

- The `createCallSkillSubAgentTool` cases in `skillTools.test.ts` are rewritten around `AgentToolLazy`: tool contract unchanged, unknown Skill throws, non-sub-agent Skill throws, delegation boundary (`onSubAgentStart` and `sub-agent-start` dispatch, the child reusing the parent tool set while excluding itself, initial messages drawn from SKILL.md and `task`); SDK suite: **463 passed / 6 skipped**

## [0.10.0] - 2026-09-28

### 🚀 New Features

- **`load_mcp` gains an `include_manifest` switch (optional boolean, default `true`)** — the default behavior is unchanged verbatim (returns the full `{ tools, resources }` manifest, with tools carrying the full `inputSchema`); passing `false` explicitly only establishes the connection and returns a summary `{ server, connected, tools: count, resources: count }`, without any tool/resource definitions. It serves the "connection has gone stale after a process restart, but the manifest already exists in context" scenario: rebuild the connection only, without re-injecting tens of KB of tool definitions into the context, saving tokens. The full manifest stays inside `McpConnectionManager`, and `call_mcp_tool` / `read_mcp_resource` behavior is unchanged; the `server` param enum, the tool-name table, and `DYNAMIC_TOOL_NAMES` are all unchanged (the prefix-cache structure is unaffected). The failure-path and already-connected-path semantics are identical in both modes; `docs/sdk-design.md` §9 updated accordingly

### 🛠 Optimized

- **Dependency `@ai-zen/agents-core` bumped to `^4.2.0`** — the dependency declaration stays `workspace:^`, expanded to `^4.2.0` by pnpm at publish time. core 4.2.0 adds the sub-agent delegation blocking hooks `onSubAgentStart` / `onSubAgentEnd` and renames the existing `sub-agent` event to `sub-agent-start` (a core-side breaking change); the SDK doesn't listen to that event internally, so no source adaptation is needed. Consumers listening to that event must rename accordingly

### ✅ Tests

- `mcpTools.test.ts` gains 4 cases: silent + not connected, silent + connected, explicit `true`, silent + connection failure; SDK suite: **461 passed / 6 skipped**

## [0.9.4] - 2026-09-20

### 🔧 Fixed

- **MCP `sse` transport switched to a real SSE connection (`SSEClientTransport`)** — previously `http` and `sse` were handled together, both using `StreamableHTTPClientTransport` (Streamable HTTP: POST to send messages + an optional SSE stream), which made legacy HTTP+SSE servers declared as `type: "sse"` (GET to open the SSE stream, POST to the endpoint to send messages) actually run on a mismatched protocol stack. Now they are split by transport: `http` → `StreamableHTTPClientTransport`, `sse` → `SSEClientTransport` (both built-in official SDK implementations). `headers` are still passed through via `requestInit`, applied uniformly by the SDK to the SSE stream setup (GET) and message-sending (POST) requests; the error behavior when `url` is missing is unchanged. The `McpServerConfig.transport` comment and `docs/sdk-design.md` §10/§11 updated accordingly

### ✅ Tests

- Verified against a real MCP server (`packages/test-project/mcp-servers/sse-server.mjs`, legacy HTTP+SSE protocol): connection setup, tool discovery (`echo` / `add`), tool calls, and disconnect/reconnect; and confirmed the runtime transport instance is `SSEClientTransport`

## [0.9.3] - 2026-09-01

### 🔧 Fixed

- **`createAgent` no longer pollutes the Agent definition template (`definition.messages` reference isolation)** — when creating an Agent, `definition.messages` is now snapshot (`[...(definition.messages ?? [])]`) instead of being referenced directly. Previously the definition array was passed straight to `AgentContext.messages` (a mutable runtime array), so during a conversation `append()` would write the full conversation history back into `definition.messages`, causing:
  - the task-migration `prune` branch to expand the polluted "full history" instead of the template → old messages were neither physically deleted nor marked `omit`, yet the newly injected breakpoint message was visible;
  - the `omit` branch's `preserveCount` to equal the full length because `definition.messages` and `agent.messages` pointed to the same array → history messages could not be marked `omit`;
  - `/new` to copy from the polluted template, so a new conversation inherited the old history.
  - Also fixes a crash when creating an Agent whose definition lacks a `messages` field (`undefined`) (with a `?? []` fallback).

### ✅ Tests

- `createAgent.test.ts` gains: `append` does not pollute `definition.messages` (reference isolation); an Agent whose definition lacks a `messages` field is created normally

## [0.9.2] - 2026-08-31

### 🎯 Optimized

- **Default Agent prompt refactored (`DEFAULT_AGENT_DEFINITION`)** — streamlined and stylistically unified:
  - the persona is set to "witty and humorous, rigorous and reliable"
  - the original 8 principles are compressed into one core rule: whenever you hit any situation that is unclear, uncertain, contradictory, or that might affect the result, stop immediately and ask the user directly, rather than filling in the gaps yourself, guessing, or forcing ahead
  - a new "terse" principle: state only the result and necessary explanation; the execution process (tool calls, reads/writes, searches, etc.) is already visible to the user, so don't restate it, to save tokens
  - guards retained: proactively call tools, report faithfully, and act only within the scope you've been assigned
  - injects "current operating system" info, dynamically using `process.platform` to adapt to different platforms
- **`ViewImageTool` gains a local-URL check** — a new `isLocalUrl()` rejects the `file://` protocol and http(s) URLs pointing to local loopback addresses (`localhost`/`127.0.0.1`/`[::1]`/`0.0.0.0`) (API providers cannot download them), erroring early in the call; `function.description` and the `path_or_url` param description now add "local URLs are not supported; use a file path for local images"

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
