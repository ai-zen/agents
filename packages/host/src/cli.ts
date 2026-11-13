#!/usr/bin/env node
/**
 * 命令行入口（`bin.agents-host` → `dist/cli.js`）。
 *
 * 三组动作：
 *   - `agents-host [serve]`：前台起服务。缺省是本地实例（只监听回环，凭证自动生成并写在
 *     `<数据根>/run/token`）；`--public` 起对外实例，`--host` 指定监听地址；
 *   - `agents-host token create|list|revoke`：**不开服务**，直接开库操作凭证（PRD L11 / F-E4）。
 *     明文只在 `create` 的那一次输出里出现，此后库里只有摘要；
 *   - `agents-host version`：版本与协议版本（升级判定要比这两个，PRD D4 / F-E3）。
 *
 * 参数解析是手写的：这个包不新增依赖，而命令形状就这么几种。解析失败给一句人话 + 退出码 2
 * （「参数用法不对」与「运行失败」分开，脚本才好分支）；运行失败走 1，成功走 0。
 *
 * 错误一律走 i18n 渲染出的人话，不甩栈：命令行是给人看的，栈只在日志里有意义。
 */

import { mkdir } from "node:fs/promises";

import { createHost, resolveHostVersion } from "./app.js";
import { readHostSettings, resolvePaths } from "./config.js";
import type { HostPaths } from "./config.js";
import type { Language } from "./i18n/index.js";
import { CredentialService } from "./services/index.js";
import { CredentialRepository, Database, migrate } from "./storage/index.js";
import { PROTOCOL_VERSION, HostError, toErrorData } from "./wire/index.js";

/** 用法不对时的退出码（与「跑起来但失败了」区分开） */
const EXIT_USAGE = 2;

/** 运行期失败的退出码 */
const EXIT_FAILURE = 1;

/**
 * 命令行的语言。
 *
 * 宿主的产品文案是「按连接的语言」渲染的（PRD D8），而命令行没有连接、也就没有协商入口，
 * 所以它与自己的说明文字用同一种语言。这一点已在 `docs/plan-questions.md` 记过。
 */
const CLI_LANGUAGE: Language = "zh";

const USAGE = `用法：
  agents-host [serve] [--port <端口>] [--host <地址>] [--local | --public] [--ai-zen-dir <目录>]
      前台启动服务。缺省是本地实例（只监听 127.0.0.1，凭证自动生成并写在 <数据根>/run/token）。
      端口的三档来源：--port > <数据根>/host.json 的 port > 默认 8790。
      --port 0  让系统分配一个空闲端口（端口被占用时的退路，也是测试与冒烟用的写法）。
      日志写在 <数据根>/logs/host.log（按大小轮转）。

  agents-host token create [--note <备注>] [--ai-zen-dir <目录>]
      新建一串凭证。明文只显示这一次。
  agents-host token list [--ai-zen-dir <目录>]
      列出全部凭证（含已吊销的）。
  agents-host token revoke <凭证 id> [--ai-zen-dir <目录>]
      单独吊销一串凭证。

  agents-host version
      打印宿主版本与协议版本。

  --help / -h   打印这段说明。`;

/** 解析出来的命令行 */
interface ParsedArgs {
  command: "serve" | "token" | "version" | "help";
  /** `token` 下的动作 */
  action?: "create" | "list" | "revoke";
  /** `token revoke` 的目标 */
  credentialId?: string;
  /** `token create` 的备注 */
  note?: string;
  port?: number;
  /** 数据根（`--ai-zen-dir`） */
  aiZenDir?: string;
  /** 显式指定的监听地址 */
  host?: string;
  /** 本地实例（缺省）/ 对外实例 */
  local: boolean;
}

/** 参数用法错误：带着一句给人看的话，由入口翻成退出码 2 */
class UsageError extends Error {}

