/**
 * 确保有一个能连的服务端：**有就上，没有就拉一个**。
 *
 * 名字用 `ensure` 而不是 `start` / `get`：多数时候它什么都没做（发现文件里有活着的
 * 服务端，连上就走），只在没有时才 spawn 一个 detached 子进程。
 *
 * ## 两条路：显式地址，或者发现文件
 *
 * 给了显式地址（`--server` / `AI_ZEN_SERVER_URL`）就**只连、绝不拉起**（D10）：本地 `npx` 起的
 * 进程一定不在那个地址上，拉起只会白等满 10 秒，然后报一个指向错误方向的超时。
 * 没给才走「读发现文件 → 探活 → 拉起 → 轮询」这条老路。
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
 *
 * ## 凭证：每一步都带（D9）
 *
 * 探活那一次问话与之后那条长连接**都要**带 token —— 只给其中一条，症状是「探活说不行、于是拉
 * 起一个、拉起之后还是连不上」：一条路被鉴权挡住了，而错误信息把它报成「服务端起不来」。
 * 凭证从哪来只由 `resolve-target.ts` 决定（显式凭证 > `<aiZenDir>/run/token`），这里只负责把
 * 它递给每一个出口。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ServerDescriptor } from "./wire/discovery.js";
import { readDescriptor } from "./wire/discovery.js";
import { callOnce } from "./wire/call-once.js";
import { SocketServerClient } from "./socket-server-client.js";
import type { ServerTarget } from "./wire/server-url.js";
import type { ClientInfo, ServerAddress, ServerClient } from "./types.js";
import { codeOf } from "./wire/errors.js";
import type { TokenSource } from "./resolve-target.js";
import { explainUnauthorized, readExplicitTarget, resolveToken } from "./resolve-target.js";

export interface EnsureServerDeps {
  /** 配置根目录（`AI_ZEN_DIR`）。**注入**：本模块不读进程级全局，便于测试换目录 */
  aiZenDir: string;
  clientInfo: ClientInfo;
  /** 显式地址（`--server` / `AI_ZEN_SERVER_URL`）：给了就**只连、绝不拉起**（D10） */
  serverUrl?: string;
  /** 显式凭证（`AI_ZEN_SERVER_TOKEN`）；没给（或只有空白）就退回 `<aiZenDir>/run/token`（D9） */
  serverToken?: string;
  /** 拉起服务端进程；默认用 `npx` 拉一个 detached 的 `agents-server serve` */
  startServerProcess?: (deps: { aiZenDir: string }) => Promise<void>;
  /**
   * 默认拉起时用的包名，交给 `npx` 解析（默认 `@ai-zen/agents-server`）。
   *
   * 预发布版本通常没有 `latest` 标签，直接给裸包名会让 `npx` 报 notarget ——
   * 所以宿主应该传带版本号的 `@scope/name@x.y.z`。
   */
  serverPackage?: string;
  /**
   * 建连 + 握手；默认 {@link SocketServerClient.connect}。
   *
   * 第二个参数是这次要用的凭证（可能为 `undefined`，即「没有凭证」）：不传的话宿主注入的那条
   * `connect` 就会自己发一个空串 `token`，于是「探活能过、长连接被拒」这种错只能靠猜。
   * 只写一个参数 `(address) => …` 的实现照样可用（少写一个形参在 TypeScript 里是兼容的）。
   */
  connect?: (address: ServerAddress, token?: string) => Promise<ServerClient>;
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
  /**
   * `true` = 这次连的是**显式地址**：没读发现文件、也没拉起（D10 的证据）。
   *
   * 宿主会用它决定提示语与后续动作（例如「连的是远端，本地那一份进程与这次会话无关」），
   * 而这件事从 `started` 上看不出来 —— 显式地址那条路里 `started` 恒为 `false`，
   * 与「发现文件里那个正好活着」撞在同一个值上。
   */
  explicit: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;
/** 探活调用的时限：本机 ping 不该慢；慢就是有问题，别把整体超时耗光 */
const PROBE_TIMEOUT_MS = 1000;

