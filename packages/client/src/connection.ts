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
 *
 * ## 拉起宿主：两条路，一条判据
 *
 * 两条：
 *
 *   · 调用方给了 `entry`（桌面端把宿主捆进自己的产物、随包分发）→ 起那个入口；
 *   · 没给 → 让 **npx** 现下现起：`npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`
 *     （PRD L14：能用 CLI 的地方一定有 npm，本机宿主不必预先装好）。
 *
 * 判据只有一句 `context.entry === undefined`（{@link spawnHostByContext}）。两条路的差别只在
 * 「起哪个进程」：之后都是同一段「轮询发现文件 + 握手」，本文件里没有第二套语义。
 *
 * ## 阶段（PRD D31）
 *
 * {@link HostLaunchStage} 是给**屏**用的：CLI 的下载屏
 * （`cli/src/tui/screens/host-download.tsx`）按它换那一行字。这里只报「走到哪一步了」，不报
 * 百分比 —— npm 的输出不是协议，不解析它（于是「下载」与「安装」合成一步）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ClientInfo } from "@ai-zen/agents-host";

import { isLoopbackHost, parseAddress, type HostTarget } from "./address.js";
import { Client, type ClientOptions } from "./client.js";
import { isClientError, localError, type ClientError } from "./errors.js";
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

/**
 * 拉起的阶段。
 *
 * 四步：「解析版本 → 下载并安装 → 启动宿主 → 连上」—— 中间那两步合成一个（分不开，那要把
 * npm 的输出当协议）。
 */
export type HostLaunchStage =
  /** 让 npx 解析「满足这个范围的最新版」（只有 npx 那条路有这一步） */
  | "resolving"
  /** 下载 + 安装（npx 的活；与下载分不开，那要把 npm 的输出当协议） */
  | "installing"
  /** 宿主进程已经起来、正等它写发现文件并握手 */
  | "starting"
  /** 握手成功，这条连接可以用了 */
  | "connected";

/** 拉起的那个子进程自己退了：这次拉起失败 */
export interface HostLaunchFailure {
  /** 退出码（被信号杀掉时是 `null`） */
  code: number | null;
  /** 它最后一行有意义的输出（没有就是空串）—— 原样上屏，不翻译、不改写 */
  reason: string;
}

/** 拉起的结果 */
export interface SpawnedHost {
  /** 子进程退出时 settle（拉起之后它该一直活着；提前退＝这次拉起失败了） */
  exited: Promise<HostLaunchFailure>;
}

/** 拉起宿主时给宿主的信息，外加两个插头（进度与取消） */
export interface SpawnHostContext {
  dataRoot: string;
  /**
   * 宿主入口（`@ai-zen/agents-host` 的 `dist/cli.js`，或宿主自己捆好的那一个）。
   *
   * 给了就起它；没给就按 `versionRange` 让 npx 现下现起。
   */
  entry?: string;
  /** 让 npx 去拉哪个版本范围（`^0.1.0-alpha.0` 这种）；没给 `entry` 时必填 */
  versionRange?: string;
  /** 走到哪个阶段了 */
  onStage?: (stage: HostLaunchStage) => void;
  /** 取消：中止正在拉起的那个子进程（Ctrl+C） */
  signal?: AbortSignal;
}

/** 拉起宿主的实现（缺省 {@link spawnHostByContext}） */
export type SpawnHost = (context: SpawnHostContext) => Promise<SpawnedHost | void>;

/** 起子进程的注入点（生产全用缺省值；用例喂一个假的，免得真去联网拉包） */
export interface SpawnDeps {
  /** 起一个子进程（缺省 `node:child_process.spawn`） */
  spawn?: typeof spawn;
  /** 按哪个平台拼命令行 / 杀进程组（缺省当前平台；用例两个平台都验） */
  platform?: NodeJS.Platform;
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
  /** 拉起宿主（缺省 {@link spawnHostByContext}：给了 `hostEntry` 起它，没给就让 npx 现下现起） */
  spawnHost?: SpawnHost;
  /** 宿主入口（给了就走「已装 / 已打包」那条路；桌面端随包分发的那一份从这里进） */
  hostEntry?: string;
  /** npx 那条路要拉的版本范围（CLI 构建时从自己的 devDependencies 注入，PRD L14） */
  versionRange?: string;
  /**
   * 阶段变化。消费者只有一处：CLI 的下载屏（`screens/host-download.tsx`）用它换那一行字。
   * 只报「走到哪一步」，不报百分比 —— npm 的输出不是协议。
   */
  onStage?: (stage: HostLaunchStage) => void;
  /** 取消：中止正在拉起的那个子进程（CLI 的下载屏按 Esc / Ctrl+C 时 abort） */
  signal?: AbortSignal;
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
  const onStage = options.onStage ?? (() => {});

