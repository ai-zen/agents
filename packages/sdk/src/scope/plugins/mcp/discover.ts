import { promises as fs } from "node:fs";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";
import type { McpServerDefinition } from "../../../types/index.js";

/**
 * 归一化原始 MCP server 配置为内部 McpServerDefinition。
 * 处理业界标准中的字段别名差异。
 */
function normalizeConfig(id: string, raw: Record<string, unknown>): McpServerDefinition | null {
  // disabled 处理
  if (raw.disabled === true) return null;

  // transport 类型：优先取 type，兼容 transport/transportType
  const transportRaw = (raw.type ?? raw.transport ?? raw.transportType ?? "") as string;
  const transport = normalizeTransport(transportRaw, raw);
  if (!transport) return null;

  const config: McpServerDefinition = {
    id,
    transport,
    description: raw.description as string | undefined,
    command: raw.command as string | undefined,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
    url: raw.url as string | undefined,
    headers: raw.headers as Record<string, string> | undefined,
    // oauth 是对象就原样带上（形状见 McpServerDefinition["oauth"]），否则视为没配
    oauth:
      typeof raw.oauth === "object" && raw.oauth !== null && !Array.isArray(raw.oauth)
        ? (raw.oauth as McpServerDefinition["oauth"])
        : undefined,
  };

  return config;
}

/**
 * 归一化 transport 取值。
 * 不填时自动推断：有 command→stdio，有 url→http。
 */
function normalizeTransport(
  type: string,
  raw: Record<string, unknown>,
): McpServerDefinition["transport"] | null {
  if (type === "stdio") return "stdio";
  if (type === "http") return "http";
  if (type === "sse") return "sse";

  // 自动推断
  if (raw.command) return "stdio";
  if (raw.url) return "http";

  return null;
}

/**
 * 从 mcp.json 文件列表中发现所有 MCP server 配置。
 *
 * 遵循业界标准格式：
 * ```json
 * { "mcpServers": { "server-id": { "type": "stdio", "command": "npx", ... } } }
 * ```
 *
 * 按优先级从高到低传入路径列表，同名 server 靠前的文件优先（先到先得）。靠前的文件里
 * **任何一条**占住这个名字的 InboxEntry 都算数，包括 `disabled: true` 的那一条：近层停用即取消远层。
 */
/** 发现 MCP 配置时的选项 */
export interface DiscoverMcpServersOptions {
  /** 日志口（可选）：某个配置文件 parse 不了时报一句；不注入就不记（库缺省沉默） */
  logger?: LogSink;
}

export async function discoverMcpServers(
  paths: string[],
  options: DiscoverMcpServersOptions = {},
): Promise<McpServerDefinition[]> {
  const logger = options.logger ?? SILENT_LOG;
  const seen = new Set<string>();
  const items: McpServerDefinition[] = [];

  for (const path of paths) {
    try {
      await fs.access(path);
    } catch {
      continue;
    }

    try {
      const raw = await fs.readFile(path, "utf-8");
      const config = JSON.parse(raw);

      // 业界标准使用 mcpServers 顶层字段
      const servers: Record<string, unknown> = config.mcpServers ?? {};

      for (const id of Object.keys(servers)) {
        if (seen.has(id)) continue;

        const rawServer = servers[id] as Record<string, unknown> | undefined;
        if (!rawServer || typeof rawServer !== "object") continue;

        // 名字先认领，再决定收不收：写成 `disabled: true` 的那一条也是这一层对这个名字的
        // 发言，远处同名的定义不该越过它生效。放到收进结果之后再认领，停用 InboxEntry 就不占名字
        // —— 人写「别用」，合并出来的却是一条能用的。
        seen.add(id);
        const normalized = normalizeConfig(id, rawServer);
        if (!normalized) continue;

        items.push(normalized);
      }
    } catch (err: unknown) {
      logger.warn(`[sdk] Failed to parse MCP config: ${path} — ${(err as Error)?.message ?? err}`);
    }
  }

  return items;
}
