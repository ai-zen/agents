# TODO：core 4.0.0 架构重构 — 以退为进（官方 SDK + 插件化 Agent 驱动层）

> 状态：**Phase 0-6 已完成**（代码、测试、文档全绿）。
> 本文件是本次重构的单一执行依据。

## 背景与目标

当前 core 自研了整套"请求抽象层"（Endpoint 构建 URL/Header/Body + Model 自研 fetch/SSE 解析/类型转换，约 1000 行生产代码 + 850 行测试），属于重复造轮子，且效果不如官方 SDK 成熟稳定。同时 RAG 概念（隐式检索注入）被认定为低价值设计，检索能力应由**搜索工具**承担（项目已有 `IndexedSearchTool`）。

本次重构"以退为进"：
1. **砍掉请求抽象层**，Agent 直接使用 **OpenAI 官方 SDK（openai 包）**
2. **砍掉 RAG 及整套检索基础设施**（Rag / EmbeddingSearch / KnowledgeBase / VectorDatabase / EmbeddingModel）
3. **Agent 插件抽象从 SDK 提升到 core**，消除 `SdkAgent.send()` 的钩子 hack，子 Agent 自动获得插件能力
4. **钩子收口**：删除 Agent 原有 `onXxx` 构造钩子，所有钩子统一通过插件使用；`events.emit` 收口到 `dispatchHook`（非阻塞事件 + 可短路插件）
5. core 最终形态：**官方 SDK + 插件化 Agent 驱动层**，聚焦真正的核心价值

## 已确认决策（含实施中修正）

| # | 决策 | 说明 |
|---|------|------|
| 1 | Agent 构造改为 `{ client, model, modelConfig, ... }` | `client` 为 openai SDK 的 `OpenAI` 实例，`model` 为模型名；core 直接依赖 `openai` 包 |
| 2 | 删除能力标记 `IS_SUPPORT_*` | Agent 始终用 `tools` 格式，`function_call` 旧格式兼容一并删除 |
| 3 | 删除 RAG 全部代码 | Rag / EmbeddingSearch / KnowledgeBase / VectorDatabase / EmbeddingModel / TextEmbeddingAda002_2 及相关测试 |
| 4 | 插件抽象提升到 core + **钩子收口** | `AgentPlugin`/`SendContext`/`Agent.use()/init()` 内建 core；**删除 AgentContext 全部 `onXxx` 构造钩子，插件成为唯一扩展方式**；所有钩子统一返回值 `HookResult = string \| void \| Promise<string \| void>`（string 短路） |
| 5 | 版本并入 **4.0.0** | 4.0.0 未发布，本次破坏性重构直接作为 4.0.0 内容，一次提交不留中间态 |
| 6 | `DeepSeekFiles` **删除**，改用 `client.files` | DeepSeek 特异 `expires_after` 功能暂不保留（如需，后续薄适配补充，见"可选后续"） |
| 7 | **命名统一**：内部标识符 camelCase、协议字段保 snake_case | 趁 4.0.0 破坏性重构一并处理，见下方"命名风格统一" |
| 8 | **`Message.raw_content` 与 `Message.rewrite()` 删除** | RAG 删除后无消费者（死代码，奥卡姆剃刀） |
| 9 | **`ContextGuardPlugin` 默认 `ratio` = 1.5（+50%）** | 用户设定（原 1.2）；测试与注释已同步 |
| 10 | **事件名 kebab-case** | `dispatchHook` 内 `events.emit` 用中划线事件名（`before-send`/`inner-loop-start`/`tool-call`/`unknown-tool` 等），payload = 各钩子 ctx |

## 命名风格统一

**规则：内部标识符一律 camelCase；协议字段（与 LLM API 对齐）保持 snake_case。**

### 已完成（内部标识符 → camelCase）

| 现状 | 改为 | 状态 |
|------|------|------|
| `parsed_args` | `parsedArgs` | ✅ 完成 |
| `result_message` | `resultMessage` | ✅ 完成 |
| `is_prevent_default` | `isPreventDefault` | ✅ 完成 |
| `parse_error` | `parseError` | ✅ 完成 |
| `model_config` | `modelConfig` | ✅ 完成 |
| `raw_content` | `rawContent` → **整个字段+`Message.rewrite` 已删除** | ✅ 完成 |

### 不改（协议字段，与 API 对齐）