/**
 * 解析命令行。
 *
 * 顺序不敏感（`--port` 可以写在子命令前后）：脚本里两种写法都有人用，为此出错不值当。
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: "serve", local: true };
  const words: string[] = [];
  /** `--local` / `--public` 有没有被人明确写出来（用来发现与 `--host` 的矛盾） */
  let localGiven = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    switch (arg) {
      case "-h":
      case "--help":
        parsed.command = "help";
        return parsed;
      case "--local":
        parsed.local = true;
        localGiven = true;
        break;
      case "--public":
        parsed.local = false;
        localGiven = true;
        break;
      case "--port": {
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError("--port 后面要跟一个端口号");
        parsed.port = parsePort(value);
        index += 1;
        break;
      }
      case "--host": {
        const value = argv[index + 1];
        if (value === undefined || value.trim() === "") {
          throw new UsageError("--host 后面要跟一个监听地址");
        }
        parsed.host = value.trim();
        index += 1;
        break;
      }
      case "--note": {
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError("--note 后面要跟一句备注");
        parsed.note = value;
        index += 1;
        break;
      }
      case "--ai-zen-dir": {
        const value = argv[index + 1];
        if (value === undefined || value.trim() === "") {
          throw new UsageError("--ai-zen-dir 后面要跟一个目录");
        }
        parsed.aiZenDir = value;
        index += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new UsageError(`不认识的参数：${arg}`);
        words.push(arg);
    }
  }

  const [head, ...rest] = words;
  if (head !== undefined) {
    if (head === "serve") {
      if (rest.length > 0) throw new UsageError(`serve 不接受多余的位置参数：${rest.join(" ")}`);
      parsed.command = "serve";
    } else if (head === "version") {
      if (rest.length > 0) throw new UsageError(`version 不接受位置参数：${rest.join(" ")}`);
      parsed.command = "version";
    } else if (head === "token") {
      applyTokenArgs(parsed, rest);
    } else {
      throw new UsageError(`不认识的命令：${head}`);
    }
  }

  // 监听地址决定了这是哪种实例（PRD A6：本地实例只监听回环）
  if (parsed.host !== undefined) {
    if (isLoopbackHost(parsed.host)) {
      parsed.local = true;
    } else if (localGiven && parsed.local) {
      throw new UsageError(`--local 与对外地址 ${parsed.host} 互相矛盾：本地实例只监听回环`);
    } else {
      parsed.local = false;
    }
  }
  return parsed;
}

function applyTokenArgs(parsed: ParsedArgs, rest: readonly string[]): void {
  const [action, ...tail] = rest;
  if (action === "create" || action === "list") {
    if (tail.length > 0) throw new UsageError(`token ${action} 不接受位置参数：${tail.join(" ")}`);
    parsed.command = "token";
    parsed.action = action;
    return;
  }
  if (action === "revoke") {
    const id = tail[0];
    if (id === undefined) throw new UsageError("token revoke 后面要跟一个凭证 id");
    if (tail.length > 1) throw new UsageError(`token revoke 只接受一个 id：${tail.join(" ")}`);
    parsed.command = "token";
    parsed.action = "revoke";
    parsed.credentialId = id;
    return;
  }
  throw new UsageError(`不认识的 token 动作：${action ?? "(空)"}（可用：create / list / revoke）`);
}

/**
 * 端口：0..65535 的整数，`0` 表示让系统分配。
 *
 * 写错就当场说，不静默回落到默认端口（R12 的口径：静默回落会造成「我配了 9000 却在 8790 上」）。
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`端口要写成 0..65535 的整数（0 表示让系统分配），收到的是：${value}`);
  }
  return port;
}

/** 这个地址是不是回环（本地实例只监听回环，PRD A6） */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * 开库做一件凭证相关的事（不启服务）。
 *
 * 与 `HostApp` 用同一个库文件与同一套迁移：命令行建出来的凭证，起服务后立刻能用。
 */
async function withCredentials<T>(
  paths: HostPaths,
  work: (credentials: CredentialService) => Promise<T>,
): Promise<T> {
  await mkdir(paths.dataRoot, { recursive: true });
  const db = new Database(paths.dbFile);
  try {
    await migrate(db);
    return await work(new CredentialService({ credentials: new CredentialRepository(db) }));
  } finally {
    await db.close();
  }
}

/** `token create`：明文只在这里出现一次 */
async function runTokenCreate(paths: HostPaths, note: string | undefined): Promise<void> {
  const result = await withCredentials(paths, (credentials) =>
    credentials.create({ note: note ?? "" }),
  );
  process.stdout.write(`凭证已创建（id: ${result.credential.id}）\n`);
  if (result.credential.note !== "") process.stdout.write(`备注：${result.credential.note}\n`);
  process.stdout.write(`\n${result.token}\n\n`);
  process.stdout.write("上面这串凭证只显示这一次：宿主此后只保存它的摘要，丢了只能重新创建。\n");
  process.stdout.write("把它分发给要连接这台宿主的设备，对方在握手时带上它即可。\n");
}

/** `token list`：连已吊销的一起列，吊销状态看中间那列 */
async function runTokenList(paths: HostPaths): Promise<void> {
  const result = await withCredentials(paths, (credentials) => credentials.list());
  if (result.credentials.length === 0) {
    process.stdout.write("还没有任何凭证。用 `agents-host token create --note <备注>` 创建一串。\n");
    return;
  }
  for (const credential of result.credentials) {
    const state = credential.revokedAt === null ? "有效" : `已吊销（${credential.revokedAt}）`;
    process.stdout.write(
      `${credential.id}  ${state}  创建于 ${credential.createdAt}  ${credential.note}\n`,
    );
  }
}

