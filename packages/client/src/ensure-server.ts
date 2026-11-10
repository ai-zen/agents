/**
 * 确保有一个能连的服务端：**有就上，没有就拉一个**。
 *
 * 名字用 `ensure` 而不是 `start` / `get`：多数时候它什么都没做（发现文件里有活着的
 * 服务端，连上就走），只在没有时才 spawn 一个 detached 子进程。
 *
 * ## 为什么只认发现文件，不认端口
 *
 * 端口可能被占（服务端会退回系统分配的临时端口），也可能根本没人监听（上次崩了）。
 * 唯一真相源是 `<aiZenDir>/run/server.json`；它过期了（pid 已死）就交给服务端的
 * `serve` 自己收掉 —— 单实例判断只在服务端做一份，客户端不重复实现。
 *
 * ## 为什么拉起之后要轮询
 *
 * detached 子进程的启动是异步的：spawn 返回 ≠ 端口在监听 ≠ 发现文件已写。轮询
 * （读发现文件 → 连 → `ping`）是唯一可靠的"就绪"判据，`ping` 成功才算能用。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  DAEMON_METHODS,
  readDescriptor,
  type ServerDescriptor,
} from "@ai-zen/agents-server/protocol";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo, ServerAddress, ServerClient } from "./types.js";

export interface EnsureServerDeps {
  /** 配置根目录（`AI_ZEN_DIR`）。**注入**：本模块不读进程级全局，便于测试换目录 */
  aiZenDir: string;
  clientInfo: ClientInfo;
  /** 拉起服务端进程；默认 spawn 一个 detached 的 `agents-server serve` */
  startServerProcess?: (deps: { aiZenDir: string }) => Promise<void>;
  /** 建连 + 握手；默认 {@link SocketServerClient.connect} */
  connect?: (address: ServerAddress) => Promise<ServerClient>;
  /** 轮询间隔的等待；注入出来是为了让超时用例不用真等 */
  waitBeforeRetry?: (ms: number) => Promise<void>;
  /** 拉起后多久还连不上就放弃 */
  timeoutMs?: number;
  retryIntervalMs?: number;
}

export interface EnsureServerResult {
  client: ServerClient;
  address: ServerAddress;
  /** `true` = 本次调用拉起了新进程；`false` = 连上的是已在跑的那个 */
  started: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;
/** 探活调用的时限：本机 ping 不该慢；慢就是有问题，别把整体超时耗光 */
const PROBE_TIMEOUT_MS = 1000;

export async function ensureServer(deps: EnsureServerDeps): Promise<EnsureServerResult> {
  const connect =
    deps.connect ??
    ((address: ServerAddress) => SocketServerClient.connect({ address, client: deps.clientInfo }));
  const waitBeforeRetry =
    deps.waitBeforeRetry ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  const existing = await readDescriptor(deps.aiZenDir);
  if (existing) {
    const client = await probe(connect, existing);
    if (client) return { client, address: addressOf(existing), started: false };
  }

  const startServerProcess = deps.startServerProcess ?? spawnServerProcess;
  await startServerProcess({ aiZenDir: deps.aiZenDir });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(deps.aiZenDir);
    // 只认**新**的那个 pid：旧发现文件（进程已死）对应的端口不该被当成刚拉起的那个
    if (descriptor && descriptor.pid !== existing?.pid) {
      const client = await probe(connect, descriptor);
      if (client) return { client, address: addressOf(descriptor), started: true };
    }
    await waitBeforeRetry(retryIntervalMs);
  }

  throw new Error(
    `server did not become reachable within ${timeoutMs}ms ` +
      `(log: ${join(deps.aiZenDir, "logs", "server.log")})`,
  );
}

function addressOf(descriptor: ServerDescriptor): ServerAddress {
  return { host: descriptor.host, port: descriptor.port };
}

/** 连上并 ping 一次；连不上 / ping 不通都返回 `null`（"不在跑"），不抛错 */
async function probe(
  connect: (address: ServerAddress) => Promise<ServerClient>,
  descriptor: ServerDescriptor,
): Promise<ServerClient | null> {
  let client: ServerClient | null = null;
  try {
    client = await connect(addressOf(descriptor));
    await client.call(DAEMON_METHODS.ping, undefined, { timeoutMs: PROBE_TIMEOUT_MS });
    return client;
  } catch {
    client?.close();
    return null;
  }
}

/**
 * 拉起一个 detached 的服务端进程。
 *
 * `stdio: "ignore"`：子进程的日志由它自己写 `<aiZenDir>/logs/server.log`，绝不能把
 * 输出混进客户端终端（TUI 是全屏渲染，任何一行都会把界面打花）。
 * 等 `spawn` 事件而不是直接返回：可执行文件找不到这类错误当场报，不用等满 10s 超时。
 */
async function spawnServerProcess({ aiZenDir }: { aiZenDir: string }): Promise<void> {
  const child = spawn(process.execPath, [serverEntryPath(), "serve", "--ai-zen-dir", aiZenDir], {
    detached: true,
    stdio: "ignore",
    // 显式传一遍：子进程不依赖"调用方的 env 恰好和发现目录一致"
    env: { ...process.env, AI_ZEN_DIR: aiZenDir },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}

/**
 * 服务端 bin 的落盘路径 —— **从它自己的 `package.json` 里读 `bin`**。
 *
 * 不在这里写死 `dist/cli.js`：dist 布局是服务端的实现细节，写死等于把两仓的目录结构
 * 焊在一起（它哪天改 bundler，这边就得跟着改，而类型系统不会提醒）。
 */
function serverEntryPath(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@ai-zen/agents-server/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    bin?: Record<string, string>;
  };
  const bin = pkg.bin?.["agents-server"];
  if (!bin) throw new Error("@ai-zen/agents-server 的 package.json 里没有 bin.agents-server");
  return join(dirname(packageJsonPath), bin);
}
