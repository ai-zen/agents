/**
 * 「确保有一个能连的宿主」：**有就上，没有就拉一个**（PRD D26 / D25）。
 *
 * 名字用 `ensure` 而不是 `start`：多数时候它什么都没做（发现文件里有活着的宿主，连上就走），
 * 只在真的没有时才 spawn 一个 detached 子进程。
 *
 * ## 两条路
 *
 * 1. **显式地址**（`settings.mode === "remote"`）：只连、**绝不拉起**。本地起的进程一定不在那个
 *    地址上，拉起只会白等到时限，然后报一个指向错误方向的超时 —— 而用户真正要知道的是「那台
 *    机器没应答」或「凭证没被接受」。
 * 2. **本机**：读 `<数据根>/run/host.json` 拿地址、`<数据根>/run/token` 拿凭证；探不到就
 *    spawn `agents-host serve`，然后轮询到「发现文件出现 + `host.hello` 成功」才算就绪。
 *
 * ## 为什么只认发现文件，不认端口
 *
 * 端口可能被占而退回系统分配的临时端口（D25），也可能根本没人监听（上次崩了）。唯一真相是
 * `<数据根>/run/host.json`；它过期了（pid 已死）就交给宿主自己的单实例判断去收，客户端不重复
 * 实现那套判断。
 *
 * ## 为什么拉起之后要轮询
 *
 * detached 子进程的启动是异步的：`spawn` 返回 ≠ 端口在监听 ≠ 发现文件已写 ≠ 握手能过。轮询是
 * 唯一可靠的「就绪」判据，而握手成功是它的最后一步 —— 只探端口的话，数据库还没起来的宿主
 * 照样会接受连接、然后把每个方法都回成内部错误。
 *
 * ## 凭证每一轮都重读
 *
 * 刚拉起的宿主是**它自己**在启动时生成并写入 `<数据根>/run/token` 的（这台机器上第一次跑时
 * 文件压根不存在）。只在 spawn 之前读一次的话，第一次能拉起、却永远连不上 —— 而错误会指向
 * 「宿主起不来」，方向完全错。
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ClientInfo } from "@ai-zen/agents-host";

import { isLoopbackHost, parseAddress, type HostTarget } from "./address.js";
import { Client, type ClientOptions } from "./client.js";
import { isClientError, localError } from "./errors.js";
import { settingsToTarget, type ConnectionSettings } from "./settings.js";

/** 数据根的环境变量名（与宿主的 `AI_ZEN_DIR_ENV` 同一个词） */
export const AI_ZEN_DIR_ENV = "AI_ZEN_DIR";

/** `run/host.json` 里本模块用到的字段（宿主 `net/discovery.ts` 的 `HostFileInfo` 的子集） */
export interface LocalHostFacts {
  /** 宿主进程 id：换了 pid 就说明「这是新拉起的那个」 */
  pid: number;
  /** 实际监听的地址（端口被占时是退回的临时端口） */
  host: string;
  port: number;
}

/** 拉起宿主时给宿主的信息 */
export interface SpawnHostContext {
  dataRoot: string;
  /** 宿主入口（`@ai-zen/agents-host` 的 `dist/cli.js`，或宿主自己捆好的那一个） */
  entry: string;
}

/** `ensureHost` 的可注入项；生产路径全用缺省值 */
export interface EnsureHostOptions {
  /** 数据根：显式给 > `AI_ZEN_DIR` > `~/.ai-zen` */
  dataRoot?: string;
  /** 客户端身份（握手带上，宿主用它做连接列表与日志） */
  clientInfo: ClientInfo;
  /** 上一次的连接设置（`settings.ts`）。`remote` 即「显式地址」 */
  settings?: ConnectionSettings;
  /** 覆盖设置里的语言（宿主切语言时不必改设置文件） */
  language?: string;
  /** 建连（缺省 `Client.connect`） */
  connect?: (options: ClientOptions) => Promise<Client>;
  /** 拉起宿主（缺省 {@link spawnAgentsHost}） */
  spawnHost?: (context: SpawnHostContext) => Promise<void>;
  /** 宿主入口（缺省从已装的 `@ai-zen/agents-host` 解析） */
  hostEntry?: string;
  /** 读文本文件（缺省 `fs.readFile`；读不到返回 `null`） */
  readTextFile?: (path: string) => Promise<string | null>;
  /** 等一会儿（缺省 `setTimeout`；注入出来让用例不必真等） */
  sleep?: (ms: number) => Promise<void>;
  /** 现在几点（缺省 `Date.now`；与 `sleep` 一起注入，轮询的时限才可测） */
  now?: () => number;
  /** 拉起之后多久还连不上就放弃 */
  timeoutMs?: number;
  /** 轮询间隔 */
  retryIntervalMs?: number;
  /** 单次建连 + 握手的时限 */
  connectTimeoutMs?: number;
}

