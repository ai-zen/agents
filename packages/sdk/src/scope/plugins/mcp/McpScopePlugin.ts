import type { Tool } from "@ai-zen/agents-core";
import { isAbsolute, join } from "node:path";
import { discoverMcpServers } from "./discover.js";
import {
  createCallMcpTool,
  createLoadMcpTool,
  createReadMcpResourceTool,
} from "./mcpTools.js";
import { McpConnectionManager } from "./McpConnectionManager.js";
import type { McpServerConfig } from "../../../types/index.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * MCP 插件 —— 发现 mcp.json + 自持连接管理器 + 装配渐进式披露元工具。
 *
 * 渐进式披露设计原样保留：
 *   - `load_mcp`            枚举所有允许的 server（含 include_manifest 开关）
 *   - `call_mcp_tool`       调用已连接 server 的工具
 *   - `read_mcp_resource`   读取已连接 server 的资源
 * 三个元工具名恒上报 `tools` 维度；`mcpManager` 由本插件私有持有，
 * 有配置路径时在构造时创建，`dispose()` 时统一断开。
 */
export class McpScopePlugin implements ScopePlugin {
  static readonly ID = "mcp";
  readonly id = McpScopePlugin.ID;

  private readonly paths: string[];
  private readonly mcpManager: McpConnectionManager | undefined;
  private servers: McpServerConfig[] = [];

  constructor(options?: { paths?: string[] }) {
    this.paths = options?.paths ?? [];
    this.mcpManager =
      this.paths.length > 0 ? new McpConnectionManager() : undefined;
  }

  async discover(scope: Scope): Promise<void> {
    const files = this.paths.map((p) => (isAbsolute(p) ? p : join(scope.cwd, p)));
    this.servers = await discoverMcpServers(files);
  }

  /** 是否配置了 MCP（供外部代码判定，如 UnknownToolHintPlugin） */
  hasConfig(): boolean {
    return this.paths.length > 0;
  }

  candidates(): ScopeCandidates {
    return {
      mcps: this.servers.map((s) => s.id),
      tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource"],
    };
  }

  instantiate(_scope: Scope, filtered: FilterOutput): Tool[] {
    const allow = new Set(filtered.tools);
    const allowedMcps = new Set(filtered.mcps);
    const filteredMcps = this.servers.filter((s) => allowedMcps.has(s.id));
    const m = this.mcpManager;

    const result: Tool[] = [];
    if (allow.has("load_mcp") && m && filteredMcps.length > 0) {
      result.push(createLoadMcpTool(m, filteredMcps));
    }
    if (allow.has("call_mcp_tool") && m) {
      result.push(createCallMcpTool(m));
    }
    if (allow.has("read_mcp_resource") && m) {
      result.push(createReadMcpResourceTool(m));
    }
    return result;
  }

  async dispose(): Promise<void> {
    await this.mcpManager?.disconnectAll();
  }
}
