/**
 * 工作区文件索引 —— 给客户端 `@` 补全提供一份「候选路径清单」，带 TTL 缓存。
 *
 * ## 为什么它在这里，而不是在客户端
 *
 * 补全扫的必须是**会话真正跑在哪个目录**：那是服务端的工作区（Agent 的 cwd、工具的相对
 * 路径基准都在那边）。客户端扫自己进程的当前工作目录（`cwd`），在「TUI 连远端服务端」这种
 * 形态下会列出**另一台机器**的文件 —— 用户选中一个路径送过去，服务端根本没有那个文件。
 * 所以清单由服务端产出，客户端只负责过滤与插入。
 *
 * ## 为什么 git 优先、`fs.glob` 兜底
 *
 * 沿用 CLI 侧（`cli/src/tui/file-index.ts`）实测过的结论，本文件只是换了个宿主：
 * `git ls-files -co --exclude-standard` 一次同时拿到**已跟踪 + 未跟踪**，且**尊重
 * .gitignore**；`fs.promises.glob` 更快且不依赖外部进程，但它不认 .gitignore、也不返回
 * 隐藏文件（实测 `.gitignore`、`.ai-zen/` 全丢），所以只当「不在 git 仓库里」时的兜底。
 * 两者都不需要新增依赖：`fs.glob` 是 Node 22+ 内置的。
 *
 * ## 为什么缓存挂在实例上、按根目录分键
 *
 * 一次 `@` 补全里每敲一个键都要重新过滤一遍，不能每键都扫盘（15s TTL）。缓存**不能是
 * 模块级全局**（本包纪律：进程里可能同时服务多个工作区，模块级缓存会串味，`vitest` 的
 * `isolate` 也正好会照出这种藏起来的状态），所以它是这个类的一个字段；键是根目录本身 ——
 * 根目录每次都从调用方来，本文件不读任何进程级全局。
 *
 * 每个工作区各占一份清单（`MAX_ENTRIES` 封顶），工作区数量本身就是小的，不做淘汰。
 *
 * ## 上限与超时
 *
 * 大仓 / `$HOME` 下扫描可能上万条：`MAX_ENTRIES` 封顶、`SCAN_TIMEOUT_MS` 到点就用手上
 * 已有的部分 —— 补全失败远好过让界面卡住。
 */

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFileEntry } from "../../protocol/sessions.js";

/** 索引有效期：过期后下一次 `@` 重新扫 */
export const INDEX_TTL_MS = 15_000;
/** 扫描超时：到点就用手上已有的部分（git 子进程超时即失败 → 落回 `fs.glob`） */
export const SCAN_TIMEOUT_MS = 5_000;
/** 索引条数上限 */
export const MAX_ENTRIES = 20_000;
/**
 * `fs.glob` 兜底时的排除项。
 *
 * `node_modules` / `.git` 不是「代码」；`dist` 是本仓的构建产物（已在 .gitignore 里，
 * 走 git 时天然被排除，兜底路径要自己排除）。
 */
export const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

/**
 * 可注入的依赖：扫描是 IO，测试不该起子进程、也不该真的碰磁盘。
 *
 * 缺省全是真实实现（下面几个函数）；注入方只管替换自己关心的那几个。
 */
export interface FileIndexDeps {
  /** git 清单（路径相对根目录）。返回 `null` 表示 git 不可用（不是仓库 / 没装 git） */
  runGit?: (root: string) => Promise<string[] | null>;
  /** `fs.glob` 兜底（根目录不是 git 仓库时用） */
  globFiles?: (root: string) => Promise<WorkspaceFileEntry[]>;
  /** 时钟（TTL 判定用） */
  now?: () => number;
  /** 索引有效期 */
  ttlMs?: number;
  /** 条数上限 */
  maxEntries?: number;
}

interface CacheEntry {
  entries: WorkspaceFileEntry[];
  at: number;
}

/**
 * git 的文件清单 → 「文件 + 祖先目录」条目。
 *
 * ## 为什么必须补出目录条目
 *
 * git 只列文件，但补全要能「钻目录」：用户选中一个目录行（`@src/tui/`）之后，菜单得
 * 继续列它下面的内容。客户端能不能渲染出那一行、以及选中后补不补末尾的 `/`，**只**看
 * 条目上的 `dir`（客户端 `PathEntry` / `mentionInsertText` 就这么判）。服务端不回目录
 * 条目，客户端拿不到目录行 —— 远程模式下「钻目录」这个能力直接消失，这不是清单瘦身，
 * 是功能退化。所以这里与客户端 `cli/src/tui/file-index.ts` 的 `fromGitList` 逐字对齐：
 * 从每个文件的路径反推所有祖先目录（`lastIndexOf("/")` 循环）、`Set` 去重、目录排在
 * 文件之前（同一屏里更好读）。
 *
 * ## 计数口径
 *
 * 上限按「文件 + 目录」一起数（`files.length + dirs.size >= maxEntries` 就停）：两者都
 * 是要发给客户端的条目，只数文件会让实际条数翻好几倍 —— 深层路径的每一级前缀都是一个
 * 目录。
 */
