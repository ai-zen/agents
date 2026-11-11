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
 * （读发现文件 → `callOnce` 探活）是唯一可靠的"就绪"判据，`ping` 成功才算能用。
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ServerDescriptor } from "./wire/discovery.js";
import { readDescriptor } from "./wire/discovery.js";
import { callOnce } from "./wire/call-once.js";
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
    const client = await probe(connect, existing, deps.clientInfo);
    if (client) return { client, address: addressOf(existing), started: false };
  }

  const startServerProcess = deps.startServerProcess ?? spawnServerProcess;
  await startServerProcess({ aiZenDir: deps.aiZenDir });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(deps.aiZenDir);
    // 只认**新**的那个 pid：旧发现文件（进程已死）对应的端口不该被当成刚拉起的那个
    if (descriptor && descriptor.pid !== existing?.pid) {
      const client = await probe(connect, descriptor, deps.clientInfo);
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

/**
 * 探活 → 建连：先问一句 `ping`（`callOnce`，一次调用、问完挂断），通了再建那条长期连接。
 *
 * ## 为什么是两趟
 *
 * 「服务端活着吗」与「我该用哪条连接跟它说话」是两个问题：前者是**一次问话**（诊断、探活、
 * 收摊都只是问一句），后者是**一条资源**（在飞调用、事件通道、断开通知）。合成
 * 一趟（连上顺便 ping，不通就把这条连接扔掉）的话，每条失败路径都要记得 `close()`；
 * 而探活本身并不需要一条长连接。
 *
 * 多出来的成本只是本机一次短连接（握手两个往返），而轮询期间失败的那一趟会立刻返回
 * （服务端没起来时连 `connect` 都过不去），不会因为多一问变慢。
 */
async function probe(
  connect: (address: ServerAddress) => Promise<ServerClient>,
  descriptor: ServerDescriptor,
  clientInfo: ClientInfo,
): Promise<ServerClient | null> {
  try {
    await callOnce(addressOf(descriptor), "ping", undefined, {
      client: clientInfo,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    // 连不上 / ping 不通都只是「不在跑」，不抛错（探活的答案本来就是一个布尔）
    return null;
  }
  try {
    return await connect(addressOf(descriptor));
  } catch {
    // 探活之后到建连之间服务端没了：同样当「不在跑」，交给上层重试
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
  const child = spawn(
    process.execPath,
    [await serverEntryPath(), "serve", "--ai-zen-dir", aiZenDir],
    {
      detached: true,
      stdio: "ignore",
      // 显式传一遍：子进程不依赖"调用方的 env 恰好和发现目录一致"
      env: { ...process.env, AI_ZEN_DIR: aiZenDir },
    },
  );

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
 *
 * ## 这个解析依赖谁装了服务端包
 *
 * 本包的**运行期依赖**里没有 `@ai-zen/agents-server`（只有 `agents-core` 与
 * `agents-server/protocol` 的类型，运行期用自己的 wire 实现）。于是「拉起服务端」这条路径的
 * 前提是显式的：**宿主应用装了服务端包**（CLI / 桌面端都装了 —— 它们要那个 bin）。
 *
 * 这正是它的定位：`ensureServer` 是**部署策略**，不是分层。不想走这条路的应用可以把
 * `startServerProcess` 注入进来，那样连这个 `resolve` 都不会跑。
 *
 * 而「装了」有好有坏：npm 的扁平布局会把应用的依赖摊在顶层 `node_modules`，抬层解析找得到；
 * pnpm 的严格布局只给**声明过**的依赖建链接，所以本仓的 `packages/client` 把它列在
 * `devDependencies`（用例与本地运行要它），发布出去的消费者则要靠自己的依赖声明。
 */
async function serverEntryPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@ai-zen/agents-server/package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
    bin?: Record<string, string>;
  };
  const bin = pkg.bin?.["agents-server"];
  if (!bin) throw new Error("@ai-zen/agents-server 的 package.json 里没有 bin.agents-server");
  return join(dirname(packageJsonPath), bin);
}
