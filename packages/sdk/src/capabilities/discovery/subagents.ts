import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "../../types";
import type { DisclosureItem } from "../disclosure";

/**
 * 扫描目录中发现的所有 SubAgent（有 function 字段的 AgentDefinition）。
 * 跳过无 function 的普通 Agent 和解析失败的文件。
 */
export function discoverSubAgents(dir: string): DisclosureItem[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items: DisclosureItem[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const def = JSON.parse(raw) as AgentDefinition;
      if (def.function) {
        items.push({ id: def.function.name, description: def.function.description });
      }
    } catch {
      // 跳过解析失败的文件
    }
  }

  return items;
}
