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
| 1 | **顶层字段名未遵循业界标准** | `discoverMcpServers` 读的是 `config.servers`，业界标准是 `mcpServers`，应改用 `mcpServers` | ⬜ |
| 2 | **transport 字段名和取值未遵循业界标准** | 代码期望 `transport` 字段，业界标准是 `type`（部分工具同时输出 `transportType` 作为兼容）；取值 `"sse"` 无对应处理 | ⬜ |
| 3 | **SSE transport 未实现** | `McpServerConfig.transport` 类型声明了 `"sse"`，但 `createTransport` 没有对应分支 | ⬜ |

### P1 — 代码健壮性

| # | 问题 | 说明 | 状态 |
|---|------|------|:--:|
| 4 | **`discoverMcpServers` 与 `createLoadMcpTool` 的字段映射不一致** | `discoverMcpServers` 直接展开原始字段，`createLoadMcpTool` 通过 `mcpConfigs` Map 查找；两者依赖隐式字段名一致，应提取统一解析函数做 `type`→`transport` 等归一化 | ⬜ |
| 5 | **`disabled` 字段未消费** | 业界标准使用 `disabled` 字段（boolean），`McpServerConfig` 定义了 `enabled` 但用户配置用 `disabled`，应统一为 `disabled` | ⬜ |
| 6 | **配置解析失败静默吞错误** | `discoverMcpServers` 中 `catch {}` 静默跳过，调试困难，应加日志 | ⬜ |
| 7 | **`load_mcp` 的枚举来源与查找来源不一致** | enum 来自 `filteredMcps`（权限过滤后），查找用 `mcpConfigs`（完整 Map），依赖隐式一致性 | ⬜ |
| 8 | **`autoApprove`、`timeout` 等字段未处理** | 用户配置中携带了 `autoApprove`、`timeout` 等字段，当前无任何消费逻辑 | ⬜ |

### P2 — 类型清理

| # | 问题 | 说明 | 状态 |
|---|------|------|:--:|
| 9 | **`sse` transport 未实现** | 业界标准中 `"sse"` 是常见 transport 取值，`McpServerConfig.type` 声明了 `"sse"` 但 `createTransport` 没有对应分支 | ⬜ |
| 10 | **`McpServerConfig` 中 `name` 和 `id` 语义不清** | `discoverMcpServers` 用 key 作 id，而业界标准中 server 的 key 本身就是唯一标识，应统一用 key 作为 id | ⬜ |
