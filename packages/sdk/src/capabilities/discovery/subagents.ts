import type { AgentDefinition } from "../../types/index.js";
import { Tool } from "@ai-zen/agents-core";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * 扫描多个目录中发现的所有 SubAgent 完整定义。
 * 按优先级从高到低传入路径列表，同名 function.name 靠前的路径优先（先到先得）。
 * 跳过无 function 的普通 Agent 和解析失败的文件。
 */
export async function discoverSubAgents(paths: string[]): Promise<AgentDefinition[]> {
  const seen = new Set<string>();
  const agents: AgentDefinition[] = [];

  for (const dir of paths) {
    try {
      await fs.access(dir);
    } catch {
      continue;
    }

    let files: string[];
    try {
      const allFiles = await fs.readdir(dir);
      files = allFiles.filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const raw = await fs.readFile(join(dir, file), "utf-8");
        const def = JSON.parse(raw) as AgentDefinition;
        if (def.function) {
          const funcName = def.function.name;
          if (!seen.has(funcName)) {
            seen.add(funcName);
            agents.push(def);
          }
        }
      } catch {
        // 跳过解析失败的文件
      }
    }
  }

  return agents;
}
