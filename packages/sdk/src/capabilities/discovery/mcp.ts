import { existsSync, readFileSync } from "node:fs";
import type { DisclosureItem } from "../disclosure.js";

/**
 * 从 mcp.json 文件列表中发现所有 MCP server 名称。
 * 按优先级从高到低传入路径列表，同名 server 靠前的文件优先（先到先得）。
 */
export function discoverMcpServers(paths: string[]): DisclosureItem[] {
  const seen = new Set<string>();
  const items: DisclosureItem[] = [];

  for (const path of paths) {
    if (!existsSync(path)) continue;

    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw);
      const servers = config.servers ?? {};

      for (const name of Object.keys(servers)) {
        if (!seen.has(name)) {
          seen.add(name);
          items.push({ id: name, description: "" });
        }
      }
    } catch {
      // 跳过解析失败
    }
  }

  return items;
}
