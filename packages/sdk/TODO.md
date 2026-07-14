# TODO

> SDK = 后端（完整功能体系），CLI/Desktop = 前端（纯界面）。SDK 包圆一切，上层只管输入输出。
>
> **接手此项目请先读完本文档，再读 [`docs/sdk-design.md`](./docs/sdk-design.md)。**

---

## 接手指南

### 项目定位

这是 `@ai-zen/agents-sdk`，位于 pnpm monorepo `packages/sdk/` 下。

```
agents/                        ← pnpm workspace
├── packages/
│   ├── core/                  ← @ai-zen/agents-core  基础框架（Agent, Message, Tool, Model, RAG）
│   ├── sdk/                   ← @ai-zen/agents-sdk   【本包】业务逻辑层
│   ├── cli/                   ← @ai-zen/agents-cli   命令行（未接入 SDK，待重写）
│   └── webui/                 ← @ai-zen/agents-webui Web 界面
├── GOAL.md                    ← 项目设计原则（必读）
├── AI_README.md               ← AI 助手行为准则（改动前先商量）
└── README.md                  ← 项目总览
```

### SDK 的职责

SDK 不直接与 LLM 通信——那是 Core 的工作。SDK 负责：

- 配置文件读写、实体 CRUD
- 能力发现（内置工具、用户工具、Skill、SubAgent、MCP）
- 权限过滤、枚举披露
- Agent 装配（把定义 + 配置 + 候选 → `ResolvedAgent`，含 `Tool[]`）
- Session 插件链（`refreshTools`、`autoMigrate`、`autoDraft`）
- MCP 连接生命周期管理（包括底层 transport 实现）
- 任务迁移

### SDK 与 Core 的边界（关键！）

| | SDK | Core |
|------|-----|------|
| 包名 | `@ai-zen/agents-sdk` | `@ai-zen/agents-core` |
| 主要产出 | `ResolvedAgent`（纯数据）、`Session`（插件包装） | `Agent`（实例）、`Message`、`Tool` |
| LLM 通信 | ❌ 不涉及 | ✅ `Agent.send()` / `Agent.run()` |
| 文件 I/O | ✅ config / agent / conversation / draft | ❌ |
| 权限 | ✅ 过滤 + 披露 | ❌ 不感知 |

**关键约定**：SDK 不创建 Core `Agent` 实例。`resolveAgent` 产出纯数据 `ResolvedAgent`，由上层（CLI/Desktop）用它构造 Core `Agent`，再用 SDK 的 `createSession` 包装。

### 设计真相源

| 文件 | 角色 |
|------|------|
| `docs/sdk-design.md` | **唯一设计真相源**。所有实现必须与本文档一致 |
| `docs/skills-spec.md` | Agent Skills 官方规范 |
| `docs/skills-compliance-plan.md` | Skills 规范对齐方案（已 100% 落地） |
| `docs/mcp-*.md`（9 篇） | MCP 官方规范快照 |

### 模块分层（依赖方向严格单向）

```
session ──> runtime ──> capabilities ──> crud ──> config ──> types
  │            │
  ├────────────┤
  │            └──> shared
  │
  └──> @ai-zen/agents-core (Agent, Message)
```

每层只能依赖下一层，不能反向。同层模块不互相依赖。

`capabilities/` 内部：

```
capabilities/
  discovery/       ← 阶段 1：扫描文件系统，找到候选
  implements/      ← 阶段 3：工具实例 + 动态工具工厂
  pipeline.ts      ← 阶段 2：权限过滤管线
  ...
```

### 开发命令

```bash
cd packages/sdk

pnpm test          # 运行 195 个测试（25 个文件）
pnpm test:watch    # 监听模式
pnpm build         # tsc 编译到 dist/
pnpm format        # Prettier 格式化
pnpm format:check  # 检查格式
```

### 测试约定

- 每个源文件同目录下配一个 `*.test.ts`
- 需要文件系统的测试使用 vitest 的 `tmpdir()` 临时目录，`beforeEach`/`afterEach` 清理
- Mock 使用 vitest 的 `vi.fn()` 和 `vi.useFakeTimers()`
- 集成测试放在 `test/` 目录

### 当前状态

- ✅ TypeScript strict 模式，零编译错误
- ✅ 195 个测试全部通过（25 个文件）
- ✅ `src-deprecated/` 已清理
- ⚠️ CLI 尚未接入 SDK，自己维护了一套重复实现（`agent-creator.ts`、`draft.ts`、`conversation-runner.ts` 等）
- ⚠️ CLI 有 25 个测试失败，部分因 Windows 路径分隔符问题，部分因缺少 SDK 构建产物

### 常见坑

