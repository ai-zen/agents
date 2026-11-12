/**
 * 命令行入口（`bin` 指向 `dist/cli.js`）。
 *
 * 三组动作：
 *   - `agents-server` / `agents-server serve`：前台起服务（本地实例只监听回环，`--public` 对外）；
 *   - `agents-server token create|list|revoke`：**不开服务**，直接开库操作凭证（PRD L11 / F-E4）。
 *     明文只在 `create` 的那一次输出里出现，此后库里只有摘要；
 *   - `agents-server version`：版本与协议版本（升级判定要比这两个，PRD D4 / F-E3）。
 *
 * 参数解析是手写的：这个包不新增依赖，而命令形状就这么几种。解析失败给一句人话 +
 * 退出码 2（「参数用法不对」与「运行失败」分开，脚本才好分支）。
 *
 * 本文件是进程入口：控制台输出与信号处理都在这里，业务与组装在 `app.ts`。
 */

import { Database } from "./storage/index.js";
import type { Database as DatabaseType } from "./storage/Database.js";
import { CredentialRepository } from "./storage/CredentialRepository.js";
import { migrate } from "./storage/migrations.js";
import { PROTOCOL_VERSION } from "./wire/index.js";
import { createServer, resolveServerVersion } from "./app.js";
import { resolvePaths, type ServerPaths } from "./config.js";
import { CredentialService } from "./services/index.js";
import { mkdir } from "node:fs/promises";

/** 用法不对时的退出码（与「跑起来但失败了」区分开） */
const EXIT_USAGE = 2;

/** 运行期失败的退出码 */
const EXIT_FAILURE = 1;

