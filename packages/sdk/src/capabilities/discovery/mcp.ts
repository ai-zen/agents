import { existsSync, readFileSync } from "node:fs";
import type { McpServerConfig } from "../../types/index.js";

/**
 * 归一化原始 MCP server 配置为内部 McpServerConfig。
 * 处理业界标准中的字段别名差异。
 */
function normalizeConfig(id: string, raw: Record<string, unknown>): McpServerConfig | null {
  // disabled 处理
  if (raw.disabled === true) return null;

  // transport 类型：优先取 type，兼容 transport/transportType
  const transportRaw = (raw.type ?? raw.transport ?? raw.transportType ?? "") as string;
  const transport = normalizeTransport(transportRaw, raw);
  if (!transport) return null;

  const config: McpServerConfig = {
    id,
    transport,
    command: raw.command as string | undefined,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
    url: raw.url as string | undefined,
    headers: raw.headers as Record<string, string> | undefined,
  };

  return config;
}

/**
 * 归一化 transport 取值。
 * 不填时自动推断：有 command→stdio，有 url→http。
 */
function normalizeTransport(type: string, raw: Record<string, unknown>): McpServerConfig["transport"] | null {
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
 * 按优先级从高到低传入路径列表，同名 server 靠前的文件优先（先到先得）。
 */
export function discoverMcpServers(paths: string[]): McpServerConfig[] {
  const seen = new Set<string>();
  const items: McpServerConfig[] = [];

  for (const path of paths) {
    if (!existsSync(path)) continue;

    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw);

      // 业界标准使用 mcpServers 顶层字段
      const servers: Record<string, unknown> = config.mcpServers ?? {};

      for (const id of Object.keys(servers)) {
        if (seen.has(id)) continue;

        const rawServer = servers[id] as Record<string, unknown> | undefined;
        if (!rawServer || typeof rawServer !== "object") continue;

        const normalized = normalizeConfig(id, rawServer);
        if (!normalized) continue;

        seen.add(id);
        items.push(normalized);
      }
    } catch (err) {
      console.warn(`[sdk] 解析 MCP 配置失败: ${path}`, err);
    }
  }

  return items;
}
