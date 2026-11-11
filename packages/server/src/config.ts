import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 路径与监听的来源（plan §1 的 `config.ts` 契约）。
 *
 * 这一层只回答两个问题：**文件放哪**、**听哪个地址**。它不建目录、不读配置文件内容、
 * 不认识业务对象 —— 目录的创建归启动流程，配置内容归 SDK 的 `ConfigManager`。
 *
 * `resolvePaths` 不从进程的工作目录推导任何东西：服务端是常驻后台进程，它的工作目录
 * 由启动方式决定（可能是个空目录、可能是用户后来删掉的目录），拿它当数据根会让「同一台机器上的
 * 数据在哪」随启动方式漂移。数据根只有一个来源：显式参数 → `AI_ZEN_DIR` → 用户目录下的 `~/.ai-zen`。
 */

/** 数据根下的五个路径（`architecture.md` §2 的目录图） */
export interface ServerPaths {
  /** 数据根（`AI_ZEN_DIR`，缺省 `~/.ai-zen`） */
  dataRoot: string;
  /** 库文件：`<dataRoot>/ai-zen.db` */
  dbFile: string;
  /** 附件目录：`<dataRoot>/assets` */
  assetsDir: string;
  /** 运行期目录：`<dataRoot>/run` */
  runDir: string;
  /** 发现文件：`<dataRoot>/run/server.json`（这台机器上谁在服务的唯一真相） */
  serverFile: string;
  /** 本地凭证交付文件：`<dataRoot>/run/token` */
  tokenFile: string;
}

/** 数据根目录名（缺省落在用户目录下） */
const DEFAULT_DIR_NAME = ".ai-zen";

/** 库文件名 */
const DB_FILE_NAME = "ai-zen.db";

/** 运行期子目录名 */
const RUN_DIR_NAME = "run";

/** 发现文件名 */
const SERVER_FILE_NAME = "server.json";

/** 本地凭证交付文件名 */
const TOKEN_FILE_NAME = "token";

/** 附件子目录名 */
const ASSETS_DIR_NAME = "assets";

/** 数据根环境变量（PRD F-J4：数据根可由它改，测试与多实例都靠它） */
export const AI_ZEN_DIR_ENV = "AI_ZEN_DIR";

/** 默认端口（PRD D25） */
export const DEFAULT_PORT = 8790;

/** 本地实例监听的地址（PRD A6：本地实例只监听回环） */
export const LOOPBACK_HOST = "127.0.0.1";

/** 对外实例监听的地址（创建者自己起、自己配凭证，PRD A6） */
export const PUBLIC_HOST = "0.0.0.0";

/**
 * 数据根：显式参数 → 环境变量 → `~/.ai-zen`。
 *
 * 空字符串按「没给」处理：`AI_ZEN_DIR=` 这种写法在脚本里很常见，让它变成「当前目录」会
 * 把数据散落到不可预期的位置。
 */
export function resolveDataRoot(aiZenDir?: string): string {
  const explicit = normalizeDir(aiZenDir);
  if (explicit) return explicit;

  const fromEnv = normalizeDir(process.env[AI_ZEN_DIR_ENV]);
  if (fromEnv) return fromEnv;

  return join(homedir(), DEFAULT_DIR_NAME);
}

/** 按数据根推出五条路径（库、附件、运行期目录、发现文件、凭证文件） */
export function resolvePaths(aiZenDir?: string): ServerPaths {
  const dataRoot = resolveDataRoot(aiZenDir);
  const runDir = join(dataRoot, RUN_DIR_NAME);
  return {
    dataRoot,
    dbFile: join(dataRoot, DB_FILE_NAME),
    assetsDir: join(dataRoot, ASSETS_DIR_NAME),
    runDir,
    serverFile: join(runDir, SERVER_FILE_NAME),
    tokenFile: join(runDir, TOKEN_FILE_NAME),
  };
}

function normalizeDir(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 监听目标：地址 + 端口 */
export interface ListenTarget {
  host: string;
  port: number;
}

/** `resolveListenTarget` 的入参 */
export interface ListenTargetInput {
  /** 启动参数给的端口（优先级最高，PRD D25） */
  port?: number;
  /** 配置文件里的端口（第二优先） */
  configPort?: number;
  /** 是不是本地实例：`true` 只监听回环，`false` 监听对外地址（PRD A6） */
  local: boolean;
}

/**
 * 决定监听哪个地址、哪个端口。
 *
 * 端口优先级：参数 > 配置文件 > 默认（PRD D25）。参数或配置里给的值不是一个可用端口
 * （非整数、越界）时当作没给 —— 一个手写错的端口号不该让进程起不来，但也要让人能看出它被跳过了，
 * 所以调用方拿到的是回落后的结果。
 */
export function resolveListenTarget(input: ListenTargetInput): ListenTarget {
  return {
    host: input.local ? LOOPBACK_HOST : PUBLIC_HOST,
    port: firstValidPort(input.port, input.configPort) ?? DEFAULT_PORT,
  };
}

function firstValidPort(...candidates: (number | undefined)[]): number | undefined {
  for (const candidate of candidates) {
    if (isValidPort(candidate)) return candidate;
  }
  return undefined;
}

/** 端口是否是 1..65535 的整数 */
export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}