const USAGE = `用法：
  agents-server [serve] [--port <端口>] [--local | --public] [--ai-zen-dir <目录>]
      前台启动服务。缺省是本地实例（只监听 127.0.0.1，凭证自动生成并写在 <数据根>/run/token）。

  agents-server token create [--note <备注>] [--ai-zen-dir <目录>]
      新建一串凭证。明文只显示这一次。
  agents-server token list [--ai-zen-dir <目录>]
      列出全部凭证（含已吊销的）。
  agents-server token revoke <凭证 id> [--ai-zen-dir <目录>]
      吊销一串凭证（已连上的连接不会被踢下线，吊销管的是「以后连不上」）。

  agents-server version
      打印服务端版本与协议版本。

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
  /** 本地实例（缺省）/ 对外实例 */
  local: boolean;
  aiZenDir?: string;
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

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    switch (arg) {
      case "-h":
      case "--help":
        parsed.command = "help";
        return parsed;
      case "--local":
        parsed.local = true;
        break;
      case "--public":
        parsed.local = false;
        break;
      case "--port": {
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError("--port 后面要跟一个端口号");
        parsed.port = parsePort(value);
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
  if (head === undefined) return parsed;

  if (head === "serve") {
    if (rest.length > 0) throw new UsageError(`serve 不接受多余的位置参数：${rest.join(" ")}`);
    parsed.command = "serve";
    return parsed;
  }
  if (head === "version") {
    if (rest.length > 0) throw new UsageError(`version 不接受位置参数：${rest.join(" ")}`);
    parsed.command = "version";
    return parsed;
  }
  if (head === "token") {
    const [action, ...tail] = rest;
    if (action === "create") {
      if (tail.length > 0) throw new UsageError(`token create 不接受位置参数：${tail.join(" ")}`);
      parsed.command = "token";
      parsed.action = "create";
      return parsed;
    }
    if (action === "list") {
      if (tail.length > 0) throw new UsageError(`token list 不接受位置参数：${tail.join(" ")}`);
      parsed.command = "token";
      parsed.action = "list";
      return parsed;
    }
    if (action === "revoke") {
      const id = tail[0];
      if (id === undefined) throw new UsageError("token revoke 后面要跟一个凭证 id");
      if (tail.length > 1) throw new UsageError(`token revoke 只接受一个 id：${tail.join(" ")}`);
      parsed.command = "token";
      parsed.action = "revoke";
      parsed.credentialId = id;
      return parsed;
    }
    throw new UsageError(`不认识的 token 动作：${action ?? "(空)"}（可用：create / list / revoke）`);
  }
  throw new UsageError(`不认识的命令：${head}`);
}

/** 端口：1..65535 的整数；写错就当场说，不静默回落到默认端口（R12 的口径） */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`端口要写成 1..65535 的整数，收到的是：${value}`);
  }
  return port;
}

/**
 * 开库做一件凭证相关的事（不启服务）。
 *
 * 与 `ServerApp` 用同一个库文件与同一套迁移：命令行建出来的凭证，起服务后立刻能用。
 */
async function withCredentials<T>(
  paths: ServerPaths,
  work: (credentials: CredentialService) => Promise<T>,
): Promise<T> {
  await mkdir(paths.dataRoot, { recursive: true });
  const db: DatabaseType = new Database(paths.dbFile);
  try {
    await migrate(db);
    return await work(new CredentialService({ credentials: new CredentialRepository(db) }));
  } finally {
    await db.close();
  }
}

/** `token create`：明文只在这里出现一次 */
async function runTokenCreate(paths: ServerPaths, note: string | undefined): Promise<void> {
  const result = await withCredentials(paths, (credentials) =>
    credentials.create({ note: note ?? "" }),
  );
  process.stdout.write(`凭证已创建（id: ${result.credential.id}）\n`);
  if (result.credential.note !== "") process.stdout.write(`备注：${result.credential.note}\n`);
  process.stdout.write(`\n${result.token}\n\n`);
  process.stdout.write("上面这串凭证只显示这一次：服务端此后只保存它的摘要，丢了只能重新创建。\n");
  process.stdout.write("把它分发给要连接这台服务端的设备，对方在握手时带上它即可。\n");
}

/** `token list`：连已吊销的一起列，吊销状态看最后一列 */
async function runTokenList(paths: ServerPaths): Promise<void> {
  const result = await withCredentials(paths, (credentials) => credentials.list());
  if (result.credentials.length === 0) {
    process.stdout.write("还没有任何凭证。用 `agents-server token create --note <备注>` 创建一串。\n");
    return;
  }
  for (const credential of result.credentials) {
    const state = credential.revokedAt === null ? "有效" : `已吊销（${credential.revokedAt}）`;
    process.stdout.write(
      `${credential.id}  ${state}  创建于 ${credential.createdAt}  ${credential.note}\n`,
    );
  }
}

/** `token revoke`：`revoked: false` 表示这串本来就已经吊销了（不是失败） */
async function runTokenRevoke(paths: ServerPaths, credentialId: string): Promise<void> {
  const result = await withCredentials(paths, (credentials) =>
    credentials.revoke({ credentialId }),
  );
  process.stdout.write(
    result.revoked
      ? `已吊销：${credentialId}\n`
      : `这串凭证本来就已吊销：${credentialId}\n`,
  );
}

/**
 * `serve`：前台起服务。
 *
 * 启动后打印三样东西：实际监听地址（端口可能是系统分配的）、发现文件、本地凭证交付文件路径
 * —— 客户端要连的就是前两个，本机免输凭证靠的是第三个（PRD A5 / architecture §2）。
 */
async function runServe(parsed: ParsedArgs): Promise<void> {
  const app = await createServer({
    aiZenDir: parsed.aiZenDir,
    port: parsed.port,
    local: parsed.local,
  });

  const target = await app.start();
  process.stdout.write(`服务端已启动：ws://${target.host}:${target.port}\n`);
  process.stdout.write(`版本：${app.version}（协议 ${PROTOCOL_VERSION}）\n`);
  process.stdout.write(`发现文件：${app.paths.serverFile}\n`);
  if (parsed.local) {
    process.stdout.write(`本地凭证交付文件：${app.paths.tokenFile}\n`);
  } else {
    process.stdout.write(
      "对外实例：用 `agents-server token create --note <备注>` 创建凭证，再分发给要连接的设备。\n",
    );
  }

  // 优雅退出：等收尾做完（摘发现文件、断连接、关库）再让进程走
  const stop = (): void => {
    void app.shutdown("requested");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** 版本：脚本里比对升级（PRD D4 / F-E3） */
function runVersion(): void {
  process.stdout.write(`@ai-zen/agents-server ${resolveServerVersion()}（协议 ${PROTOCOL_VERSION}）\n`);
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
}

// 本文件就是进程入口（`bin.agents-server` → `dist/cli.js`），不做「被 import 时不执行」的分支：
// 库里没有任何地方 import 它，带了那个分支只会在符号链接安装（`node_modules/.bin`）时静默失效。
void main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
});
