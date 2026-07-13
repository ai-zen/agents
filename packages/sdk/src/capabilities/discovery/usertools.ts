import { readdirSync, existsSync } from "node:fs";

/**
 * 扫描 tools/ 目录，发现所有 .js 文件，返回去扩展名的工具名称。
 * 按文件名排序以保证确定性。
 */
export function discoverUserTools(dir: string): string[] {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.slice(0, -3)) // 去掉 .js
      .sort();
  } catch {
    return [];
  }
}
