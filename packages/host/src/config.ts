import { access, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConfigRecoveredHandler } from "@ai-zen/agents-sdk";

import { HostError } from "./wire/errors.js";

/**
 * 路径与监听的来源（plan §1 的 `config.ts` 契约）。
 *
 * 这一层只回答两个问题：**文件放哪**、**听哪个地址**。它不建目录、不读配置文件内容、
 * 不认识业务对象 —— 目录的创建归启动流程，配置内容归 SDK 的 `ConfigManager`。
 *
 * `resolvePaths` 不从进程的工作目录推导任何东西：宿主是常驻后台进程，它的工作目录
 * 由启动方式决定（可能是个空目录、可能是用户后来删掉的目录），拿它当数据根会让「同一台机器上的
 * 数据在哪」随启动方式漂移。数据根只有一个来源：显式参数 → `AI_ZEN_DIR` → 用户目录下的 `~/.ai-zen`。
 */

/** 数据根下的路径（`PLAN.md` §8 的数据根目录树） */
export interface HostPaths {
  /** 数据根（`AI_ZEN_DIR`，缺省 `~/.ai-zen`） */
  dataRoot: string;
  /** 库文件：`<dataRoot>/ai-zen.db` */
  dbFile: string;
  /** 附件目录：`<dataRoot>/assets` */
  assetsDir: string;
  /** 运行期目录：`<dataRoot>/run` */
  runDir: string;
  /** 发现文件：`<dataRoot>/run/host.json`（这台机器上谁在服务的唯一真相） */
  hostFile: string;
  /** 本地凭证交付文件：`<dataRoot>/run/token` */
  tokenFile: string;
  /** SDK 的配置文件：`<dataRoot>/config.json`（配置唯一真相，裁定 R13） */
  configFile: string;
  /** 宿主自己的设置文件：`<dataRoot>/host.json`（D25 的「配置文件」那一档，裁定 R67） */
  hostConfigFile: string;
  /** 日志目录：`<dataRoot>/logs`（PRD F-J2：界面被占用时日志另有去处） */
  logsDir: string;
}

/** 数据根目录名（缺省落在用户目录下） */
const DEFAULT_DIR_NAME = ".ai-zen";

/** 库文件名 */
const DB_FILE_NAME = "ai-zen.db";

/** 运行期子目录名 */
const RUN_DIR_NAME = "run";

/** 发现文件名 */
const HOST_FILE_NAME = "host.json";

/** 本地凭证交付文件名 */
const TOKEN_FILE_NAME = "token";

/** 附件子目录名 */
const ASSETS_DIR_NAME = "assets";

/** SDK 配置文件名（`<dataRoot>/config.json`，裁定 R13） */
const CONFIG_FILE_NAME = "config.json";

/** 宿主设置文件名（`<dataRoot>/host.json`，裁定 R67） */
const HOST_CONFIG_FILE_NAME = "host.json";

/** 日志子目录名（PRD F-J2） */
const LOGS_DIR_NAME = "logs";

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

