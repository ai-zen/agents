import { existsSync, readFileSync } from "node:fs";
import type { McpServerConfig } from "../../types/index.js";

/**
 * 从 mcp.json 文件列表中发现所有 MCP server 配置。
 * 按优先级从高到低传入路径列表，同名 server 靠前的文件优先（先到先得）。
 * 返回完整配置，不再丢失信息。
 */
export function discoverMcpServers(paths: string[]): McpServerConfig[] {
  const seen = new Set<string>();
  const items: McpServerConfig[] = [];

  for (const path of paths) {
    if (!existsSync(path)) continue;

    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw);
      const servers = config.servers ?? {};

      for (const id of Object.keys(servers)) {
        if (!seen.has(id)) {
          seen.add(id);
          items.push({ id, ...servers[id] });
        }
      }
    } catch {
      // 跳过解析失败
    }
  }

  return items;
}