/** `ensureHost` 的结果 */
export interface EnsureHostResult {
  client: Client;
  /** 连上的地址（结构化；界面拼地址一律用它） */
  target: HostTarget;
  /** 这次是不是本客户端拉起了宿主（`true` 说明之前没有活着的实例） */
  started: boolean;
  /** 连的是不是显式地址（这条路上 `started` 恒为 `false`，因为它绝不拉起） */
  explicit: boolean;
  dataRoot: string;
}

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

/** 数据根：显式参数 > `AI_ZEN_DIR` > `~/.ai-zen`（与宿主 `resolveDataRoot` 同一口径） */
export function resolveDataRoot(explicit?: string): string {
  const given = trimmed(explicit) ?? trimmed(process.env[AI_ZEN_DIR_ENV]);
  return given ?? join(homedir(), ".ai-zen");
}

/** `<数据根>/run/host.json`：这台机器上谁在服务 */
export function hostFilePath(dataRoot: string): string {
  return join(dataRoot, "run", "host.json");
}

/** `<数据根>/run/token`：本地凭证的交付口（只读；写它的只有宿主） */
export function tokenFilePath(dataRoot: string): string {
  return join(dataRoot, "run", "token");
}

/**
 * 读发现文件；文件不在 / 坏 JSON / 缺字段一律 `null`（＝「没有活着的实例」）。
 *
 * 「文件坏了」与「文件不在」在这里不分开：两者对这个函数的用途是同一件事，而坏文件不该拦住
 * 一次「拉一个新的起来」。
 */
export async function readHostFile(
  dataRoot: string,
  readText: (path: string) => Promise<string | null> = readTextFile,
): Promise<LocalHostFacts | null> {
  const raw = await readText(hostFilePath(dataRoot));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const facts = value as Partial<LocalHostFacts>;
  if (typeof facts.pid !== "number" || typeof facts.host !== "string") return null;
  if (typeof facts.port !== "number") return null;
  return { pid: facts.pid, host: facts.host, port: facts.port };
}

/** 读本地凭证；文件不在 / 内容为空一律 `null` */
export async function readLocalToken(
  dataRoot: string,
  readText: (path: string) => Promise<string | null> = readTextFile,
): Promise<string | null> {
  const raw = await readText(tokenFilePath(dataRoot));
  return trimmed(raw ?? null) ?? null;
}

/**
 * 确保有一个能连的宿主，并把已经握过手的 `Client` 交出去。
 *
 * 失败一律是 `ClientError`：宿主说的话（例如 `unauthorized`）原样上抛，客户端自己造的
 * （连不上、拉起超时）用本地码。
 */
export async function ensureHost(options: EnsureHostOptions): Promise<EnsureHostResult> {
  const dataRoot = resolveDataRoot(options.dataRoot);
  const readText = options.readTextFile ?? readTextFile;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const connect =
    options.connect ?? ((connectOptions: ClientOptions) => Client.connect(connectOptions));
  const settings = options.settings ?? { mode: "local" as const };
  const language = options.language ?? settingsToTarget(settings).language;

  /** 连一次；「现在连不上」不算错（返回 `null`），「被拒 / 地址不对」当场抛 */
  const attempt = async (target: HostTarget, token: string): Promise<Client | null> => {
    try {
      return await connect({
        target,
        token,
        clientInfo: options.clientInfo,
        ...(language ? { language } : {}),
        ...(options.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: options.connectTimeoutMs }
          : {}),
      });
    } catch (error) {
      if (isNotReady(error)) return null;
      throw error;
    }
  };

  // ---- 显式地址：只连、绝不拉起 -------------------------------------------------
  const explicit = explicitTarget(settings);
  if (explicit) {
    const token = await explicitToken(explicit, settings, dataRoot, readText);
    const client = await attempt(explicit, token);
    if (!client) {
      throw localError("host_unavailable", {
        language,
        params: { endpoint: `${explicit.host}:${explicit.port}` },
        detail: { host: explicit.host, port: explicit.port, explicit: true },
      });
    }
    return { client, target: explicit, started: false, explicit: true, dataRoot };
  }

  // ---- 本机：发现文件里那个还活着吗 ---------------------------------------------
  const discovered = await readHostFile(dataRoot, readText);
  if (discovered) {
    const target: HostTarget = { host: discovered.host, port: discovered.port };
    const client = await attempt(target, (await readLocalToken(dataRoot, readText)) ?? "");
    if (client) return { client, target, started: false, explicit: false, dataRoot };
  }

  // ---- 拉起一个 ----------------------------------------------------------------
  const spawnHost = options.spawnHost ?? spawnAgentsHost;
  const entry = options.hostEntry ?? resolveHostEntry();
  await spawnHost({ dataRoot, entry });

  // ---- 轮询到就绪（发现文件换了 pid + 握手成功）--------------------------------
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const facts = await readHostFile(dataRoot, readText);
    // 只认**新**的那个 pid：旧发现文件（进程已死）对应的端口不该被当成刚拉起的那个
    if (facts && facts.pid !== discovered?.pid) {
      const target: HostTarget = { host: facts.host, port: facts.port };
      const client = await attempt(target, (await readLocalToken(dataRoot, readText)) ?? "");
      if (client) return { client, target, started: true, explicit: false, dataRoot };
    }
    await sleep(retryIntervalMs);
  }

  throw localError("host_did_not_start", {
    language,
    params: { timeoutMs, dataRoot, log: join(dataRoot, "logs", "host.log") },
    detail: {
      dataRoot,
      timeoutMs,
      discoveredPid: discovered?.pid ?? null,
      logFile: join(dataRoot, "logs", "host.log"),
    },
  });
}

