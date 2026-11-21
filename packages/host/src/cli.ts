#!/usr/bin/env node
import { join } from "node:path";

import { HostApp } from "./app.js";
import type { HostAppOpenOptions } from "./app.js";
import { openDatabase } from "./infra/db.js";
import { HostError } from "./infra/errors.js";
import { hostPaths, resolveDataRoot } from "./infra/paths.js";
import { resolveHostVersion } from "./infra/version.js";
import { CredentialService } from "./modules/credential/service.js";
import { credentialTable } from "./modules/credential/table.js";
import { createTranslator } from "./modules/i18n/index.js";

/**
 * 命令行的全部入口。
 *
 * 凭证的创建 / 列出 / 吊销只有这里：`credential.*` 已经从 wire 契约上撤掉，客户端只做「记住明文 +
 * 连接管理」，造凭证是宿主自己的管理动作。
 */

const DATA_ROOT_FLAG = "--ai-zen-dir";

const USAGE = [
  "Usage: agents-host [serve] [--port <n>] [--host <addr>] [--public] [--ai-zen-dir <dir>]",
  "       agents-host token create [--note <note>] [--ai-zen-dir <dir>]",
  "       agents-host token list [--ai-zen-dir <dir>]",
  "       agents-host token revoke <credential id> [--ai-zen-dir <dir>]",
  "       agents-host version",
  "       agents-host help",
].join("\n");

/** 出域的凭证行；类型从 `CredentialService` 推论，不为它去引 `types.ts` */
type ListedCredential = ReturnType<CredentialService["list"]>[number];

type ParsedCommand =
  | { readonly kind: "serve"; readonly options: HostAppOpenOptions }
  | { readonly kind: "token.create"; readonly note: string }
  | { readonly kind: "token.list" }
  | { readonly kind: "token.revoke"; readonly id: string }
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "invalid"; readonly message: string };

function invalid(message: string): ParsedCommand {
  return { kind: "invalid", message };
}

function parseArgs(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;

  // 不带子命令就是 `serve`：`agents-host --port 0` 与 `agents-host serve --port 0` 等价
  if (first === undefined) return { kind: "serve", options: { local: true } };

  if (first === "version" || first === "help") {
    if (rest.length > 0) return invalid(`Unexpected argument "${rest[0]}"`);
    return first === "version" ? { kind: "version" } : { kind: "help" };
  }

  if (first === "token") return parseTokenCommand(rest);
  if (first === "serve") return parseServeOptions(rest);
  if (first.startsWith("-")) return parseServeOptions(argv);

  return invalid(`Unknown command "${first}"`);
}

function parseTokenCommand(argv: readonly string[]): ParsedCommand {
  const [sub, ...rest] = argv;

  if (sub === "create") return parseTokenCreate(rest);
  if (sub === "list") return parseTokenList(rest);
  if (sub === "revoke") return parseTokenRevoke(rest);
  if (sub === undefined) {
    return invalid('Missing the token subcommand: expected "create", "list" or "revoke"');
  }

  return invalid(`Unknown token subcommand "${sub}"`);
}

function parseServeOptions(argv: readonly string[]): ParsedCommand {
  const stripped = takeDataRootOption(argv);
  if ("message" in stripped) return invalid(stripped.message);

  const options: { port?: number; host?: string; local: boolean } = { local: true };

  for (let index = 0; index < stripped.rest.length; index += 1) {
    const arg = stripped.rest[index];

    if (arg === "--port") {
      const value = stripped.rest.at(index + 1);
      if (value === undefined) return invalid('Missing value for "--port"');
      const port = parsePort(value);
      if (port === undefined) {
        return invalid(`Invalid port "${value}": expected an integer between 0 and 65535`);
      }
      options.port = port;
      index += 1;
      continue;
    }

    if (arg === "--host") {
      const value = stripped.rest.at(index + 1);
      if (value === undefined) return invalid('Missing value for "--host"');
      options.host = value;
      index += 1;
      continue;
    }

    if (arg === "--public") {
      options.local = false;
      continue;
    }

    return invalid(`Unknown option "${arg}"`);
  }

  return { kind: "serve", options };
}