export async function ensureServer(deps: EnsureServerDeps): Promise<EnsureServerResult> {
  const connect =
    deps.connect ??
    ((address: ServerAddress, token?: string) =>
      SocketServerClient.connect({ address, client: deps.clientInfo, token }));
  const waitBeforeRetry =
    deps.waitBeforeRetry ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  const source = {
    aiZenDir: deps.aiZenDir,
    serverUrl: deps.serverUrl,
    serverToken: deps.serverToken,
  };

  // ---- 显式地址：只连、绝不拉起 --------------------------------------
  const explicit = readExplicitTarget(source);
  if (explicit) {
    // `source: tokenSource` 而不是 `fromLocalFile`：那两者是**三种**情形（显式凭证 / 本地文件 /
    // 没有凭证），布尔说了不算 —— 「显式地址 + 本机没有凭证」从前因此得到「重启服务端」那句话
    const { token, source: tokenSource } = await resolveToken(source);
    try {
      const client = await connect(explicit.address, token ?? undefined);
      return { client, address: explicit.address, started: false, explicit: true };
    } catch (error) {
      throw unreachableExplicit(explicit.address, error, tokenSource, {
        aiZenDir: deps.aiZenDir,
        serverUrl: deps.serverUrl,
      });
    }
  }

  // ---- 发现文件那条路（每一步都带着同一个 token）-----------------------
  const existing = await readDescriptor(deps.aiZenDir);
  if (existing) {
    const { token } = await resolveToken(source);
    const client = await probe(connect, existing, deps.clientInfo, token);
    if (client) {
      return { client, address: addressOf(existing), started: false, explicit: false };
    }
  }

  const startServerProcess =
    deps.startServerProcess ??
    ((args: { aiZenDir: string }) =>
      spawnServerProcess({
        aiZenDir: args.aiZenDir,
        serverPackage: deps.serverPackage ?? DEFAULT_SERVER_PACKAGE,
      }));
  await startServerProcess({ aiZenDir: deps.aiZenDir });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(deps.aiZenDir);
    // 只认**新**的那个 pid：旧发现文件（进程已死）对应的端口不该被当成刚拉起的那个
    if (descriptor && descriptor.pid !== existing?.pid) {
      // 凭证**每一轮重读**：刚拉起的服务端在那期间才生成 `<aiZenDir>/run/token`（这台机器上
      // 第一次跑时它压根不存在）。只在上面的 spawn 之前读一次的话，第一次能拉起、却永远连不
      // 上 —— 而错误会指向「服务端起不来」，指向完全错误的方向。
      const { token } = await resolveToken(source);
      const client = await probe(connect, descriptor, deps.clientInfo, token);
      if (client) {
        return { client, address: addressOf(descriptor), started: true, explicit: false };
      }
    }
    await waitBeforeRetry(retryIntervalMs);
  }

  throw new Error(
    `server did not become reachable within ${timeoutMs}ms ` +
      `(log: ${join(deps.aiZenDir, "logs", "server.log")})`,
  );
}

/**
 * 显式地址连不上时的错误：**带上地址**，并把 `unauthorized` 翻成对症的那句话。
 *
 * 为什么要在这里再包一层（而 `explainUnauthorized` 自己不改原对象）：这一支的调用方需要的是
 * 「哪条路失败了 + 为什么」两半。地址那一半只有这里有（`connect` 的错误消息里有时有、有时没有
 * —— `ECONNREFUSED` 那一路有端点，握手失败那一路只有服务端的文案）。
 *
 * `aiZenDir` 一并递下去：那句提示里的凭证路径要印**真路径**而不是占位符（理由写在
 * `explainUnauthorized` 的文件注释里）—— 而 `aiZenDir` 只有这一层知道（它是注入的配置根）。
 *
 * `tokenSource` 也一并递下去：凭证是显式给的、来自本地文件、还是压根没有，对应三句完全不同的
 * 话（尤其「没有凭证」那支唯一该说的一句话是去设 `AI_ZEN_SERVER_TOKEN`，不是重启服务端）。
 */