- `AgentNS.Message`：`tool_calls` / `tool_call_id` / `function_call` / `finish_reason` / `reasoning_content` / `role` / `content`
- API 参数：`max_tokens` / `top_p` / `stream_options` / `include_usage` / `temperature` 等
- 端点配置 `openai_endpoint` / `azure_endpoint` / `api_version` / `request_config` / `endpoint_config`：随 Endpoint/Model 文件删除自动消失

### 边界（保持不动）

- `ToolCallContext.tool_call` / `function_call`：协议概念的载体
- `FunctionCallContext` 别名：deprecated 兼容，保留
- SDK config 数据结构（`endpointId` / `modelName` / `maxContextTokens` / `defaultParams`）：已是 camelCase

## 钩子收口设计（已完成）

- **`HookResult`**：`string | void | Promise<string | void>`，返回 string 即短路（拒绝/中断/提供结果），undefined/void 放行
- **`AgentPlugin` 统一返回值**（入参保持各自类型）：
  - `onToolCall(ctx: ToolCallContext)` → string = 拒绝该工具，原因回给 LLM
  - `onUnknownTool(ctx: UnknownToolContext)` → string = 工具结果；undefined = 走默认提示
  - 其余 `(ctx: SendContext)` → string = 中断（`onBeforeSend`/`onInnerLoopStart`/`onInnerLoopsStart` 抛错中断；`onAfterSend`/`onInnerLoopEnd`/`onInnerLoopsEnd` 仅短路后续插件）
- **`AgentContext` 不再提供任何 `onXxx` 构造钩子**，扩展唯一途径是 `agent.use(plugin)`
- **`dispatchHook(hook, ctx)`** 统一收口：
  ```ts
  this.events.emit(kebabCase(hook), ctx);   // 非阻塞事件（不 await、不短路）
  for (const p of this._plugins) {           // 阻塞插件（短路）
    const r = await p[hook]?.(ctx);
    if (r !== undefined) return r;
  }
  ```
- **事件名**：`before-send` / `after-send` / `inner-loop-start` / `inner-loop-end` / `inner-loops-start` / `inner-loops-end` / `tool-call` / `unknown-tool`；流式事件（`open`/`chunk`/`parsed`/`error`/`finally`/`sub-agent`）不变
- **未知工具兜底**：`Agent.protected defaultUnknownTool()`（默认提示）；`SdkAgent` 覆盖为 MCP 智能提示；用户插件优先级最高

## 目标架构

```
┌─ core（@ai-zen/agents-core 4.0.0）───────────────────────────┐
│  Agent 驱动层（插件化 + 钩子收口）                            │
│    Agent / AgentContext / AgentPlugin / SendContext          │
│    HookResult / dispatchHook（事件 + 插件统一入口）           │
│    AgentNS(类型) / Message / Tool / ToolCallContext           │
│    Tools: CallbackTool / CodeTool / AgentTool / AgentToolLazy │
│           / IndexedSearchTool（搜索工具替代 RAG）             │
│           ↓ 直接调用                                           │
│  openai 官方 SDK（依赖 openai ^7）                             │
│    client.chat.completions / client.images / client.files     │
└───────────────────────────────────────────────────────────────┘
        ↑
┌─ sdk（@ai-zen/agents-sdk）────────────────────────────────────┐
│  Provider（能力管线/权限/MCP/插件/ConfigManager）              │
│  createModel → { client, model, modelConfig }（openai SDK 装配）│
│  SdkAgent（瘦身：元数据 + defaultUnknownTool 覆盖，插件继承 core）│
│  内置工具（GenerateImageTool 用 client.images.generate）       │
│  具体插件（AutoRefresh/AutoMigrate/ContextGuard 适配）          │
└───────────────────────────────────────────────────────────────┘
```

## 实施步骤

### Phase 0：前置准备 ✅
- [x] 确认 openai 包 API 形态（**7.5.0**：`create(body, { signal })` → `APIPromise<Stream<ChatCompletionChunk>>`；`images.generate`；`files.create/retrieve/list/delete`）
- [x] core `package.json`：dependencies 增加 `openai`；移除 `@ai-zen/node-fetch-event-source`、`@ai-zen/async-queue`、`jose`
- [x] SDK 增加 `openai` 依赖；冻结现有 4.0.0 未提交改动