/** 按数据根推出全部路径（库、附件、运行期目录、发现文件、凭证文件、两份配置文件、日志目录） */
export function resolvePaths(aiZenDir?: string): HostPaths {
  const dataRoot = resolveDataRoot(aiZenDir);
  const runDir = join(dataRoot, RUN_DIR_NAME);
  return {
    dataRoot,
    dbFile: join(dataRoot, DB_FILE_NAME),
    assetsDir: join(dataRoot, ASSETS_DIR_NAME),
    runDir,
    hostFile: join(runDir, HOST_FILE_NAME),
    tokenFile: join(runDir, TOKEN_FILE_NAME),
    configFile: join(dataRoot, CONFIG_FILE_NAME),
    hostConfigFile: join(dataRoot, HOST_CONFIG_FILE_NAME),
    logsDir: join(dataRoot, LOGS_DIR_NAME),
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
 * 端口优先级：参数 > 配置文件 > 默认（PRD D25）。**显式给出的值不合法就报错**（裁定 R67）：
 * 静默回落会造成「我配了 9000 却在 8790 上」这种查不出来的偏差，所以只有「完全没给」才落到
 * 下一顺位。
 *
 * 两个来源的合法范围不同：启动参数允许 `0`（让系统分配，用例与冒烟都用它），配置文件里的
 * 端口必须是真端口 —— 写 `0` 的意图只能是「每次启动换一个」，而这件事在配置文件里说不清。
 */
export function resolveListenTarget(input: ListenTargetInput): ListenTarget {
  return {
    host: input.local ? LOOPBACK_HOST : PUBLIC_HOST,
    port: resolvePort(input.port, input.configPort),
  };
}

/** 端口的三档优先级与两套取值范围（分出来是为了让调用方与用例都能单独验这一跳） */
export function resolvePort(port: number | undefined, configPort: number | undefined): number {
  if (port !== undefined) {
    if (!isPortOrAuto(port)) throw invalidPort("port", port, "launch_argument");
    return port;
  }
  if (configPort !== undefined) {
    if (!isValidPort(configPort)) throw invalidPort("configPort", configPort, "host.json");
    return configPort;
  }
  return DEFAULT_PORT;
}

/** 端口是否是 1..65535 的整数 */
export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

/** 启动参数里的端口：`0` 也认（交给系统分配），其余同 {@link isValidPort} */
export function isPortOrAuto(value: unknown): value is number {
  return value === 0 || isValidPort(value);
}

/**
 * 端口写得不对。
 *
 * 码是 `config_invalid`（PRD F-A8：配置类问题要能当场修），`detail` 说明哪个来源给的什么值，
 * 界面据此把光标放到那一栏（`host.json` 的 `port`，或启动参数）。
 */
function invalidPort(field: string, value: unknown, source: string): HostError {
  return new HostError("config_invalid", {
    messageKey: "error.portInvalid",
    params: { value: String(value), source },
    detail: { field, value, source, reason: "not_a_usable_port", allowed: "1..65535, 0 (launch argument only)" },
  });
}

// ---------------------------------------------------------------------------
// <dataRoot>/host.json（D25 的「配置文件」那一档，裁定 R67）
// ---------------------------------------------------------------------------

/**
 * 宿主设置文件的形状。
 *
 * 只放「宿主自己的启动参数」这类东西，`config.json` 那一份归 SDK 管（R13）。眼下只有一个
 * `port`：D25 的中间那一档需要一个真实来源，而不是让 `configPort` 只能由宿主程序注入。
 */
export interface HostSettings {
  /** 端口；缺省表示「这一档没说话」，落到默认端口 */
  port?: number;
}

/**
 * 读 `<dataRoot>/host.json`。
 *
 * 三种情况分开：文件不在 → 空设置（这一档没说话，静默）；读不出来 / 不是 JSON / 不是对象 →
 * 就是坏文件，恢复出厂：先把坏文件改名留档为 `host.json.broken`、再写回一份合法的 `{}`、
 * 再回调一次（D32：坏了就恢复出厂，下次启动不再遇到同一个坏文件；留档是数据，不是兜底 ——
 * 用户手写的端口设置得能查回来）；`port` 在但不是可用端口 →
 * `config_invalid`（裁定 R67：显式给出的非法值报错，不静默回落）。
 */
export async function readHostSettings(
  paths: HostPaths,
  onRecovered?: ConfigRecoveredHandler,
): Promise<HostSettings> {
  let raw: string;
  try {
    raw = await readFile(paths.hostConfigFile, "utf8");
  } catch (error) {
    // 文件不在是正常情况（绝大多数据根上就没有这份文件）
    if (isMissingFile(error)) return {};
    return await recoverHostSettings(paths, onRecovered);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return await recoverHostSettings(paths, onRecovered);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return await recoverHostSettings(paths, onRecovered);
  }

  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "port") || record.port === null) return {};
  const port = record.port;
  if (!isValidPort(port)) throw invalidPort("port", port, "host.json");
  return { port };
}

/**
 * 坏掉之后恢复出厂：先把坏文件留档，再写回一份合法的 `{}`（＝默认端口、默认语言），再回调一次。
 */
async function recoverHostSettings(
  paths: HostPaths,
  onRecovered?: ConfigRecoveredHandler,
): Promise<HostSettings> {
  await archiveBroken(paths.hostConfigFile);
  await writeFile(paths.hostConfigFile, "{}\n", "utf8");
  await onRecovered?.(paths.hostConfigFile);
  return {};
}

/**
 * 把坏掉的设置文件改名留档为 `host.json.broken`。
 *
 * 与 SDK 的 `ConfigManager.archiveBroken()` 同一条规则（三个配置文件同一口径）：同名残骸
 * 已经在就带上时间戳（同一毫秒再撞上就补序号），不覆盖上一份残骸。
 */
async function archiveBroken(path: string): Promise<void> {
  const base = `${path}.broken`;
  let target = base;
  for (let index = 0; await exists(target); index += 1) {
    target = index === 0 ? `${base}.${Date.now()}` : `${base}.${Date.now()}-${index}`;
  }
  await rename(path, target);
}

/** 这个路径在不在（`access` 不抛就是在） */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
