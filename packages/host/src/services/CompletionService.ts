/**
 * `@` 补全的数据来源：一个项目的文件清单。
 *
 * 为什么在宿主：远程前端看不到目录（PRD §3 尺子 ①），`@` 菜单列的是磁盘上的真实文件。
 *
 * 口径：
 *   - **按需扫描**：第一次问才扫，扫完缓存一下；
 *   - **git 仓库优先 `git ls-files`**：只列 git 认的文件（含未跟踪但没被 ignore 的），天然排除了
 *     `node_modules`、构建产物这些不该出现在补全里的东西；
 *   - **非 git 用遍历**：跳过 `node_modules` / `.git` / `dist` 三个目录；
 *   - **20000 条上限**：到了上限就停，并如实说「被截断了」；
 *   - **5s 超时**：超时返回已经读到的那些（可能不完整），并说明它不完整；
 *   - **15s 缓存**：15 秒内重复问不重新扫；
 *   - **未就绪要说话**：还在扫就回 `scanning`，扫不出来回 `unavailable` + 原因。
 *     假装空目录比慢更糟 —— 界面会以为这个项目里没有文件。
 *
 * 计时与「跑 git」都是注入点：用例用假时钟与假执行器验证超时 / 缓存 / 上限，
 * 不需要真的等 5 秒，也不需要真的有 git。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import { HostError } from "../wire/errors.js";
import type {
  CompletionFilesParams,
  CompletionFilesResult,
  FileEntryView,
  ProblemFact,
} from "../wire/index.js";
import type { WorkspaceCwdLookup } from "./DiscoveryService.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 实现事实（几个数字）
// ---------------------------------------------------------------------------

/** 清单条数上限（20000 条） */
export const DEFAULT_MAX_ENTRIES = 20_000;
/** 扫描超时（5s） */
export const DEFAULT_SCAN_TIMEOUT_MS = 5_000;
/** 缓存有效期（15s） */
export const DEFAULT_CACHE_TTL_MS = 15_000;
/** 一次补全默认回多少条 */
export const DEFAULT_LIMIT = 50;
/** 一次补全最多回多少条 */
export const MAX_LIMIT = 500;

/** 遍历时要跳过的目录名（`node_modules/.git/dist`） */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);

/** `git ls-files` 的超时上限（比扫描预算略小，留出解析与遍历的时间） */
const GIT_TIMEOUT_MARGIN_MS = 500;

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

/** 计时入口（与 `runtime/ScopeRegistry` 的 `Clock` 同形状：`setTimeout` 返回取消函数） */
export interface CompletionClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): () => void;
}

/** 真实时钟 */
export const systemCompletionClock: CompletionClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** 一次 `git ls-files` 的结果 */
export interface GitListing {
  ok: boolean;
  /** NUL 分隔输出的那些路径（已经切成一条条） */
  files: string[];
  /** 失败原因（`ok === false` 时给） */
  reason?: string;
}

/** 跑 git 的方式（测试注入假的，生产走高定制的 `defaultGitLister`） */
export type GitLister = (cwd: string, timeoutMs: number) => Promise<GitListing>;

/** 补全服务的依赖 */
export interface CompletionServiceOptions {
  /** 按 workspaceId 取 cwd（项目不存在时回 `undefined`） */
  findWorkspace?: WorkspaceCwdLookup;
  /** 跑 git 的方式；缺省用子进程跑 `git ls-files` */
  runGit?: GitLister;
  /** 计时入口；缺省真实时钟 */
  clock?: CompletionClock;
  maxEntries?: number;
  scanTimeoutMs?: number;
  cacheTtlMs?: number;
}