/**
 * 用 `process.execPath` 拉起一个 detached 的 `agents-host serve`。
 *
 * `stdio: "ignore"`：子进程的日志由它自己写 `<数据根>/logs/host.log`，绝不能把输出混进调用方
 * 的终端（TUI 是全屏渲染，任何一行都会把界面打花）。`windowsHide`：Windows 上 `detached` 会给
 * 子进程自己的控制台窗口，而那个窗口没有任何作用。
 *
 * 等 `spawn` 事件而不是直接返回：入口路径写错这类错误当场报，不用等满 15 秒超时。凭证**不进
 * 命令行** —— 那一串会进 `ps` 输出；它由宿主自己生成并写进 `run/token`。
 */
export async function spawnAgentsHost(context: SpawnHostContext): Promise<void> {
  const child = spawn(
    process.execPath,
    [context.entry, "serve", "--ai-zen-dir", context.dataRoot],
    {
      // 显式传一遍：子进程不依赖「调用方的 env 恰好和发现目录一致」
      env: { ...process.env, [AI_ZEN_DIR_ENV]: context.dataRoot },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}

/**
 * 宿主入口：**已装的那个私有包**的 `dist/cli.js`。
 *
 * 不用 `npx @ai-zen/agents-host` 那种写法：R69 之后共享包不发版，拉起本地宿主只能靠仓库里
 * 装好的那一份（或者宿主自己捆进产物、用 `hostEntry` 递进来）。
 */
export function resolveHostEntry(): string {
  try {
    const resolve = createRequire(import.meta.url);
    const manifest = resolve.resolve("@ai-zen/agents-host/package.json");
    return join(dirname(manifest), "dist", "cli.js");
  } catch (error) {
    throw localError("host_entry_missing", {
      detail: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/** 显式地址（`settings.mode === "remote"`）→ 结构化地址；本地模式返回 `null` */
function explicitTarget(settings: ConnectionSettings): HostTarget | null {
  const { url } = settingsToTarget(settings);
  if (settings.mode !== "remote" || !url) return null;
  return parseAddress(url);
}

/**
 * 显式地址这一条路用哪串凭证：设置里给了就用它；没给且目标是本机回环，就用本机
 * `run/token`（连自己那台实例是最常见的情形，而远端那串凭证与本机文件毫无关系）。
 */
async function explicitToken(
  target: HostTarget,
  settings: ConnectionSettings,
  dataRoot: string,
  readText: (path: string) => Promise<string | null>,
): Promise<string> {
  const fromSettings = settingsToTarget(settings).token;
  if (fromSettings) return fromSettings;
  if (!isLoopbackHost(target.host)) return "";
  return (await readLocalToken(dataRoot, readText)) ?? "";
}

/**
 * 这个失败是「现在不行」还是「这样不行」。
 *
 * 连不上 / 断了 / 握手超时都算「还没起来」，轮询继续；被宿主拒（`unauthorized`）、地址不合法
 * 之类继续等一万年也是同一个结果 —— 而把它吞掉只会得到一句「宿主起不来」，方向完全错。
 */
function isNotReady(error: unknown): boolean {
  if (!isClientError(error)) return false;
  switch (error.code) {
    case "host_unavailable":
    case "connection_lost":
    case "handshake_timeout":
    case "call_timeout":
      return true;
    default:
      return false;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    // 文件不在是最常见的情形（这台机器上还没起过宿主），不当作错误
    return null;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}