function parseTokenCreate(argv: readonly string[]): ParsedCommand {
  const stripped = takeDataRootOption(argv);
  if ("message" in stripped) return invalid(stripped.message);

  let note = "";

  for (let index = 0; index < stripped.rest.length; index += 1) {
    const arg = stripped.rest[index];

    if (arg === "--note") {
      const value = stripped.rest.at(index + 1);
      if (value === undefined) return invalid('Missing value for "--note"');
      note = value;
      index += 1;
      continue;
    }

    return invalid(`Unknown option "${arg}"`);
  }

  return { kind: "token.create", note };
}

function parseTokenList(argv: readonly string[]): ParsedCommand {
  const stripped = takeDataRootOption(argv);
  if ("message" in stripped) return invalid(stripped.message);

  const extra = stripped.rest[0];
  if (extra !== undefined) return invalid(`Unexpected argument "${extra}"`);
  return { kind: "token.list" };
}

function parseTokenRevoke(argv: readonly string[]): ParsedCommand {
  const stripped = takeDataRootOption(argv);
  if ("message" in stripped) return invalid(stripped.message);

  const [id, ...rest] = stripped.rest;
  if (id === undefined) return invalid("Missing the credential id to revoke");
  if (rest.length > 0) return invalid(`Unexpected argument "${rest[0]}"`);
  return { kind: "token.revoke", id };
}

/**
 * 把 `--ai-zen-dir` 摘出来写进 `process.env.AI_ZEN_DIR`，其余的词按原序交回。
 *
 * 写进环境变量而不是另带一份值：数据根只有 `resolveDataRoot()` 一个读法，多一条并行路径就多一份
 * 会与它不一致的地方，`HostApp` 装配时那边读的也是环境变量。
 */
function takeDataRootOption(
  argv: readonly string[],
): { readonly rest: readonly string[] } | { readonly message: string } {
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg !== DATA_ROOT_FLAG) {
      rest.push(arg);
      continue;
    }

    const value = argv.at(index + 1);
    if (value === undefined) return { message: `Missing value for "${DATA_ROOT_FLAG}"` };
    process.env.AI_ZEN_DIR = value;
    index += 1;
  }

  return { rest };
}

/** 只接受纯十进制数字串：`Number("")` 是 `0`，`Number(" 12 ")` 是 `12`，两者都不是用户想要的端口 */
function parsePort(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}

async function runServe(options: HostAppOpenOptions): Promise<void> {
  const app = await HostApp.open(options);

  try {
    await app.start();
  } catch (error) {
    // 库与日志在装配时就打开了（绑端口发生在构造器里）。这里不先关掉它们，进程会因为还剩这些
    // 句柄而停在半路上，而端口没绑上时它本来没有别的事可做
    await app.stop().catch(() => undefined);
    throw error;
  }

  // 已有宿主在服务：这是正常结果 —— 那个进程还活着，本进程没有端口可绑，也没有凭证要交付
  if (!app.serving) {
    const { host, port } = app.address;
    process.stdout.write(`A host is already serving on ws://${host}:${port}\n`);
    await app.stop();
    return;
  }

  printServeReport(app);
  closeOnSignals(app);
}