### Phase 1：core 改造 ✅
- [x] 命名统一（`parsedArgs`/`resultMessage`/`isPreventDefault`/`parseError`/`modelConfig`；`rawContent`+`Message.rewrite` 删除）
- [x] `AgentContext`：构造 `{ client, model, modelConfig, messages, tools, allowJsonParseError }`；删除 `rag` 与全部 `onXxx` 钩子属性
- [x] 插件提升：`AgentPlugin`/`SendContext`/`use`/`init` 内建 core；`dispatchHook` 收口事件 + 插件（kebab-case 事件、短路）
- [x] `Agent.run()`：改用 `client.chat.completions.create({ ...modelConfig }, { signal })`；`defaultParams`（DeepSeek thinking）透传
- [x] `parseStreamData`：消费 `ChatCompletionChunk`（reasoning_content 按 any 兼容）
- [x] `formatTools`：始终 `tools` + `strict: true`，删能力标记
- [x] `AgentTool`/`AgentToolLazy`：删 rag；命名适配
- [x] 删除文件：Endpoint/Endpoints、Model/Models、Rag/Rags、KnowledgeBase、VectorDatabase、Files/DeepSeekFiles
- [x] `index.ts` 更新导出；`AgentNS.ts` 保留视觉类型；`CHANGELOG.md` 4.0.0 条目；`package.json` version 4.0.0
- [x] 钩子收口：删构造钩子、统一 HookResult、dispatchHook、defaultUnknownTool（SdkAgent 覆盖）

### Phase 2：core 测试 ✅
- [x] 删除请求层/RAG 相关测试
- [x] 改写 `Agent.test`（mock openai client + fake stream；新增插件机制/短路测试）
- [x] 修复 `integration.test.ts` preventDefault 预存 bug（callback(this)→callback(_args, ctx)）
- [x] 钩子收口适配：构造钩子 → `agent.use()`；事件 payload 断言改 ctx
- [x] core `tsc` + `vitest run` 全量通过（**124 passed**）

### Phase 3：SDK 适配 ✅
- [x] `createModel.ts`：`new OpenAI({ apiKey, baseURL })` → `{ client, model, modelConfig }`；apiKey 空抛明确错误
- [x] `SdkAgent.ts`：删插件 hack 与 `onUnknownTool` 属性，改覆盖 `protected defaultUnknownTool`；构造 `{ client, model, modelConfig }`
- [x] `createAgent.ts`：适配新构造
- [x] `GenerateImageTool.ts`：改用 `client.images.generate`（data 可空处理）
- [x] 三个插件：类型来源改 core，`ctx.agent` 断言 `SdkAgent`
- [x] `subAgentTools.ts` / `skillTools.ts`：Agent 构造适配
- [x] `types/index.ts`：config 数据结构不变；`Provider` 无需改动

### Phase 4：SDK 测试 ✅
- [x] 适配 `createModel.test` / `SdkAgent.test` / `AutoRefreshToolsPlugin.test` / `Provider.test` / `skillTools.test` / `e2e-chat.test` / `e2e-real-paths.test` / `ContextGuardPlugin.test`（ratio 1.5）/ `createAgent.test`（defaultUnknownTool）
- [x] SDK `tsc` + `vitest run` 全量通过（**432 passed / 1 skipped**，含真实 DeepSeek API e2e）

### Phase 5：文档 ✅
- [x] `packages/core/README.md` / `README.zh.md`：Agent 构造 `{ client, model }`；新增**插件与钩子收口**章节（HookResult 短路、dispatchHook、kebab-case 事件）；删除 RAG / Endpoint / Model 章节；Files 改 `client.files`
- [x] `packages/sdk/docs/sdk-design.md`：更新 Model 装配、SdkAgent（defaultUnknownTool）、插件说明；已确认无 request_config/chatCompletionSync 残留；`ContextGuardPlugin` ratio 1.2→1.5
- [x] 根 `README.md`：Core 类表、架构描述同步（删 Endpoint/Model/RAG、加插件与钩子）

### Phase 6：验证与提交 ✅
- [x] 全量验证：core tsc + build + 测试（**125 passed**）；SDK tsc + 测试（**445 passed / 1 skipped**，含真实 DeepSeek e2e）
- [x] core CHANGELOG 4.0.0 条目补充**钩子收口**说明；SDK CHANGELOG 补 0.7.0 条目（适配 core 4.0.0）
- [x] 未跟踪文件已由用户清理（`deepseek-vision.html` / `deepseek-file.html` / `fetch-deepseek-vision.mjs`）
- [x] 统一 `git add`（暂存区已整理），提交 message 建议：`refactor(core)!: adopt official openai SDK, drop RAG, promote plugins, unify hooks (4.0.0)`（待用户确认后提交）