  /** 取消是「用户不想拉了」，不是拉起失败：码分开，屏上才能少一句误导人的话 */
  const throwIfCancelled = (): void => {
    if (options.signal?.aborted) {
      throw localError("host_launch_cancelled", { language, detail: { dataRoot } });
    }
  };

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
    onStage("connected");
    return { client, target: explicit, started: false, explicit: true, dataRoot };
  }

  // ---- 本机：发现文件里那个还活着吗 ---------------------------------------------
  const discovered = await readHostFile(dataRoot, readText);
  if (discovered) {
    const target: HostTarget = { host: discovered.host, port: discovered.port };
    const client = await attempt(target, (await readLocalToken(dataRoot, readText)) ?? "");
    if (client) {
      onStage("connected");
      return { client, target, started: false, explicit: false, dataRoot };
    }
  }

  // ---- 拉起一个 ----------------------------------------------------------------
  throwIfCancelled();
  const spawnHost = options.spawnHost ?? spawnHostByContext;
  const spawned = await spawnHost({
    dataRoot,
    ...(options.hostEntry === undefined ? {} : { entry: options.hostEntry }),
    ...(options.versionRange === undefined ? {} : { versionRange: options.versionRange }),
    onStage,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  /** 拉起它的那个子进程提前退了：它就是这次失败的原因（不必等满时限） */
  let launchFailure: HostLaunchFailure | null = null;
  void spawned?.exited.then((failure) => {
    launchFailure = failure;
  });

  // ---- 轮询到就绪（发现文件换了 pid + 握手成功）--------------------------------
  /** `starting` 只报一次：同一个宿主起来只该占用一行字一遍 */
  let announcedStarting = false;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    throwIfCancelled();
    if (launchFailure) throw launchFailed(launchFailure, dataRoot, language);
    const facts = await readHostFile(dataRoot, readText);
    // 只认**新**的那个 pid：旧发现文件（进程已死）对应的端口不该被当成刚拉起的那个
    if (facts && facts.pid !== discovered?.pid) {
      // 发现文件出现＝宿主进程真的起来了，剩下的只是握手
      if (!announcedStarting) {
        announcedStarting = true;
        onStage("starting");
      }
      const target: HostTarget = { host: facts.host, port: facts.port };
      const client = await attempt(target, (await readLocalToken(dataRoot, readText)) ?? "");
      if (client) {
        onStage("connected");
        return { client, target, started: true, explicit: false, dataRoot };
      }
    }
    await sleep(retryIntervalMs);
  }

  throwIfCancelled();
  if (launchFailure) throw launchFailed(launchFailure, dataRoot, language);
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
 * 缺省的拉起方式 —— **一条判据**：调用方给了 `entry` 就起它，没给就让 npx 现下现起。
 *
 * 两种来源的差别只在「起哪个进程」：桌面端把宿主捆进自己的产物随包分发（客户机不保证有
 * npm），CLI 那边什么都不带、按自己声明的范围让 npx 去拉（PRD L14）。之后都是同一段
 * 「轮询发现文件 + 握手」。
 */
export function spawnHostByContext(
  context: SpawnHostContext,
  deps: SpawnDeps = {},
): Promise<SpawnedHost> {
  return context.entry === undefined
    ? spawnHostViaNpx(context, deps)
    : spawnHostEntry(context, deps);
}

/**
 * 起一个**已经给了入口**的宿主（桌面端随包分发的那份、或本机确实装好的那份）。
 *
 * 用 `process.execPath`：桌面端把它变成 Electron 自带的那个 Node（`ELECTRON_RUN_AS_NODE`），
 * 于是同一份二进制既能跑应用也能跑宿主，不必随包再带一个 Node。
 */
export async function spawnHostEntry(
  context: SpawnHostContext,
  deps: SpawnDeps = {},
): Promise<SpawnedHost> {
  const entry = context.entry;
  if (entry === undefined) {
    throw localError("host_entry_missing", { detail: { dataRoot: context.dataRoot } });
  }
  return startDetachedHost({
    context,
    ...deps,
    command: process.execPath,
    args: [entry, "serve", "--ai-zen-dir", context.dataRoot],
    // 显式传一遍：子进程不依赖「调用方的 env 恰好和发现目录一致」
    env: { ...process.env, [AI_ZEN_DIR_ENV]: context.dataRoot },
  });
}

/**
 * 用 `npx` 现下现起：`npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`。
 *
 * `-y` 不能省：没有它，npx 在「这个包还没装过」时要问一句，而这一问在 TUI 底下没有任何人
 * 回答得起。`@<range>` 让 npx 解析成「满足这个范围的最新版」——升级因此是「重新拉起一次」
 * 就够，客户端不把版本号写进代码（PRD L14 / F-E3）。
 */
export async function spawnHostViaNpx(
  context: SpawnHostContext,
  deps: SpawnDeps = {},
): Promise<SpawnedHost> {
  const versionRange = context.versionRange?.trim() ?? "";
  if (versionRange === "") {
    throw localError("host_version_range_missing", {
      detail: { dataRoot: context.dataRoot, entry: context.entry ?? null },
    });
  }
  const argv = npxHostArgv({
    versionRange,
    dataRoot: context.dataRoot,
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  // 从这一刻起 npx 已经在解析「满足范围的最新版」
  context.onStage?.("resolving");
  const started = await startDetachedHost({
    context,
    ...deps,
    command: argv.command,
    args: argv.args,
    shell: argv.shell,
  });
  // 解析完就轮到（必要时）下载与安装，我们分不开这两步
  context.onStage?.("installing");
  return started;
}

/** npm registry 上的宿主包名 */
const HOST_PACKAGE = "@ai-zen/agents-host";

/** npx 那条路的命令行 */
export interface NpxHostArgv {
  command: string;
  args: string[];
  /** 要不要过一层 shell（Windows 的 `npx.cmd` 只能这么起） */
  shell: boolean;
}

/**
 * npx 那条路的命令行。
 *
 * Windows 单独一份的理由：那边 npx 是 `npx.cmd`，而 `.cmd` 不过一层 shell 起不来（Node 从
 * 18.20 起对这种调用直接报 EINVAL）。过 shell 之后 `^`（版本范围的第一个字符）会被 cmd 当成
 * 转义符吃掉 —— 于是「拉满足范围的最新版」会退化成「就这一个版本」，所以这两个参数各自加一层
 * 引号，让 cmd 原样递下去。
 */
export function npxHostArgv(input: {
  versionRange: string;
  dataRoot: string;
  /** 按哪个平台拼（缺省当前平台；两个平台的形状都要能验） */
  platform?: NodeJS.Platform;
}): NpxHostArgv {
  const spec = `${HOST_PACKAGE}@${input.versionRange}`;
  if ((input.platform ?? process.platform) === "win32") {
    return {
      command: "npx.cmd",
      shell: true,
      args: ["-y", `"${spec}"`, "serve", "--ai-zen-dir", `"${input.dataRoot}"`],
    };
  }
  return {
    command: "npx",
    shell: false,
    args: ["-y", spec, "serve", "--ai-zen-dir", input.dataRoot],
  };
}

/** `<数据根>/logs/host-launch.log`：拉起过程中那个子进程的输出（失败时的那句原因就在这里） */
export function hostLaunchLogPath(dataRoot: string): string {
  return join(dataRoot, "logs", "host-launch.log");
}

/**
 * 宿主入口：**已装的那个私有包**的 `dist/cli.js`。
 *
 * 缺省的拉起方式已经不是它了（消费者机器上不会装这个包，见 {@link spawnHostViaNpx}）：它现在只
 * 服务「这台机器上确实装着宿主」的调用方 —— 仓库内的用例与诊断。
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

/** 起一个 detached 子进程时给它的全部事实 */
interface StartHostProcessInput extends SpawnDeps {
  context: SpawnHostContext;
  command: string;
  args: string[];
  /** 过一层 shell（Windows 的 `npx.cmd`） */
  shell?: boolean;
  /** 子进程的环境（缺省继承本进程） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 起一个 detached 的子进程，把它退出时的那句话留给调用方。
 *
 * ## 输出为什么不走管道
 *
 * 它写 `<数据根>/logs/host-launch.log`（每次拉起重新写）。管道有两个问题：一是把 npm 的进度混进
 * 调用方的终端（TUI 是全屏渲染，任何一行都会把界面打花）；二是一条活着的管道会把客户端钉在事件
 * 循环里 —— `ai "…"` 于是永远退不出去。文件顺带解决了「失败时从哪儿读那句原因」。
 *
 * ## `detached` / `windowsHide`
 *
 * `detached`：客户端退出之后宿主继续活着（PRD D29：关客户端不是关宿主），也正是它让 POSIX 上
 * 的子进程自成一个进程组 —— 取消时能连着 npx 拉起来的那一层一起杀掉。`windowsHide`：Windows 上
 * `detached` 会给子进程自己的控制台窗口，而那个窗口没有任何作用。
 *
 * 等 `spawn` 事件而不是直接返回：命令根本不存在（PATH 里没有 npx）这类错误当场报，不用等满
 * 时限。凭证**不进命令行** —— 那一串会进 `ps` 输出；它由宿主自己生成并写 `run/token`。
 */
async function startDetachedHost(input: StartHostProcessInput): Promise<SpawnedHost> {
  const platform = input.platform ?? process.platform;
  const logFile = hostLaunchLogPath(input.context.dataRoot);
  const logFd = openLaunchLog(logFile);
  const child = (input.spawn ?? spawn)(input.command, input.args, {
    env: input.env ?? process.env,
    detached: true,
    stdio: ["ignore", "ignore", logFd ?? "ignore"],
    windowsHide: true,
    ...(input.shell ? { shell: true } : {}),
  });
  // 递给子进程的那份已经 dup 过去了，这边这份可以立刻关
  if (logFd !== null) closeSync(logFd);

  const exited = new Promise<HostLaunchFailure>((resolve) => {
    // `close` 而不是 `exit`：前者等子进程的 stdio 也关完，日志里那句原因已经落盘
    child.once("close", (code, signal) => {
      resolve({ code: signal === null ? code : null, reason: lastMeaningfulLine(logFile) });
    });
  });

  const signal = input.context.signal;
  if (signal) {
    if (signal.aborted) killHostProcess(child, platform);
    else signal.addEventListener("abort", () => killHostProcess(child, platform), { once: true });
  }

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      reject(
        localError("host_launch_failed", {
          params: { reason: describeError(error), log: logFile },
          detail: { command: input.command, logFile },
        }),
      );
    });
  });
  child.unref();
  return { exited };
}

