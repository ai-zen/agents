import type { AgentDefinition } from "../../../types/index.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";

/** 发现 SubAgent 时的选项 */
export interface DiscoverSubAgentsOptions {
  /** 日志口（可选）：有文件读不出来、被跳过时报一句；不注入就不记（库缺省沉默） */
  logger?: LogSink;
}

/**
 * 扫描多个目录中发现的所有 SubAgent 完整定义。
 * 按优先级从高到低传入路径列表，同名 function.name 靠前的路径优先（先到先得）。
 * 跳过无 function 的普通 Agent 和解析失败的文件。
 */
export async function discoverSubAgents(
  paths: string[],
  options: DiscoverSubAgentsOptions = {},
): Promise<AgentDefinition[]> {
  const logger = options.logger ?? SILENT_LOG;
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
      } catch (error) {
        // 跳过坏文件是对的（一个坏文件不该让整张 SubAgent 列表读不出来），但要留一行：
        // skills / mcp / usertools 三条发现路径都报了，只有这里一声不吹
        logger.warn(
          `[subagents] ${join(dir, file)} 读不出来或不是合法定义，跳过：${String(error)}`,
        );
      }
    }
  }

  return agents;
}