- **Windows 路径**：`memfs` mock 中路径可能返回 `\` 而非 `/`，测试断言需兼容
- **CLI 测试依赖 SDK 构建**：CLI 的 e2e 测试需要先 `pnpm build` SDK，否则报 `ERR_MODULE_NOT_FOUND`

---

## 已定案设计

参见 [`docs/sdk-design.md`](./docs/sdk-design.md)，尤其：

- **§4** 模块分层：`capabilities/` 内部拆为 `discovery/` + `implements/`
- **§6** 工具装配三阶段：发现（返回实例）→ 过滤（权限管线）→ 实例化（产出 `Tool[]`）
- **§7** MCP 连接：SDK 全权管理，包括底层 transport 实现
- **§11** Session 插件：`refreshTools`（`beforeSend` 钩子，全量重扫）
- **§12** 一站式装配：`resolveAgent` 产出 `ResolvedAgent { tools: Tool[], refresh() }`

消费模式（方案 B — 三步）：

```ts
const resolved = resolveAgent({ agentId, config, ...paths });
const agent = new Agent({ model, messages: resolved.messages, tools: resolved.tools });
const session = await createSession({ agent, model })
  .use(refreshTools(resolved))
  .use(autoMigrate(...))
  .use(autoDraft(...))
  .init();
