import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Tool, CallbackTool } from "@ai-zen/agents-core";

/**
 * 扫描多个 tools/ 目录，发现所有 .js 文件，动态加载为 Tool 实例。
 * 按优先级从高到低传入路径列表，同名工具靠前的路径优先（先到先得）。
 * 按文件名排序以保证确定性。
 *
 * 加载方式：
 * 1. 使用 vm.compileFunction 创建安全的执行上下文
 * 2. 工具文件应通过 module.exports 或 exports.default 导出 Tool 实例
 * 3. 支持直接导出 { function, exec } 格式的对象（自动适配为 Tool）
 * 4. 支持导出 CallbackTool 兼容的 { function, callback } 格式
 */
export function discoverUserTools(paths: string[], options?: { silent?: boolean }): Tool[] {
  const silent = options?.silent ?? false;
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
            const tool = loadToolFile(join(dir, name + ".js"), silent);
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

/**
 * 从 .js 文件加载 Tool 实例。
 *
 * 使用 vm.compileFunction 创建沙箱执行环境，避免污染全局作用域。
 * 注入有限的全局 API（console, setTimeout 等），不暴露 process/require。
 */
function loadToolFile(filepath: string, silent?: boolean): Tool | null {
  const code = readFileSync(filepath, "utf-8");

  // 构造沙箱上下文
  const sandbox: Record<string, any> = {
    // 有限全局 API
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Buffer: Buffer,
    URL: URL,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    // 导出的结果存放处
    module: { exports: {} },
    exports: {},
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const script = new vm.Script(code, { filename: filepath });

  try {
    script.runInContext(context, { timeout: 5000 });

    // 获取导出结果
    const exported = sandbox.module.exports ?? sandbox.exports;

    // 空导出
    if (!exported || (typeof exported === "object" && Object.keys(exported).length === 0)) {
      return null;
    }

    // 适配不同导出格式
    return normalizeToolExport(exported, filepath, silent);
  } catch (err: any) {
    if (!silent) {
      console.error(`[usertools] 加载工具文件失败: ${filepath} — ${err?.message ?? err}`);
    }
    return null;
  }
}

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

  // 情况 3：{ function, exec } 格式 → 适配为 Tool 子类
  if (target && typeof target === "object" && target.function && typeof target.exec === "function") {
    return createToolFromObject(target, filepath);
  }

  // 情况 4：{ function, callback } 格式 → 适配为 CallbackTool
  if (target && typeof target === "object" && target.function && typeof target.callback === "function") {
    return new CallbackTool({
      function: target.function,
      callback: target.callback,
    });
  }

  if (!silent) {
    console.error(`[usertools] 无法识别的工具格式: ${filepath}`);
  }
  return null;
}

/**
 * 将 { function, exec } 对象适配为 Tool 子类实例。
 */
function createToolFromObject(obj: { function: any; exec: (ctx: any) => any }, filepath: string): Tool {
  return new (class extends Tool {
    constructor() {
      super({ function: obj.function });
    }

    async exec(ctx: any): Promise<string> {
      const result = await obj.exec.call(ctx, ctx.parsed_args);
      if (typeof result !== "string") {
        return JSON.stringify(result) ?? "";
      }
      return result;
    }
  })();
}