/** 一个项目的扫描状态 */
interface ScanState {
  phase: "scanning" | "ready" | "unavailable";
  /** 相对 cwd 的文件路径（扫描过程中逐步填充，超时就用已经读到的这些） */
  paths: string[];
  truncated: boolean;
  scannedAt: number | null;
  problem: ProblemFact | null;
  /** 缓存到期时刻（毫秒）；`null` 表示还没有可用的结果 */
  expiresAt: number | null;
  /** 正在跑的那次扫描（并发请求据此判断「还在扫」） */
  pending: Promise<void> | null;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

function text(messageKey: MessageKey, params: Record<string, unknown> = {}): ProblemFact {
  return {
    code: messageKey,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class CompletionService {
  private readonly findWorkspace?: WorkspaceCwdLookup;
  private readonly runGit: GitLister;
  private readonly clock: CompletionClock;
  private readonly maxEntries: number;
  private readonly scanTimeoutMs: number;
  private readonly cacheTtlMs: number;
  /** workspaceId → 扫描状态（cwd 创建即定死，PRD D9，所以按项目缓存是安全的） */
  private readonly states = new Map<string, ScanState>();

  constructor(options: CompletionServiceOptions = {}) {
    this.findWorkspace = options.findWorkspace;
    this.runGit = options.runGit ?? defaultGitLister;
    this.clock = options.clock ?? systemCompletionClock;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * `completion.files`。
   *
   * 三条出口，全部带 `state`：
   *   - 有现成清单 → `ready`（可能带「不完整 / 被截断」的说明）；
   *   - 正在扫 → `scanning`（客户端继续打字时会再来问一次）；
   *   - 扫不出来 → `unavailable` + 原因。
   */
  async files(params: CompletionFilesParams): Promise<CompletionFilesResult> {
    const workspaceId = requireWorkspaceId(params.workspaceId);
    const cwd = await this.resolveCwd(workspaceId);
    const state = this.stateOf(workspaceId);

    const fresh = state.expiresAt !== null && state.expiresAt > this.clock.now();
    if (fresh) return this.respond(state, params);

    if (state.pending === null) {
      // 第一次问：起一次后台扫描，先如实说「还在扫」（D7：未就绪要说话）
      state.pending = this.scan(cwd, state).finally(() => {
        state.pending = null;
      });
    }
    return {
      state: "scanning",
      entries: [],
      truncated: false,
      scannedAt: null,
      problem: text("completion.scanning"),
    };
  }

  // -------------------------------------------------------------------------
  // 扫描
  // -------------------------------------------------------------------------

  /**
   * 扫一次并写状态。
   *
   * 超时不是「失败」：已经读到的那些仍然是真话，所以照常给出去，只是把
   * 「不完整」这件事写在 `problem` 里（D7：未就绪要说话，而不是假装齐了）。
   */
  private async scan(cwd: string, state: ScanState): Promise<void> {
    state.phase = "scanning";
    state.paths = [];
    state.truncated = false;
    state.problem = null;
    state.scannedAt = null;
    state.expiresAt = null;

    const bucket: string[] = [];
    const flag = { truncated: false };
    const work = this.collect(cwd, bucket, flag);
    const outcome = await this.withTimeout(work);

    if (outcome === "timeout") {
      state.paths = bucket;
      state.truncated = flag.truncated || bucket.length >= this.maxEntries;
      state.scannedAt = this.clock.now();
      state.problem = text("completion.timedOut", { seconds: this.scanTimeoutMs / 1000 });
      // 读到了一点就还能用（哪怕不完整）；一条都没读到才是「拿不到」
      state.phase = bucket.length > 0 ? "ready" : "unavailable";
      if (state.phase === "unavailable") {
        state.problem = text("completion.unavailable", {
          reason: render(DEFAULT_LANGUAGE, "completion.timedOut", {
            seconds: this.scanTimeoutMs / 1000,
          }),
        });
      }
      state.expiresAt = state.scannedAt + this.cacheTtlMs;
      return;
    }

    if (outcome.failure !== null) {
      state.phase = "unavailable";
      state.paths = [];
      state.truncated = false;
      state.scannedAt = this.clock.now();
      state.problem = outcome.failure;
      state.expiresAt = state.scannedAt + this.cacheTtlMs;
      return;
    }

    state.phase = "ready";
    state.paths = bucket;
    state.truncated = flag.truncated;
    state.scannedAt = this.clock.now();
    state.problem = flag.truncated
      ? text("completion.truncated", { limit: this.maxEntries })
      : null;
    state.expiresAt = state.scannedAt + this.cacheTtlMs;
  }

  /**
   * 收集文件路径：git 仓库走 `git ls-files`，否则自己遍历。
   *
   * 失败时把「为什么拿不到」作为 `failure` 回出去（`null` 表示正常拿到）。
   */
  private async collect(
    cwd: string,
    bucket: string[],
    flag: { truncated: boolean },
  ): Promise<{ failure: ProblemFact | null }> {
    let info;
    try {
      info = await fs.stat(cwd);
    } catch {
      return {
        failure: text("completion.unavailable", {
          reason: render(DEFAULT_LANGUAGE, "completion.noFolder"),
        }),
      };
    }
    if (!info.isDirectory()) {
      return {
        failure: text("completion.unavailable", {
          reason: render(DEFAULT_LANGUAGE, "completion.noFolder"),
        }),
      };
    }

    if (await this.isGitRepo(cwd)) {
      const listing = await this.runGit(cwd, this.gitTimeout());
      if (listing.ok) {
        for (const file of listing.files) {
          if (bucket.length >= this.maxEntries) {
            flag.truncated = true;
            break;
          }
          const normalized = normalizePath(file);
          if (normalized !== "") bucket.push(normalized);
        }
        return { failure: null };
      }
      // git 跑不动（不在 PATH、仓库坏掉）就退回遍历：拿得到清单比走哪条路重要
    }

    try {
      await this.walk(cwd, "", bucket, flag, 0);
    } catch (error) {
      return {
        failure: text("completion.unavailable", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    return { failure: null };
  }

  /** 遍历目录（跳过 {@link EXCLUDED_DIRS}；符号链接不跟，避免环） */
  private async walk(
    root: string,
    relative: string,
    bucket: string[],
    flag: { truncated: boolean },
    depth: number,
  ): Promise<void> {
    if (bucket.length >= this.maxEntries) {
      flag.truncated = true;
      return;
    }
    if (depth > 32) return;

    const dir = relative === "" ? root : join(root, relative);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (bucket.length >= this.maxEntries) {
        flag.truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await this.walk(root, childRelative, bucket, flag, depth + 1);
        continue;
      }
      if (entry.isFile()) bucket.push(childRelative);
    }
  }

  /** `<cwd>/.git` 在（目录或 worktree 的 `.git` 文件）就当它是 git 仓库 */
  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await fs.stat(join(cwd, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /** 给 git 的超时：比整次扫描的预算略小 */
  private gitTimeout(): number {
    return Math.max(this.scanTimeoutMs - GIT_TIMEOUT_MARGIN_MS, 1);
  }

  /** 跑 `work`，到点就放弃等它（返回 `"timeout"`） */
  private async withTimeout<T>(work: Promise<T>): Promise<T | "timeout"> {
    // 取一个可变盒子：赋值发生在计时器回调里，TS 看不到那次赋值
    const timer: { cancel: (() => void) | null } = { cancel: null };
    const timeout = new Promise<"timeout">((resolve) => {
      timer.cancel = this.clock.setTimeout(() => resolve("timeout"), this.scanTimeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      timer.cancel?.();
    }
  }

  // -------------------------------------------------------------------------
  // 出口
  // -------------------------------------------------------------------------

  /** 状态 → 出参（只切出这次要的那一页） */
  private respond(state: ScanState, params: CompletionFilesParams): CompletionFilesResult {
    if (state.phase !== "ready") {
      return {
        state: state.phase,
        entries: [],
        truncated: false,
        scannedAt: state.scannedAt === null ? null : new Date(state.scannedAt).toISOString(),
        problem: state.problem,
      };
    }
    return {
      state: "ready",
      entries: selectEntries(state.paths, params.prefix ?? "", clampLimit(params.limit)),
      truncated: state.truncated,
      scannedAt: state.scannedAt === null ? null : new Date(state.scannedAt).toISOString(),
      problem: state.problem,
    };
  }

  private stateOf(workspaceId: string): ScanState {
    const existing = this.states.get(workspaceId);
    if (existing) return existing;
    const created: ScanState = {
      phase: "scanning",
      paths: [],
      truncated: false,
      scannedAt: null,
      problem: null,
      expiresAt: null,
      pending: null,
    };
    this.states.set(workspaceId, created);
    return created;
  }

  private async resolveCwd(workspaceId: string): Promise<string> {
    const found = this.findWorkspace ? await this.findWorkspace(workspaceId) : undefined;
    if (!found) {
      throw new HostError("not_found", {
        params: { entity: "workspace" },
        detail: {
          workspaceId,
          reason: this.findWorkspace ? "workspace_not_found" : "workspace_lookup_not_configured",
        },
      });
    }
    return found.cwd;
  }
}

// ---------------------------------------------------------------------------
// 默认的 git 执行器
// ---------------------------------------------------------------------------

/** 用子进程跑 `git ls-files`；不在仓库里或者没有 git 时回 `ok: false`（调用方退回遍历） */
export const defaultGitLister: GitLister = async (cwd, timeoutMs) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return {
      ok: true,
      files: stdout.split("\u0000").filter((item) => item !== ""),
    };
  } catch (error) {
    return {
      ok: false,
      files: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 入参的 workspaceId：空串按「参数不对」处理 */
function requireWorkspaceId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    throw new HostError("invalid_params", {
      params: { field: "workspaceId" },
      detail: { field: "workspaceId", reason: "empty" },
    });
  }
  return raw;
}

/** 路径分隔符统一成 `/`，去掉开头的 `./` */
function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return unified.startsWith("./") ? unified.slice(2) : unified;
}

/** 一次回多少条：缺省 {@link DEFAULT_LIMIT}，上限 {@link MAX_LIMIT} */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const value = Math.floor(limit);
  if (value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/**
 * 把清单按已输入的前缀切成「目录 + 文件」两类条目。
 *
 * 前缀可以是路径形式（`src/co`）：目录部分当过滤基准，最后一段当「还差什么」；
 * 没有斜杠时（`@READ`）同时按路径开头与文件名开头匹配，这样根目录里的文件也找得到。
 */
export function selectEntries(paths: string[], prefix: string, limit: number): FileEntryView[] {
  const normalized = normalizePath(prefix.trim());
  // 前缀以 `/` 结尾表示「这一层全要」：目录部分就是它，剩下要匹配的那一段为空
  const underDirectory = normalized.endsWith("/");
  const trimmed = underDirectory ? normalized.slice(0, -1) : normalized;
  const slash = trimmed.lastIndexOf("/");
  const baseDir =
    slash === -1 ? (underDirectory ? `${trimmed}/` : "") : trimmed.slice(0, slash + 1);
  const partial = underDirectory
    ? ""
    : (slash === -1 ? trimmed : trimmed.slice(slash + 1)).toLowerCase();

  const dirs = new Map<string, FileEntryView>();
  const files: FileEntryView[] = [];

  for (const path of paths) {
    if (baseDir !== "" && !path.toLowerCase().startsWith(baseDir.toLowerCase())) continue;
    const relative = baseDir === "" ? path : path.slice(baseDir.length);
    if (relative === "") continue;

    const nextSlash = relative.indexOf("/");
    if (nextSlash !== -1) {
      const segment = relative.slice(0, nextSlash);
      if (!segment.toLowerCase().startsWith(partial)) continue;
      const dirPath = `${baseDir}${segment}`;
      if (!dirs.has(dirPath)) {
        dirs.set(dirPath, { path: dirPath, name: segment, kind: "directory" });
      }
      continue;
    }
    if (!relative.toLowerCase().startsWith(partial)) continue;
    files.push({ path, name: relative, kind: "file" });
  }

  const orderedDirs = [...dirs.values()].sort((left, right) => left.name.localeCompare(right.name));
  const orderedFiles = files.sort((left, right) => left.name.localeCompare(right.name));
  return [...orderedDirs, ...orderedFiles].slice(0, limit);
}