export function fromGitList(names: readonly string[], maxEntries: number = MAX_ENTRIES): WorkspaceFileEntry[] {
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const raw of names) {
    // git 在 Windows 上可能给反斜杠（core.autocrlf 场景），统一成 `/`：候选与插入都用 `/`
    const file = raw.trim().replace(/\\/g, "/");
    if (!file) continue;
    files.push(file);
    // `idx > 0` 而不是 `>= 0`：`idx === 0` 意味着前缀是空串（`/a/b` 这种），造出来是废条目
    let idx = file.lastIndexOf("/");
    while (idx > 0) {
      dirs.add(file.slice(0, idx));
      idx = file.lastIndexOf("/", idx - 1);
    }
    if (files.length + dirs.size >= maxEntries) break;
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const dir of dirs) entries.push({ path: dir, dir: true });
  for (const file of files) entries.push({ path: file, dir: false });
  // 反推目录可能让总数越过上限（一个文件的 N 级前缀一次加 N 条），这里再裁一刀
  return entries.slice(0, maxEntries);
}

/** `git ls-files -co --exclude-standard`（路径相对根目录）；失败返回 `null` */
function gitList(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-co", "--exclude-standard"],
      { cwd: root, timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.split("\n").filter(Boolean)),
    );
  });
}

/**
 * 非 git 目录的兜底：`fs.glob` 递归 + 排除表。
 *
 * 这里本来就拿得到「是不是目录」（`withFileTypes`），于是与 git 那条路一样交出
 * 「文件 + 目录」混合清单 —— 两条路的条目形状必须一致，客户端不该按来源分叉。
 * 超时与条数上限都在循环里判：`fs.glob` 没有超时参数，边扫边看时间才不会一口气扫穿。
 * 上限用的是模块常量 `MAX_ENTRIES`（缺省实现看不到注入值）—— 注入更小的 `maxEntries`
 * 时由 `list()` 再截一刀。
 */
async function globList(root: string): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];
  const startedAt = Date.now();
  for await (const dirent of fsp.glob("**/*", {
    cwd: root,
    exclude: DEFAULT_EXCLUDES,
    withFileTypes: true,
  })) {
    const rel = path.relative(root, path.join(dirent.parentPath, dirent.name)).replace(/\\/g, "/");
    if (!rel) continue;
    entries.push({ path: rel, dir: dirent.isDirectory() });
    if (entries.length >= MAX_ENTRIES) break;
    if (Date.now() - startedAt > SCAN_TIMEOUT_MS) break;
  }
  return entries;
}

export class FileIndex {
  private readonly runGit: (root: string) => Promise<string[] | null>;
  private readonly globFiles: (root: string) => Promise<WorkspaceFileEntry[]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  /** 根目录 → 清单。键就是工作区路径，绝不来自进程级全局 */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: FileIndexDeps = {}) {
    this.runGit = deps.runGit ?? gitList;
    this.globFiles = deps.globFiles ?? globList;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? INDEX_TTL_MS;
    this.maxEntries = deps.maxEntries ?? MAX_ENTRIES;
  }

  /**
   * 取某个工作区的候选路径（相对根目录、`/` 分隔、不带 `./` 前缀）。
   *
   * 任何异常都收敛成空数组：补全挂了不该影响用户发消息（这一条是从 CLI 沿用下来的
   * 取舍 —— 它是「降级策略」，不是兜底校验）。
   */
  async list(root: string): Promise<WorkspaceFileEntry[]> {
    const cached = this.cache.get(root);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.entries;

    let entries: WorkspaceFileEntry[] = [];
    try {
      const files = await this.runGit(root);
      entries = files
        ? fromGitList(files, this.maxEntries)
        : (await this.globFiles(root)).slice(0, this.maxEntries);
    } catch {
      entries = [];
    }
    this.cache.set(root, { entries, at: this.now() });
    return entries;
  }
}
