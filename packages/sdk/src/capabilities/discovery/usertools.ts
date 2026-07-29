import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Tool, CallbackTool } from "@ai-zen/agents-core";
import { getLogger } from "../../shared/logger.js";

/**
 * 扫描多个 tools/ 目录，发现所有 .js / .mjs 文件，动态加载为 Tool 实例。
 * 使用原生 dynamic import() 加载（在 "type": "module" 下 .js 也是 ESM），
 * 每次添加时间戳 querystring 防止缓存。
 *
 * 按优先级从高到低传入路径列表，同名工具靠前的路径优先（先到先得）。
 * 按文件名排序以保证确定性。
 */
export async function discoverUserTools(paths: string[], options?: { silent?: boolean }): Promise<Tool[]> {
  const silent = options?.silent ?? false;
  const seen = new Set<string>();
  const tools: Tool[] = [];

  for (const dir of paths) {
    try {
      await fs.access(dir);
    } catch {
      continue;
    }

    try {
      const allFiles = await fs.readdir(dir);
      const files = allFiles
        .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
        .map((f) => {
          const ext = f.endsWith(".mjs") ? ".mjs" : ".js";
          return { name: f.slice(0, -ext.length), ext };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const { name, ext } of files) {
        if (!seen.has(name)) {
          seen.add(name);
          try {
            const tool = await loadToolFile(join(dir, name + ext), silent);
            if (tool) {
              tools.push(tool);
            }
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

// ==================================================================
// ESM 加载（import()）
// ==================================================================

/**
 * 从 .js / .mjs 文件加载 Tool 实例。
 *
 * 使用原生 dynamic import() 加载 ESM 模块。每次调用添加时间戳 querystring
 * 防止模块缓存，确保 refresh() 能重新加载。
 */
async function loadToolFile(filepath: string, silent?: boolean): Promise<Tool | null> {
  try {
    const url = `${pathToFileURL(filepath).href}?t=${Date.now()}`;
    const mod = await import(url);

    // import() 返回模块命名空间对象，取其 default 导出
    const exported = mod.default ?? mod;

    if (!exported || (typeof exported === "object" && Object.keys(exported).length === 0)) {
      return null;
    }

    return normalizeToolExport({ default: exported }, filepath, silent);
  } catch (err: any) {
    if (!silent) {
      getLogger().error(`[usertools] 加载工具文件失败: ${filepath} — ${err?.message ?? err}`);
    }
    return null;
  }
}

// ==================================================================
// 导出格式归一化
// ==================================================================

/**
 * 统一各种导出格式为 Tool 实例。
 */
function normalizeToolExport(exported: any, filepath: string, silent?: boolean): Tool | null {
  // 情况 1：直接是 Tool 实例
  if (exported instanceof Tool) {
    return exported;
  }

  // 情况 2：默认导出（exported.default）
  const target = exported.default ?? exported;

  if (target instanceof Tool) {
    return target;
  }

  // 情况 3：{ function, exec } 格式 → 适配为 CallbackTool
  if (target && typeof target === "object" && target.function && typeof target.exec === "function") {
    return new CallbackTool({
      function: target.function,
      callback: target.exec,
    });
  }

  // 情况 4：{ function, callback } 格式 → 适配为 CallbackTool
  if (target && typeof target === "object" && target.function && typeof target.callback === "function") {
    return new CallbackTool({
      function: target.function,
      callback: target.callback,
    });
  }

  if (!silent) {
    getLogger().error(`[usertools] 无法识别的工具格式: ${filepath}`);
  }
  return null;
}
