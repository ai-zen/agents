# TODO2 — MCP 兼容性修复

接手此项目请先读 `GOAL.md`（设计原则）和 `docs/sdk-design.md`（设计真相源）。

---

## 背景

用户 `mcp.json` 配置存在但 `load_mcp` 工具未出现，原因是代码未遵循业界标准的 MCP 配置格式。

**规范来源**：业界主流实现（Claude Desktop、Cline 等）统一使用以下格式：

```json
{
  "mcpServers": {
    "some-server": {
      "command": "npx",
      "args": ["..."],
      "type": "sse",
      "disabled": false
    }
  }
}
```

**格式说明**：
- 顶层字段：`mcpServers`（不是 `servers`）
- transport 类型字段：`type`（不是 `transport`）
- 启用/禁用字段：`disabled`（不是 `enabled`）
- transport 取值：`"stdio"`、`"http"`、`"sse"`

---

## 待完成任务

### P0 — Bug 修复

| # | 问题 | 说明 | 状态 |
|---|------|------|:--:|
| 1 | **顶层字段名未遵循业界标准** | `discoverMcpServers` 读的是 `config.servers`，业界标准是 `mcpServers`，应改用 `mcpServers` | ✅ |
| 2 | **transport 字段名和取值未遵循业界标准** | 代码期望 `transport` 字段，业界标准是 `type`（部分工具同时输出 `transportType` 作为兼容）；取值 `"sse"` 无对应处理 | ✅ |
| 3 | **SSE transport 未实现** | `McpServerConfig.transport` 类型声明了 `"sse"`，但 `createTransport` 没有对应分支 | ✅ |

### P1 — 代码健壮性

| # | 问题 | 说明 | 状态 |
|---|------|------|:--:|
| 4 | **配置归一化：`discoverMcpServers` 需统一解析字段** | 原始 JSON 字段（`type`/`transportType`→`transport`、`disabled`→`enabled`）需在发现阶段归一化为内部 `McpServerConfig` 字段，后续全链路使用统一数据源 | ✅ |
| 5 | **`disabled` 字段未消费** | 业界标准使用 `disabled` 字段（boolean），解析时应跳过 `disabled: true` 的 server | ✅ |
| 6 | **配置解析失败静默吞错误** | `discoverMcpServers` 中 `catch {}` 静默跳过，调试困难，应加日志 | ✅ |
| 7 | **`load_mcp` 枚举来源与查找来源不一致** | enum 来自 `filteredMcps`（经 `discoverMcpServers` 发现+权限过滤），查找时却依赖外部注入的 `mcpConfigs` Map。`mcpManager` 内部化后，查找直接使用 `this.mcps`，消除不一致 | ✅ |
| 8 | **`autoApprove`、`timeout` 等字段未处理** | 用户配置中携带了 `autoApprove`、`timeout` 等字段，当前无任何消费逻辑 | ⬜ |

### P2 — 类型清理

| # | 问题 | 说明 | 状态 |
|---|------|------|:--:|
| 9 | **`sse` transport 未实现** | 业界标准中 `"sse"` 是常见 transport 取值，`createTransport` 需要添加 SSE 分支（使用 `StreamableHTTPClientTransport`） | ✅ |
| 10 | **`McpServerConfig` 中 `name` 和 `id` 语义不清** | `discoverMcpServers` 用 key 作 id，而业界标准中 server 的 key 本身就是唯一标识，应统一用 key 作为 id，移除冗余的 `name` 字段 | ✅ |

### P3 — 架构重构

| # | 问题 | 说明 | 状态 |
|---|------|------|:--:|
| 11 | **`mcpManager` 由 Provider 内部创建** | 当前 `mcpManager` 和 `mcpConfigs` 由外部注入，与 `Capabilities` 内部发现的 `this.mcps` 数据源不统一。`McpConnectionManager` 是纯技术基础设施，应由 `Provider` 在构造时内部创建，外部只需传 `mcpPaths`。`createLoadMcpTool` 不再需要 `mcpConfigs` 参数，直接通过 `this.mcps` 构建查找表 | ✅ |
