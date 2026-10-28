import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Tool, CallbackTool } from "@ai-zen/agents-core";
import { getLogger } from "../../../shared/logger.js";

/** 单个用户工具文件的加载参数 */
export interface DiscoverUserToolsOptions {
  /** 静默：不写日志（测试 / 批量探测用） */
  silent?: boolean;
  /** 单文件 import 的超时（毫秒），默认 {@link DEFAULT_IMPORT_TIMEOUT_MS}；`0` 表示不限 */
  importTimeoutMs?: number;
}

/** 默认的单文件 import 超时：工具目录里不该有需要长过它的模块求值 */
const DEFAULT_IMPORT_TIMEOUT_MS = 5000;

// ==================================================================
// 宿主护栏
// ==================================================================
//
// `import()` 是把文件当模块**求值**，不是把文件当配置读——顶层代码因此拥有宿主进程
// 的全部权限。这里是有过真实事故的：用户把一个一次性开发脚本（无参数时
// `process.exit(2)`）放进了 tools 目录，于是**每次启动都在初始化途中被这个脚本杀掉**，
// 界面上只剩最后一帧，看着像「卡住不启动」；另有脚本在顶层直接 `writeFileSync`，
// 每次启动都在静默重写项目资产。
//
// 能挡住的：
//   · `process.exit` / `process.abort` → 换成抛异常，落进 `loadToolFile` 的 try/catch；
//   · `console.log / info / debug`     → 改指 stderr，不撕宿主的 stdout（TUI 画面）；
//   · 顶层 await 永不 settle（异步挂死）→ 超时放弃该文件。
//
// **挡不住**的（只有进程隔离能解，而那正是 MCP 的职责）：
//   · 顶层同步死循环——事件循环被占，连超时定时器都不会跑；
//   · `process.kill(process.pid)` 这类原生自杀。
//
// 所以 tools/ 的定位是**可信的本地扩展**；不可信的代码请写成 MCP 服务器。

/** 正在被 import 的文件（护栏回报错误时用它定位） */
let importingFile: string | null = null;

/** 用户文件里调 `process.exit()` / `process.abort()` 时抛这个 —— 落进 loadToolFile 的 catch */
class UserToolExitError extends Error {
  constructor(code?: number) {
    super(
      `process.exit(${code ?? "?"}) was called while evaluating a user tool file` +
        (importingFile ? `: ${importingFile}` : "") +
        " — the call was suppressed to keep the host process alive",
    );
    this.name = "UserToolExitError";
  }
}

/**
 * 工具模块的静态判据：ESM 里没有 `export` 就**不可能**导出 Tool。
 *
 * 这个预检能把「放错目录的普通脚本」挡在求值之前——没有 export 的模块本来也会被
 * `normalizeToolExport` 判成 null，区别只在于：那时它已经被求值、副作用已经发生了。
 * 实测那 4 个一次性脚本的 export 计数全为 0。
 *
 * 读不出来（权限 / 编码 / 不是普通文件）时放行：预检只为省掉明显的白跑，
 * 不该因为读不了文件就把正常工具挡住。
 */
const TOOL_MODULE_HINT = /\bexport\b/;

async function mayExportTool(filepath: string): Promise<boolean> {
  try {
    return TOOL_MODULE_HINT.test(await fs.readFile(filepath, "utf-8"));
  } catch {
    return true;
  }
}

/**
 * 装上宿主护栏，返回还原函数。
 *
 * 保存的是**当前**值而非模块加载时的值，且由调用方在 finally 里还原——
 * 不能常驻，否则宿主自己也永远退不出去。
 */
function installHostGuards(): () => void {
  const realExit = process.exit;
  const realAbort = process.abort;
  const realLog = console.log;
  const realInfo = console.info;
  const realDebug = console.debug;

  process.exit = ((code?: number) => {
    throw new UserToolExitError(code);
  }) as typeof process.exit;
  process.abort = (() => {
    throw new UserToolExitError();
  }) as typeof process.abort;
  // 用户脚本的输出一律走 stderr：stdout 属于宿主的界面（Ink 的帧），不能让扩展写
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = console.log;
  console.debug = console.log;

  return () => {
    process.exit = realExit;
    process.abort = realAbort;
    console.log = realLog;
    console.info = realInfo;
    console.debug = realDebug;
  };
}

/**
 * `import()` + 超时。
 *
 * 超时只是「不再等它」：ESM 求值**不可取消**，该模块随后仍可能被求值完并产生副作用，
 * 因此超时只记告警、不声称已终止。真正的隔离需要独立进程（即 MCP）。
 */
async function importWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  if (timeoutMs <= 0) return import(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`import timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([import(url), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 「这个文件被拒了」的出口：只走 logger，怎么展示是宿主的事 */
function reportReject(
  file: string,
  reason: string,
  opts: DiscoverUserToolsOptions,
  level: "warn" | "error" = "warn",
): void {
  if (!opts.silent) getLogger()[level](`[usertools] ${file} — ${reason}`);
}

/**
 * 扫描多个 tools/ 目录，发现所有 .js / .mjs 文件，动态加载为 Tool 实例。
 * 使用原生 dynamic import() 加载（在 "type": "module" 下 .js 也是 ESM），
 * 每次添加时间戳 querystring 防止缓存。
 *
 * 按优先级从高到低传入路径列表，同名工具靠前的路径优先（先到先得）。
 * 按文件名排序以保证确定性。
 */
export async function discoverUserTools(
  paths: string[],
  options: DiscoverUserToolsOptions = {},
): Promise<Tool[]> {
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
            const tool = await loadToolFile(join(dir, name + ext), options);
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
 *
 * 三道护栏（顺序有意义）：
 *   1. **先做静态预检**：没有 `export` 的文件根本不 import（连求值的机会都不给）；
 *   2. **再装宿主护栏**：import 期间 `process.exit` / console 输出被接管；
 *   3. **超时**：异步挂死的文件不再拖住启动。
 */
async function loadToolFile(
  filepath: string,
  opts: DiscoverUserToolsOptions,
): Promise<Tool | null> {
  if (!(await mayExportTool(filepath))) {
    reportReject(filepath, "no `export` in source — not a tool module, skipped without evaluating", opts);
    return null;
  }

  const restore = installHostGuards();
  const outerImporting = importingFile;
  importingFile = filepath;
  try {
    const url = `${pathToFileURL(filepath).href}?t=${Date.now()}`;
    const mod = (await importWithTimeout(url, opts.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS)) as {
      default?: unknown;
    };

    // import() 返回模块命名空间对象，取其 default 导出
    const exported = mod.default ?? mod;

    if (!exported || (typeof exported === "object" && Object.keys(exported).length === 0)) {
      return null;
    }

    return normalizeToolExport({ default: exported }, filepath, opts.silent);
  } catch (err: any) {
    reportReject(filepath, `failed to load — ${err?.message ?? err}`, opts, "error");
    return null;
  } finally {
    importingFile = outerImporting;
    restore();
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
    getLogger().error(`[usertools] Unrecognized tool format: ${filepath}`);
  }
  return null;
}