/** `token revoke`：`revoked: false` 表示这串本来就已经吊销了（不是失败，R42） */
async function runTokenRevoke(paths: HostPaths, credentialId: string): Promise<void> {
  const result = await withCredentials(paths, (credentials) =>
    credentials.revoke({ credentialId }),
  );
  process.stdout.write(
    result.revoked ? `已吊销：${credentialId}\n` : `这串凭证本来就已吊销：${credentialId}\n`,
  );
}

/**
 * `serve`：前台起服务。
 *
 * 启动后打印四样东西：实际监听地址（端口可能是系统分配的）、版本、发现文件、本地凭证交付文件
 * —— 客户端要连的就是前两个，本机免输凭证靠的是第三个（PRD A5 / architecture §2）。
 * 日志落在哪儿也报一行（PRD F-J2：界面被占满时那是唯一的去处）。
 *
 * 端口的三档来源（D25 / 裁定 R67）：`--port` > `<数据根>/host.json` 的 `port` > 默认 8790。
 * 配置文件那一档在这里读：读坏了（不是 JSON、端口不合法）就当场失败，不静默回落。
 *
 * 同一个数据根上已经有人在服务时（单实例），本进程只是把那个地址报出来就退出：
 * 两个进程各写一份 `host.json` 会让客户端连谁都不对。
 */
async function runServe(parsed: ParsedArgs): Promise<void> {
  const paths = resolvePaths(parsed.aiZenDir);
  // 参数给了端口就不读配置文件：那一档这时轮不到它说话
  const configPort = parsed.port === undefined ? (await readHostSettings(paths)).port : undefined;

  const app = await createHost({
    aiZenDir: parsed.aiZenDir,
    port: parsed.port,
    configPort,
    host: parsed.host,
    local: parsed.local,
  });

  const target = await app.start();

  if (app.attached) {
    process.stdout.write(`已有宿主在运行：ws://${target.host}:${target.port}\n`);
    process.stdout.write(`发现文件：${app.paths.hostFile}\n`);
    process.stdout.write("本进程不重复监听，直接退出。\n");
    await app.stop("requested");
    return;
  }

  process.stdout.write(`宿主已启动：ws://${target.host}:${target.port}\n`);
  process.stdout.write(`版本：${app.version}（协议 ${PROTOCOL_VERSION}）\n`);
  process.stdout.write(`发现文件：${app.paths.hostFile}\n`);
  process.stdout.write(`日志：${app.paths.logsDir}\n`);
  if (app.local) {
    process.stdout.write(`本地凭证交付文件：${app.paths.tokenFile}\n`);
  } else {
    process.stdout.write(
      "对外实例：用 `agents-host token create --note <备注>` 创建凭证，再分发给要连接的设备。\n",
    );
  }

  // 优雅退出：等收尾做完（摘发现文件、断连接、回收 Scope、关库）再让进程走
  const stop = (): void => {
    void app.shutdown("requested");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** 版本：脚本里比对升级（PRD D4 / F-E3） */
function runVersion(): void {
  process.stdout.write(
    `@ai-zen/agents-host ${resolveHostVersion()}（协议 ${PROTOCOL_VERSION}）\n`,
  );
}

/**
 * 失败原因（人话）。
 *
 * `HostError` 带文案键与参数，按命令行的语言渲染一句；其余错误只说它说了什么 —— 栈不进
 * 终端，它只对改代码的人有用。
 */
function describeFailure(error: unknown): string {
  if (HostError.is(error)) {
    const data = toErrorData(error, CLI_LANGUAGE);
    const detail = error.detail;
    const hint =
      typeof detail === "object" && detail !== null && typeof (detail as { path?: unknown }).path === "string"
        ? `（${(detail as { path: string }).path}）`
        : "";
    return `${data.message}${hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 入口：返回退出码。
 *
 * 用法错误走 2、运行失败走 1、成功走 0 —— 脚本据此分支，不去解析句子。
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  if (parsed.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    if (parsed.command === "version") {
      runVersion();
      return 0;
    }

    const paths = resolvePaths(parsed.aiZenDir);
    if (parsed.command === "token") {
      if (parsed.action === "create") await runTokenCreate(paths, parsed.note);
      else if (parsed.action === "list") await runTokenList(paths);
      else await runTokenRevoke(paths, parsed.credentialId ?? "");
      return 0;
    }

    await runServe(parsed);
    // 服务在后台跑（监听、推送），主流程不阻塞在某个 Promise 上
    return 0;
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`);
    return EXIT_FAILURE;
  }
}

// 本文件就是进程入口（`bin.agents-host` → `dist/cli.js`），不做「被 import 时不执行」的分支：
// 库里没有任何地方 import 它，带了那个分支只会在符号链接安装（`node_modules/.bin`）时静默失效。
void main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
});