```

---

## 实现步骤

### P0 — 核心通路

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 1 | `discoverBuiltinTools` 保持 | 已从 `BUILTIN_TOOLS` 提取 function.name，与其他 discover 函数对称 | ✅ |
| 2 | `discoverUserTools` 返回 `Tool[]` | 类型已改为 `Tool[]`，`require` 部分待实现（当前返回空数组） | ⬜ |
| 2b | 安全模块加载机制 | `discoverUserTools` 需要安全的 `require()` 加载 `.js` 文件，含沙箱/错误隔离 | ⬜ |
| 3 | `discoverSubAgents` 返回 `AgentDefinition[]` | ✅ 已完成 | ✅ |
| 4 | `assembleCapabilities` 接受/产出 `Tool[]` | ✅ 已完成。输入 `Tool[]` / `AgentDefinition[]`，输出 `AssemblyOutput { tools: Tool[] }`，subagents 已内部转为 AgentToolLazy，动态工具已内部按条件注册 | ✅ |
| 5 | `resolveAgent` 实现三阶段组装 | ✅ 已完成。discovery → pipeline → implements 全部在 `resolveAgent` 内闭环 | ✅ |
| 6 | `refreshTools` 插件 | `SessionPlugin.beforeSend` → `resolved.refresh()` → `ctx.agent.tools = fresh.tools` | ⬜ |

### P1 — MCP 闭环

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 7 | SDK 内置 stdio transport | 当前 `McpTransport` 是空接口，需实现 stdio 进程管理（子进程 spawn、stdin/stdout JSON-RPC） | ⬜ |
| 8 | SDK 内置 HTTP transport | 同上，含 HTTP SSE 连接 + 请求/响应 | ⬜ |
| 8b | OAuth token 持久化 | 实现 `mcp-oauth/` 目录的 token 读写 + 授权码交换流程（本地回调服务器 + 浏览器打开）+ token 刷新 | ⬜ |
| 9 | `McpTransport` 补充方法 | `callTool` / `readResource` / `listPrompts` / `getPrompt` 等方法 | ⬜ |
| 10 | `McpConnectionManager` 暴露 transport | `getTransport(name)` 供 `call_mcp_tool` / `read_mcp_resource` 使用 | ⬜ |
| 10b | `createCallSkillSubAgentTool` 工厂函数 | 在 `capabilities/implements/skill-tools.ts` 中创建 `CallbackTool`。回调中直接克隆 `this.agent`（Core Agent 实例），替换 messages 为 skill 正文 + task，过滤递归工具 | ✅ |
| 10c | `pipeline.ts` 注册 `call_skill_sub_agent` | 在 `assembleCapabilities` 的条件注册中补全，skillsPaths 和 skillDisclosure 已就绪 | ⬜ |
| 10e | `call_mcp_tool` 回调完整实现 | 通过 transport.callTool 调用，非占位符 | ⬜ |
| 10f | `read_mcp_resource` 回调完整实现 | 通过 transport.readResource 调用，非占位符 | ⬜ |

### P2 — 收尾

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 11 | `runtime/` 简化 | `factory.ts` → `types.ts`（只保留类型），`assembleAgent` 内联到 `resolveAgent`，删 `skill-sub-agent.ts` | ⬜ |
| 12 | 更新 `src/index.ts` 导出 | 补全 `createCallSkillSubAgentTool` 等新 API | ⬜ |
| 13 | 端到端测试 | `resolveAgent` → `new Agent()` → `createSession` 完整链路 | ⬜ |
| 14 | CLI 接入 SDK | 删 CLI 中重复的 agent-creator、工具发现、draft 逻辑 | ⬜ |

### P2 — Skill 增强

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 16 | Skill 辅助文件加载 | 实现 `loadSupportingFile` 机制，加载 `scripts/`、`references/`、`assets/` 目录 | ⬜ |
| 17 | Skill 预算管理 | 按使用频次排序，低频 Skill 加载后可能被任务迁移截断 | ⬜ |

### P2 — MCP 增强

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 18 | MCP Prompts 支持 | `prompts/list`、`prompts/get` 及对应的动态提示工具 | ⬜ |
| 19 | MCP Resources 模板与订阅 | `resources/templates/list`、`resources/subscribe` | ⬜ |

### P3 — 可延后

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 20 | MCP Roots / Sampling | MCP Client 特性，SDK 层暂不处理，由上层实现 | ⬜ |
| 21 | `generateImage` 扩展更多服务 | 当前仅支持 ZhipuImage（智谱），后续可扩展 DALL-E 等 | ⬜ |

---

## 已完成

| # | 项 | 说明 |
|---|------|------|
| ✅ | 类型定义改为返回实例 | `discoverSubAgents` → `AgentDefinition[]`，`discoverBuiltinTools` → `Tool[]`，`discoverUserTools` → `Tool[]` |
| ✅ | `AssemblyOutput` 归一化 | 去掉 `subagents`/`skillParam`/`mcpParam` 三个字段，全部合并进 `tools: Tool[]` |
| ✅ | `pipeline.ts` 内部闭环 | SubAgent → AgentToolLazy、动态工具按条件注册，全部在管线内完成 |
| ✅ | `factory.ts` 去冗余 | 删掉 `rawSubagents` 等无意义的中间变量 |
| ✅ | `capabilities/` 目录重组 | `discovery/` + `implements/`，删除旧 `tools/` |
| ✅ | `BUILTIN_TOOLS` 注册 = 实现 | `implements/builtin/` 下 16 个文件（15 个内置工具 + `generateImage` 工厂），每个含 schema + callback |
| ✅ | `generateImage` 工具 | 从 CLI 照搬实现，适配 SDK 的 `AppConfig` 架构，通过 `imageModels` 配置驱动 |
| ✅ | `AppConfig` 图片模型支持 | 新增 `ImageModel` 接口，`AppConfig` 增加 `imageModels?` 和 `defaultImageModel?` 字段 |
| ✅ | 设计文档 §12 | `resolveAgent` + `ResolvedAgent` + `refresh()` 完整定义 |
| ✅ | MCP 责任归属修正 | `types/index.ts`、`mcp-tools.ts` 删除"上层实现"错误阐述，设计文档 §7 明确 SDK 全权管理 |
| ✅ | `load_mcp` 实际使用 McpConnectionManager | connect / getManifest / touch，不再返回占位符 |
| ✅ | `SessionPlugin.beforeSend` | 已存在（代码 + 设计文档均已支持） |
| ✅ | `autoMigrate` + `autoDraft` | 已实现并通过测试 |
| ✅ | Conversation / Draft 含 `cwd` | 类型已定义 |
| ✅ | `McpConnectionManager` | 连接生命周期管理已实现（重连、退避、超时、状态机） |
| ✅ | 发现层多路径对称化 | `discoverSkills`/`discoverSubAgents`/`discoverUserTools`/`readSkill` 多路径 + Set 去重 |
| ✅ | 工具去重 | `assembleCapabilities` 中 `dedupLastWin` |
| ✅ | Draft 7 天过期清理 | `checkDraftForRestore` |
| ✅ | `onHandoff` 回调扩展 | 传入 oldAgent / newAgent，支持 CLI 重绑事件 |
| ✅ | `exec` 工具错误处理 | 补充 exitCode 返回，命令执行失败时返回错误码而非空结果 |
| ✅ | `ResolvedAgent` 对齐设计文档 | `messages`、`tools` 顶级字段、`refresh()` 方法已就位 |
| ✅ | `resolveAgent` 一站式装配 | 从磁盘加载 → 发现 → 过滤 → 实例化，全部在 `resolveAgent` 内闭环 |
| ✅ | `createCallSkillSubAgentTool` | `call_skill_sub_agent` 工具工厂，回调直接克隆 `this.agent`（Core Agent），无需 `createSkillSubAgent` |
| ✅ | `runtime/` 简化 | 删 `factory.ts`、`skill-sub-agent.ts`，装配逻辑全部内联到 `resolveAgent` |
