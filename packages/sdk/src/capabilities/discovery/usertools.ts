import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Tool } from "@ai-zen/agents-core";

/**
 * 扫描多个 tools/ 目录，发现所有 .js 文件，动态 require 为 Tool 实例。
 * 按优先级顺序传入路径列表，同名工具靠前的路径优先（先到先得）。
 * 按文件名排序以保证确定性。
 */
export function discoverUserTools(paths: string[]): Tool[] {
  const seen = new Set<string>();
  const tools: Tool[] = [];

  for (const dir of paths) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => f.slice(0, -3))
        .sort();

      for (const name of files) {
        if (!seen.has(name)) {
          seen.add(name);
          try {
            // TODO: 需要安全的模块加载机制，当前仅声明类型
            // const toolModule = require(join(dir, name + ".js"));
            // tools.push(toolModule.default ?? toolModule);
          } catch {
            // 跳过加载失败的文件
          }
        }
      }
    } catch {
      continue;
    }
  }

  return tools;
}