## 砍掉清单（已完成）

| 类别 | 文件 |
|------|------|
| 请求层 | `Endpoint.ts`、`Endpoints/*`、`Model.ts`、`Models/*`、`Files/*` |
| RAG | `Rag.ts`、`Rags/*`、`KnowledgeBase.ts`、`VectorDatabase.ts`、`EmbeddingModel*`、`TextEmbeddingAda002_2*` |
| 钩子 | AgentContext 全部 `onXxx` 构造钩子（改插件）；`Message.raw_content` + `Message.rewrite` |
| 依赖 | `@ai-zen/node-fetch-event-source`、`@ai-zen/async-queue`、`jose` |
| 测试 | 对应上述文件的全部测试 |

## 保留清单

- **驱动层**：`Agent` / `AgentContext` / `AgentNS` / `Message` / `Tool` / `ToolCallContext`
- **工具**：`CallbackTool` / `CodeTool` / `AgentTool` / `AgentToolLazy` / `IndexedSearchTool`
- **插件机制**（提升到 core）：`AgentPlugin` / `SendContext` / `HookResult` / `use` / `init` / `dispatchHook`
- **SDK 引擎**：Provider / 能力管线 / 权限 / MCP / 插件 / ConfigManager / EntityRepository

## 风险与注意事项

1. ~~openai v7 API 形态~~ ✅ 已核对（v7.5.0）
2. ~~`defaultParams` 透传~~ ✅ 已处理（对象展开 `as any`，DeepSeek thinking 可透传）
3. ~~Agent 测试 mock~~ ✅ 已实现（fake client + fake async iterable stream）
4. ~~`createStream` 同步→异步~~ ✅ 已处理（`await create`；abort 走 signal，回归通过）
5. ~~`integration.test.ts` 预存失败~~ ✅ 已修复（preventDefault）
6. ~~智谱端点~~ ✅ 出厂配置走 OpenAI 兼容，JWT 端点类删除无影响
7. ~~浏览器兼容~~ 需在发布前确认（openai SDK 浏览器可用）
8. **事件 API 变化**：`inner-loop-start` 等事件 payload 由 `(messages, tools)` 改为 `ctx`（SendContext），消费方需适配
9. **`Message.rewrite` 已删**：如外部有依赖需迁移

## 剩余待办

1. **SDK 版本号确认**：CHANGELOG 已按 0.7.0 撰写，`packages/sdk/package.json` version 是否同步 bump 待用户确认
2. **提交**：`git commit`（待用户确认）message 建议：`refactor(core)!: adopt official openai SDK, drop RAG, promote plugins, unify hooks (4.0.0)`

## 可选后续（不在本次范围）

- [ ] 知识库检索如未来需要：作为**工具**（如 `search` 工具）而非隐式 RAG 提供

> ✅ 已完成：SDK 出厂配置 `constants.ts` 增加视觉模型 `deepseek-v4-flash-vision-exp`
> ✅ 已完成：`Tool.exec` 返回类型扩展为 `AgentNS.MessageContent`（工具可返回图片/文件内容块）；`Model.vision` 区分视觉模型，`SdkCallbackTool.isAvailable(config, definition)` 让工具自声明可用性（直接透传完整 config + agent definition），19 个内置工具全量挂 `BUILTIN_TOOL_CLASSES`（发现层零过滤），`Provider.filter`/`buildTools` 接收 definition 并按工具声明在 build 阶段过滤（无硬编码、无运行时重复校验）；SDK 新增 `ViewImageTool`（仅视觉模型可用，本地图片自动 Files API 上传 → file 块，URL 直接 image_url 块）；`GenerateImageTool` 统一返回字符串（URL JSON + viewImage/downloadFile 提示），不替模型决定「看不看」；实测 chat.completions 支持 tool 消息携带图片
> ✅ 无需封装：官方 openai SDK（v7）原生支持 DeepSeek Files API（`purpose: "user_data"` + `expires_after`），自研 `DeepSeekFiles` 无需恢复
