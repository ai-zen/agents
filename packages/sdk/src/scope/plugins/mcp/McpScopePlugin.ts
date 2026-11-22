import type { Tool } from "@ai-zen/agents-core";
import { isAbsolute, join } from "node:path";
import { discoverMcpServers } from "./discover.js";
import {
  createCallMcpTool,
  createCancelMcpTaskTool,
  createGetMcpTaskResultTool,
  createLoadMcpTool,
  createReadMcpResourceTool,
} from "./mcpTools.js";
import { McpConnectionManager } from "./McpConnectionManager.js";
import { CANCEL_MCP_TASK_TOOL, GET_MCP_TASK_RESULT_TOOL } from "./mcpTaskNotice.js";
import type { McpTaskNoticePort } from "./mcpTaskNotice.js";
import type { McpServerConfig } from "../../../types/index.js";
import type { LogSink } from "../../../shared/logger.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * MCP 插件 —— 发现 mcp.json + 自持连接管理器 + 装配渐进式披露元工具。
 *
 * 渐进式披露：
 *   - `load_mcp`                枚举所有允许的 server（含 include_manifest 开关）
 *   - `call_mcp_tool`           调用已连接 server 的工具（可带任务参数）
 *   - `read_mcp_resource`       读取已连接 server 的资源
 *   - `get_mcp_task_result`     按任务 id 取回一个任务的结果
 *   - `cancel_mcp_task`         取消一个任务
 * 五个元工具名恒上报 `tools` 维度；`mcpManager` 由本插件私有持有，
 * 有配置路径时在构造时创建，`dispose()` 时统一断开。
 *
 * 每次 `discover()` 除了重读 mcp 文件，还会把连接与发现结果对账一次（见 `reconcileConnections`）。
 */
export class McpScopePlugin implements ScopePlugin {
  static readonly ID = "mcp";
  readonly id = McpScopePlugin.ID;

  private readonly paths: string[];
  private readonly mcpManager: McpConnectionManager | undefined;
  /** 日志口（可选）：连接管理器与 `load_mcp` 那两句都走它；不注入就不记 */
  private readonly logger?: LogSink;
  private servers: McpServerConfig[] = [];

  /**
   * @param options.taskNotice 任务通知的投递口（可选）：不给就是任务状态没有人接，其余照常
   */
  constructor(options?: { paths?: string[]; logger?: LogSink; taskNotice?: McpTaskNoticePort }) {
    this.paths = options?.paths ?? [];
    this.logger = options?.logger;
    this.mcpManager =
      this.paths.length > 0
        ? new McpConnectionManager(undefined, undefined, options?.logger, options?.taskNotice)
        : undefined;
  }

  async discover(scope: Scope): Promise<void> {
    const files = this.paths.map((p) => (isAbsolute(p) ? p : join(scope.cwd, p)));
    const discovered = await discoverMcpServers(files, { logger: this.logger });
    await this.reconcileConnections(discovered);
    this.servers = discovered;
  }

  /**
   * 让连接跟着发现结果对账。
   *
   * 连接是按**定义**建立的：声明改了而连接不动，等于「配置改了但实际没生效」。所以
   *   - 这次发现里消失的 server → 断开它的连接（连同缓存的状态 / 清单一起失效）；
   *   - 定义变了的 server → 断开旧连接，下一次调用时按新定义懒连；
   *   - 新增的 server → 不主动连（保持懒连接：没人调用就不起进程 / 不建链）；
   *   - 定义没变的 → 一个字节都不动（连接与清单原样留着）。
   *
   * 于是「改了 mcp 配置」只需刷一次 Scope，不必重建它。
   */
  private async reconcileConnections(discovered: McpServerConfig[]): Promise<void> {
    const manager = this.mcpManager;
    if (!manager) return;
    for (const id of staleMcpConnections(this.servers, discovered)) {
      await manager.disconnect(id);
    }
  }

  /** 是否配置了 MCP（供外部代码判定，如 UnknownToolHintPlugin） */
  hasConfig(): boolean {
    return this.paths.length > 0;
  }

  candidates(): ScopeCandidates {
    return {
      mcps: this.servers.map((s) => s.id),
      tools: [
        "load_mcp",
        "call_mcp_tool",
        "read_mcp_resource",
        GET_MCP_TASK_RESULT_TOOL,
        CANCEL_MCP_TASK_TOOL,
      ],
    };
  }

  instantiate(scope: Scope, filtered: FilterOutput): Tool[] {
    const allow = new Set(filtered.tools);
    const allowedMcps = new Set(filtered.mcps);
    const filteredMcps = this.servers.filter((s) => allowedMcps.has(s.id));
    const mcps = filteredMcps.map((s) => s.id);
    const m = this.mcpManager;

    const result: Tool[] = [];
    if (allow.has("load_mcp") && m && filteredMcps.length > 0) {
      result.push(createLoadMcpTool(m, filteredMcps, this.logger));
    }
    if (allow.has("call_mcp_tool") && m) {
      // env 供 call_mcp_tool 读取 maxToolOutput，与内置工具共用同一上限口径；
      // filteredMcps 是权限白名单（连接管理器全局共享，必须按 Scope 过滤）
      result.push(createCallMcpTool(m, scope.env, mcps));
    }
    if (allow.has("read_mcp_resource") && m) {
      result.push(createReadMcpResourceTool(m, scope.env, mcps));
    }
    // 两条任务工具与 call_mcp_tool 同一档位：有配置（`m` 在）且这个 Scope 允许它们
    if (allow.has(GET_MCP_TASK_RESULT_TOOL) && m) {
      result.push(createGetMcpTaskResultTool(m, scope.env, mcps));
    }
    if (allow.has(CANCEL_MCP_TASK_TOOL) && m) {
      result.push(createCancelMcpTaskTool(m, mcps));
    }
    return result;
  }

  async dispose(): Promise<void> {
    await this.mcpManager?.disconnectAll();
  }
}

/**
 * 对账结论：这些 server 的连接必须断掉。
 *
 * 两类：已经不在这次发现里的（配置里删了 / 被禁用），以及定义变了的（连接不能再按旧定义用）。
 * 新增的不在结论里 —— 新增不主动连，保持懒连接。
 */
export function staleMcpConnections(
  previous: readonly McpServerConfig[],
  discovered: readonly McpServerConfig[],
): string[] {
  const nextById = new Map(discovered.map((config) => [config.id, config]));
  const stale: string[] = [];
  for (const before of previous) {
    const after = nextById.get(before.id);
    if (!after || definitionFingerprint(before) !== definitionFingerprint(after)) {
      stale.push(before.id);
    }
  }
  return stale;
}

/**
 * 「定义」的指纹：哪些字段变了就算连接不能再用。
 *
 * 算进来的是**连接事实**：transport 以及各 transport 的落地参数（command / args / env /
 * url / headers / oauth）。不算 `description` —— 它只影响 `load_mcp` 给人看的那段文字，
 * 与怎么连无关，改它不该把一条好连接断掉（新描述下一次实例化就带上了）。
 * `id` 也不进指纹：按 id 配对的，同一 id 才比。
 *
 * 键顺序用排序后的规范化 JSON 抹平（同一份配置不同写法不该被当成「变了」）。
 */
function definitionFingerprint(config: McpServerConfig): string {
  const { id: _id, description: _description, ...definition } = config;
  return canonicalJson(definition);
}

/** 递归按键名排序的 JSON：对象字段顺序不算差异 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