/** 启动之后的报告：地址、版本、发现文件、日志目录，本机实例另给凭证交付文件 */
function printServeReport(app: HostApp): void {
  const paths = hostPaths(resolveDataRoot());
  const { host, port } = app.address;

  const lines = [
    `Listening on ws://${host}:${port}`,
    `Version: ${app.version}`,
    `Discovery file: ${paths.hostFile}`,
    `Logs: ${paths.logs}`,
  ];

  // 对外实例不写 `run/token`：那台机器的凭证只能由人当场造出来再分发给设备
  lines.push(
    app.local
      ? `Credential file: ${paths.tokenFile}`
      : 'Run "agents-host token create --note <note>" to mint a credential, then hand it to the device that connects',
  );

  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * `SIGINT` / `SIGTERM`：收尾之后再退出。
 *
 * 收尾之后仍然显式 `process.exit()`：`stop()` 关的是它自己开的那几样，进程里若还留着别的句柄，
 * 事件循环会继续空转，而这时已经没有任何要等的事。第二次信号不再触发第二遍收尾。
 */
function closeOnSignals(app: HostApp): void {
  let closing = false;

  const close = (): void => {
    if (closing) return;
    closing = true;
    void app.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${describeFailure(error)}\n`);
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

function runTokenCreate(note: string): void {
  withCredentials((credentials) => {
    const { credential, token } = credentials.create(note);

    const head = [`Credential: ${credential.id}`];
    if (note !== "") head.push(`Note: ${note}`);

    process.stdout.write(`${head.join("\n")}\n\n${token}\n\n`);
    process.stdout.write(
      "This token is shown only once; the store keeps only its SHA-256 digest\n",
    );
    process.stdout.write(
      "Hand it to the device that connects, as the token that device presents\n",
    );
  });
}

function runTokenList(): void {
  withCredentials((credentials) => {
    const rows = credentials.list();

    if (rows.length === 0) {
      process.stdout.write(
        'No credentials yet. Create one with "agents-host token create --note <note>"\n',
      );
      return;
    }

    process.stdout.write(`${rows.map(formatCredentialRow).join("\n")}\n`);
  });
}

function runTokenRevoke(id: string): void {
  withCredentials((credentials) => {
    // `revoke()` 的回值分不出这一次是不是头一次（重复吊销不刷新时间），要先看一眼之前的状态
    const before = credentials.list().find((row) => row.id === id);
    const revoked = credentials.revoke(id);

    process.stdout.write(`Revoked ${revoked.id}\n`);
    if (before !== undefined && before.revokedAt !== null) {
      process.stdout.write(`Already revoked at ${isoTime(before.revokedAt)}\n`);
    }
  });
}

function formatCredentialRow(row: ListedCredential): string {
  const status = row.revokedAt === null ? "valid" : `revoked (${isoTime(row.revokedAt)})`;
  return row.note === "" ? `${row.id}  ${status}` : `${row.id}  ${status}  ${row.note}`;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 三条 `token` 子命令共用的一次开库：它们不开服务、不绑端口，做完就关库。
 *
 * 语言写死英文：命令行输出面向运维，凭证那几句失败文案跟着同一档走。
 */
function withCredentials<T>(work: (credentials: CredentialService) => T): T {
  const db = openDatabase(hostPaths(resolveDataRoot()).databaseFile);

  try {
    const credentials = new CredentialService({
      credentials: credentialTable(db),
      t: createTranslator(() => "en"),
    });
    return work(credentials);
  } finally {
    db.close();
  }
}

/** `HostError` 的 `message` 已经是按语言渲染好的成品句子，不再包一层 */
function describeFailure(error: unknown): string {
  if (error instanceof HostError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === "invalid") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (parsed.kind === "version") {
    process.stdout.write(`@ai-zen/agents-host ${resolveHostVersion()}\n`);
    return;
  }

  try {
    switch (parsed.kind) {
      case "serve":
        await runServe(parsed.options);
        break;
      case "token.create":
        runTokenCreate(parsed.note);
        break;
      case "token.list":
        runTokenList();
        break;
      case "token.revoke":
        runTokenRevoke(parsed.id);
        break;
    }
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
}

// 这是 bin 的入口：进程一启动就跑 `main`。不需要「被 import 时不执行」的判断 —— 没有别的模块
// import 它，`HostApp` 在 `app.ts` 里，反过来也不引这里
void main();
