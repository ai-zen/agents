# TODO

> 基于规范对照和代码审查，记录当前 SDK 的待办事项。

---

## 接手指南

### 项目定位

这是 `@ai-zen/agents-sdk`，位于 monorepo `packages/sdk/` 下。整个仓库结构：

```
agents/                        ← pnpm workspace
├── packages/
│   ├── core/                  ← @ai-zen/agents-core  基础框架（Agent, Message, Tool, Model, RAG）
│   ├── sdk/                   ← @ai-zen/agents-sdk   【本包】业务逻辑层
│   ├── cli/                   ← @ai-zen/agents-cli   命令行（旧版，未接入 SDK，待重写）
│   └── webui/                 ← @ai-zen/agents-webui Web 界面
├── GOAL.md                    ← 项目设计原则（必读）
├── AI_README.md               ← AI 助手行为准则
└── README.md                  ← 项目总览
```

**SDK 的定位**：介于 Core 和上层（CLI/Desktop）之间的共享业务逻辑层。SDK 不直接与 LLM 通信——那是 Core 的工作。SDK 负责：

- 配置文件读写、实体 CRUD
- 能力发现（内置工具、用户工具、Skill、SubAgent、MCP）
- 权限过滤、枚举披露
- Agent 装配（把定义 + 配置 + 候选 → 可运行的数据）
- Session 插件链（autoMigrate 等）
- MCP 连接生命周期管理
- 任务迁移

### 关键文件

| 文件 | 角色 |
|------|------|
| `docs/sdk-design.md` | **唯一设计真相源**。所有实现必须与本文档一致 |
| `docs/skills-spec.md` | Agent Skills 官方规范（agentskills.io） |
| `docs/skills-compliance-plan.md` | Skills 规范对齐方案（已 100% 落地） |
| `docs/mcp-*.md`（9 篇） | MCP 官方规范快照（modelcontextprotocol.io） |
| `src/index.ts` | SDK 公开 API 导出清单 |

### 模块分层（依赖方向严格单向）

```
session ──> runtime ──> capabilities ──> crud ──> config ──> types
  │            │              │
  ├────────────┤              │
  │            └──> shared <──┘
  │
  └──> @ai-zen/agents-core (Agent, Message, AgentNS)
```

每层只能依赖下一层，不能反向。同层模块不互相依赖。

### SDK 与 Core 的边界

| | SDK | Core |
|------|-----|------|
| 包名 | `@ai-zen/agents-sdk` | `@ai-zen/agents-core` |
| 主要产出 | `ResolvedAgent`（数据）、`Session`（插件包装） | `Agent`（实例）、`Message`、`Tool` |
| LLM 通信 | ❌ 不涉及 | ✅ `Agent.send()` / `Agent.run()` |
| 文件 I/O | ✅ config/agent/conversation/draft | ❌ |
| 权限 | ✅ 过滤 + 披露 | ❌ 不感知 |

**关键约定**：SDK 的 `createAgent` / `resolveAgent` 产出的是纯数据 `ResolvedAgent`，消费者需要用它构造 Core 的 `Agent` 实例，再用 SDK 的 `createSession` 包裹。SDK 不创建 Core Agent 实例。

### 开发命令

```bash
cd packages/sdk

pnpm test          # 运行 173 个测试（24 个文件）
pnpm test:watch    # 监听模式
pnpm build         # tsc 编译到 dist/
pnpm format        # Prettier 格式化
pnpm format:check  # 检查格式
```

### 测试约定

- 每个源文件同目录下配一个 `*.test.ts`
- 需要文件系统的测试使用 `tmpdir()` 临时目录，`beforeEach`/`afterEach` 清理
- Mock 使用 vitest 的 `vi.fn()` 和 `vi.useFakeTimers()`
- 集成测试放在 `test/` 目录

### 当前状态

- ✅ `src-deprecated/` 已清理（旧代码）
- ✅ `dist/` 已重新构建（与新 `src/` 一致）
- ✅ `.gitignore` 已更新
- ✅ TypeScript strict 模式，零编译错误
- ✅ 191 个测试全部通过（25 个文件）

---

## P0 — 投产阻塞

### 1. ~~发现层多路径对称化~~ ✅ 已完成

> 已实现：`discoverSkills`/`discoverSubAgents`/`discoverUserTools`/`readSkill` 全部改为多路径 + Set 去重。
> `ResolveAgentInput` 改为 `subAgentsPaths`/`skillsPaths`/`toolsPaths`。

### 2. ~~Draft 自动保存（autoDraft 插件）~~ ✅ 已完成

> 已实现：`src/session/auto-draft.ts` 含 `autoDraft` 插件和 `checkDraftForRestore`。

---

## P1 — 重要

### 3. OAuth 流程（MCP HTTP）

设计文档 §7 描述了完整的 OAuth 流程（token 检查/刷新/授权码交换/本地回调服务器），
当前仅 `McpServerConfig.oauth` 类型已定义，`McpConnectionManager` 中零实现。

- [ ] 实现 OAuth token 持久化（`mcp-oauth/` 目录）
- [ ] 实现授权码流程（本地回调服务器 + 浏览器打开）
- [ ] 实现 token 刷新逻辑

### 4. ~~工具去重~~ ✅ 已完成

> 已实现：`assembleCapabilities` 中 `dedupLastWin` 去重，后出现的覆盖先出现的。

### 5. 集成测试补充

当前 `test/integration.test.ts` 仅 1 个测试，覆盖 `createAgent`（纯函数）。

- [ ] `resolveAgent` 端到端测试（文件系统 → 装配）
- [ ] Session + autoMigrate 端到端测试（触发迁移 → Agent 替换）

---

## P2 — 可延后

### 6. ~~README 开发状态更新~~ ✅ 已完成

> 已更新：模块状态表全部改为 ✅，测试数据更新为 191 个。

### 7. Agent Skills 阶段 3（辅助文件加载）

设计文档 §8 规定了 `loadSupportingFile` 机制，当前 `scripts/`、`references/`、`assets/` 目录未实现加载逻辑。

### 8. Skill 预算管理

设计文档 §8 规定：加载后的 skill 正文按使用频次排序，低频可能被任务迁移截断。当前无实现。

### 9. MCP Prompts 支持

`McpPromptDef` 类型已定义，但 `prompts/list`、`prompts/get` 以及对应的动态加载工具未实现。

### 10. MCP Resources 模板与订阅

`resources/templates/list`、`resources/subscribe` 未实现。

---

## P3 — 暂不处理（设计明确延后或有意不做）

### 11. MCP Roots / Sampling

MCP Client 特性，SDK 层可以不实现，由上层处理。

### 12. MCP tool 级权限

设计文档 §10 明确说"当前无此需求"，预留扩展即可。

### 13. ~~启动恢复（Draft 7 天过期清理）~~ ✅ 已完成

> `checkDraftForRestore` 已实现：检查 `_current.json`，7 天内返回 Draft，过期自动清理。