function unreachableExplicit(
  address: ServerTarget,
  error: unknown,
  tokenSource: TokenSource,
  ctx: { aiZenDir: string; serverUrl?: string },
): Error {
  const explained = explainUnauthorized(error, {
    explicit: true,
    source: tokenSource,
    aiZenDir: ctx.aiZenDir,
    serverUrl: ctx.serverUrl,
  });
  const at = `${address.host}:${address.port}`;
  const failure = new Error(
    `连不上显式指定的服务端 ${at}（有显式地址时不会拉起本地服务端）：${explained.message}`,
  );
  // 码留着：鉴权失败与「端口上没人」对宿主的处置完全不同（改凭证 vs 改地址）
  const code = codeOf(explained);
  if (code) Object.assign(failure, { code });
  return failure;
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
 *
 * 两趟**用同一个 token**：只给一趟的写法会让「探活过了、建连被拒」永远只在日志里出现一次
 * `unauthorized`，而外面看到的是「服务端起不来」。
 */
async function probe(
  connect: (address: ServerAddress, token?: string) => Promise<ServerClient>,
  descriptor: ServerDescriptor,
  clientInfo: ClientInfo,
  token: string | null,
): Promise<ServerClient | null> {
  try {
    await callOnce(addressOf(descriptor), "ping", undefined, {
      client: clientInfo,
      timeoutMs: PROBE_TIMEOUT_MS,
      token: token ?? undefined,
    });
  } catch {
    // 连不上 / ping 不通都只是「不在跑」，不抛错（探活的答案本来就是一个布尔）
    return null;
  }
  try {
    return await connect(addressOf(descriptor), token ?? undefined);
  } catch {
    // 探活之后到建连之间服务端没了：同样当「不在跑」，交给上层重试
    return null;
  }
}

/** 默认拉起的服务端包（宿主可用 `serverPackage` 换成带版本号的） */
const DEFAULT_SERVER_PACKAGE = "@ai-zen/agents-server";

/**
 * 真正的那一句 `spawn`：两个平台各一条路，**都不传 args 数组 + `shell: true`**。
 *
 * 为什么 Windows 上要自己把命令拼成一个字符串：`npx` 在那里是 `npx.cmd`，不经 cmd.exe
 * 起不来，所以必须有 shell —— 而「`shell: true` + args 数组」是 Node 明确标了弃用的形状
 * （DEP0190：args 不转义，只做拼接）。症状不是崩溃，是一句 `DeprecationWarning` 写进
 * **调用方**的 stderr —— 而 stdio 模式的契约是「成功那一轮 stderr 一个字都没有」，
 * e2e 直接断言 `stderr === ""`，于是这条警告会把每次 `ai "…"` 变成一个噪声源。
 *
 * 自己拼就自己负责转义：这条命令行里唯一的变量是目录，引一次即可（包坐标是发布策略，
 * 由宿主给常量）。POSIX 那条路不变：`npx` 本身就是可执行文件，没有 shell 可言。
 */
function spawnServerChild(serverPackage: string, aiZenDir: string) {
  // 显式传一遍：子进程不依赖「调用方的 env 恰好和发现目录一致」
  const env = { ...process.env, AI_ZEN_DIR: aiZenDir };
  const options = { detached: true, stdio: "ignore" as const, env };
  if (process.platform === "win32") {
    return spawn(`npx -y ${serverPackage} serve --ai-zen-dir "${aiZenDir}"`, {
      ...options,
      shell: true,
    });
  }
  return spawn("npx", ["-y", serverPackage, "serve", "--ai-zen-dir", aiZenDir], options);
}

/**
 * 用 `npx` 拉起一个 detached 的服务端进程。
 *
 * ## 为什么是 npx，而不是「解析已装的那个 bin」
 *
 * `ensureServer` 是**部署策略**，不是分层：它要回答的是「这台机器上还没有服务端，
 * 弄一个来」。让宿主预先装好 `@ai-zen/agents-server` 是一种做法，但那样客户端就把
 * 「服务端怎么装」焊进了自己的依赖表——而打包后的 CLI 根本没有 `node_modules` 可解析。
 * `npx` 按需下载再启动，宿主的依赖表里就不需要这一项。
 *
 * 版本由宿主的 `serverPackage` 决定：预发布版本的包通常没有 `latest` 标签，裸包名
 * 会让 `npx` 报 notarget。
 *
 * `stdio: "ignore"`：子进程的日志由它自己写 `<aiZenDir>/logs/server.log`，绝不能把
 * 输出混进客户端终端（TUI 是全屏渲染，任何一行都会把界面打花）。
 * 等 `spawn` 事件而不是直接返回：`npx` 找不到这类错误当场报，不用等满 10s 超时。
 *
 * 用 `npx` 起的那个进程会在自己的 `start()` 里**读或生成**凭证（`<aiZenDir>/run/token`）——
 * 所以这里不需要、也不许把凭证塞进命令行：那一串会进 `ps` 输出。
 */
async function spawnServerProcess({
  aiZenDir,
  serverPackage,
}: {
  aiZenDir: string;
  serverPackage: string;
}): Promise<void> {
  const child = spawnServerChild(serverPackage, aiZenDir);

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}