/** 打开拉起日志。打不开就返回 `null`：写不了日志不该拦住一次拉起 */
function openLaunchLog(path: string): number | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 每次拉起重新写：失败时要的是**这一回**的那句原因，上一次的噪声不该被当成它
    return openSync(path, "w");
  } catch {
    return null;
  }
}

/**
 * 杀掉正在拉起的那个子进程。
 *
 * POSIX 上先杀**整个进程组**（`detached` 让子进程自成一组）：只杀 npx 的话，它刚拉起来的宿主
 * 会活成孤儿，下一次拉起就变成「两个宿主抢一个数据根」。Windows 上没有进程组可杀，只能杀自己
 * 这一层。
 */
function killHostProcess(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      // 组已经不在了（子进程早就退干净），落到下面那一下
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // 已经退了
  }
}

/** 日志文件的最后一行有意义的输出（只在拉起失败时读；成功时不碰它） */
function lastMeaningfulLine(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // npm 的进度行带颜色/光标控制：上屏之前抹掉，屏幕上不该出现裸的控制序列
    const line = (lines[index] ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (line !== "") return line;
  }
  return "";
}

/** 子进程提前退出 → 一条能上屏的失败（原因原样给，不翻译、不改写） */
function launchFailed(
  failure: HostLaunchFailure,
  dataRoot: string,
  language: string | undefined,
): ClientError {
  const logFile = hostLaunchLogPath(dataRoot);
  const reason =
    failure.reason !== ""
      ? failure.reason
      : `exit code ${failure.code === null ? "signal" : failure.code}`;
  return localError("host_launch_failed", {
    language,
    params: { reason, log: logFile },
    detail: { code: failure.code, reason: failure.reason, logFile },
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

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
