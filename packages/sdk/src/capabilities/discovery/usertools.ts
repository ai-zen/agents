import { readdirSync, existsSync } from "node:fs";

/**
 * 扫描多个 tools/ 目录，发现所有 .js 文件，返回去扩展名的工具名称。
 * 按优先级顺序传入路径列表，同名工具靠前的路径优先（先到先得）。
 * 按文件名排序以保证确定性。
 */
export function discoverUserTools(paths: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

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
          names.push(name);
        }
      }
    } catch {
      continue;
    }
  }

  return names;
}
