/**
 * `ensureServer` 的验收：有就上、没有就拉一个、**给了显式地址就只连**。
 *
 * spawn 与文件读取都注入成假的，所以这里既不真起进程、也不真读盘；「拉起 → 轮询 → 就绪」这条链
 * 用一个手摇的时钟（`sleep` 推进 `now`）走完，不必真等 15 秒。
 */

import { describe, expect, it } from "vitest";

import type { ClientInfo } from "@ai-zen/agents-server";

import type { Client, ClientOptions } from "./client.js";
import {
  ensureServer,
  readServerFile,
  resolveDataRoot,
  serverFilePath,
  tokenFilePath,
  type EnsureServerOptions,
  type SpawnServerContext,
} from "./connection.js";
import { fromServerError, localError, type ClientError } from "./errors.js";

const DATA_ROOT = "/data/ai-zen";
const CLIENT_INFO: ClientInfo = { name: "test-client", version: "0.0.0-test" };
const SERVER_FILE = serverFilePath(DATA_ROOT);
const TOKEN_FILE = tokenFilePath(DATA_ROOT);

/** 假客户端的标记（只有 `endpoint` 在这几条用例里被看） */
function fakeClient(endpoint: string): Client {
  return { endpoint } as unknown as Client;
}

interface ScheduledFile {
  content: string;
  /** 到这个 tick 才出现（模拟「刚拉起的服务端还没写完文件」） */
  fromTick: number;
}

interface HarnessResult {
  options: EnsureServerOptions;
  spawned: SpawnServerContext[];
  connects: ClientOptions[];
  /** 推进手摇时钟（`sleep` 被调用一次就 +1） */
  tick(): number;
}

/** 造一套「假文件系统 + 假 spawn + 假建连」，按脚本回答 */
function harness(config: {
  settings?: EnsureServerOptions["settings"];
  files?: Record<string, ScheduledFile>;
  serverFile?: { pid: number; host: string; port: number; fromTick: number };
  token?: { value: string; fromTick: number };
  /** 建连脚本：返回 `null` 表示「现在连不上」，返回 `"unauthorized"` 表示「服务端拒了」 */
  onConnect?: (
    options: ClientOptions,
  ) =>
    { ok: true } | { ok: false; code: "server_unavailable" } | { ok: false; code: "unauthorized" };
  /** spawn 时做什么（缺省什么都不做） */
  onSpawn?: (context: SpawnServerContext, files: Map<string, ScheduledFile>) => void;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): HarnessResult {
  const files = new Map<string, ScheduledFile>(Object.entries(config.files ?? {}));
  if (config.serverFile) {
    files.set(SERVER_FILE, {
      content: JSON.stringify({
        pid: config.serverFile.pid,
        host: config.serverFile.host,
        port: config.serverFile.port,
      }),
      fromTick: config.serverFile.fromTick,
    });
  }
  if (config.token) {
    files.set(TOKEN_FILE, { content: `${config.token.value}\n`, fromTick: config.token.fromTick });
  }

  let ticks = 0;
  let clock = 0;
  const spawned: SpawnServerContext[] = [];
  const connects: ClientOptions[] = [];

  const options: EnsureServerOptions = {
    dataRoot: DATA_ROOT,
    clientInfo: CLIENT_INFO,
    ...(config.settings ? { settings: config.settings } : {}),
    serverEntry: "/server/dist/cli.js",
    timeoutMs: config.timeoutMs ?? 1_000,
    retryIntervalMs: config.retryIntervalMs ?? 100,
    readTextFile: async (path) => {
      const file = files.get(path);
      return file && ticks >= file.fromTick ? file.content : null;
    },
    sleep: async (ms) => {
      ticks += 1;
      clock += ms;
    },
    now: () => clock,
    spawnServer: async (context) => {
      spawned.push(context);
      config.onSpawn?.(context, files);
    },
    connect: async (connectOptions) => {
      connects.push(connectOptions);
      const outcome = config.onConnect?.(connectOptions) ?? { ok: true };
      if (!outcome.ok) {
        // 两种失败分开造：连不上是本地码，被拒是服务端回的业务错误
        throw outcome.code === "unauthorized"
          ? fromServerError({
              code: -32001,
              message: "凭证没被接受",
              data: { code: "unauthorized", message: "凭证没被接受", params: {} },
            })
          : localError("server_unavailable", { params: { endpoint: "x" } });
      }
      return fakeClient(
        `${connectOptions.target && typeof connectOptions.target === "object" ? connectOptions.target.port : "?"}`,
      );
    },
  };

  return { options, spawned, connects, tick: () => ticks };
}

describe("显式地址：只连，绝不拉起", () => {
  it("连上了就直接用（不读发现文件、不 spawn）", async () => {
    const test = harness({
      settings: {
        mode: "remote",
        url: "wss://example.test/ai-zen",
        token: "remote-token",
        language: "zh",
      },
      // 本机有一份「活着的」发现文件：显式地址这条路不该看它
      serverFile: { pid: 111, host: "127.0.0.1", port: 8790, fromTick: 0 },
    });

    const result = await ensureServer(test.options);

    expect(result.explicit).toBe(true);
    expect(result.started).toBe(false);
    expect(test.spawned).toEqual([]);
    expect(test.connects).toHaveLength(1);
    expect(test.connects[0]).toMatchObject({
      target: { host: "example.test", port: 443, secure: true, path: "/ai-zen" },
      token: "remote-token",
      language: "zh",
      clientInfo: CLIENT_INFO,
    });
  });

  it("连不上就报连不上（不会改成「拉起一个」）", async () => {
    const test = harness({
      settings: { mode: "remote", url: "ws://10.0.0.5:8790", token: "t" },
      onConnect: () => ({ ok: false, code: "server_unavailable" }),
    });

    const error = (await ensureServer(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;
    expect(error.code).toBe("server_unavailable");
    expect(error.detail).toMatchObject({ host: "10.0.0.5", port: 8790, explicit: true });
    expect(test.spawned).toEqual([]);
  });

  it("服务端拒了凭证：那句话原样抛出去，不折成「起不来」", async () => {
    const test = harness({
      settings: { mode: "remote", url: "ws://10.0.0.5:8790", token: "wrong" },
      onConnect: () => ({ ok: false, code: "unauthorized" }),
    });

    const error = (await ensureServer(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;
    // `unauthorized` 是「这样不行」（服务端在、话也说了），不是「现在不行」
    expect(error.code).toBe("unauthorized");
    expect(test.spawned).toEqual([]);
  });

  it("显式地址指向本机且没给凭证时，用本机 run/token", async () => {
    const test = harness({
      settings: { mode: "remote", url: "ws://127.0.0.1:8790" },
      token: { value: "local-token", fromTick: 0 },
    });

    await ensureServer(test.options);
    expect(test.connects[0]?.token).toBe("local-token");
  });

  it("显式地址在远端且没给凭证时，不去翻本机那串", async () => {
    const test = harness({
      settings: { mode: "remote", url: "wss://example.test/ai-zen" },
      token: { value: "local-token", fromTick: 0 },
    });

    await ensureServer(test.options);
    expect(test.connects[0]?.token).toBe("");
  });
});

describe("本机：有就上", () => {
  it("发现文件里的实例还活着：直接连上，不拉起", async () => {
    const test = harness({
      settings: { mode: "local" },
      serverFile: { pid: 111, host: "127.0.0.1", port: 8790, fromTick: 0 },
      token: { value: "tok", fromTick: 0 },
    });

    const result = await ensureServer(test.options);

    expect(result.started).toBe(false);
    expect(result.explicit).toBe(false);
    expect(result.target).toEqual({ host: "127.0.0.1", port: 8790 });
    expect(result.dataRoot).toBe(DATA_ROOT);
    expect(test.spawned).toEqual([]);
  });
});

describe("本机：没有就拉一个", () => {
  it("拉起 → 轮询 → 就绪（凭证在拉起之后才写出来，所以每一轮都重读）", async () => {
    const test = harness({
      settings: { mode: "local" },
      // 本机还没有任何文件：发现文件与凭证都由刚拉起的那个进程写
      onSpawn: (_context, files) => {
        files.set(SERVER_FILE, {
          content: JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 54321 }),
          fromTick: 1,
        });
        files.set(TOKEN_FILE, { content: "fresh-token\n", fromTick: 2 });
      },
      // 没有凭证时服务端不会认（这一轮算「还没就绪」）
      onConnect: (options) =>
        options.token === "" ? { ok: false, code: "server_unavailable" } : { ok: true },
    });

    const result = await ensureServer(test.options);

    expect(test.spawned).toEqual([{ dataRoot: DATA_ROOT, entry: "/server/dist/cli.js" }]);
    expect(result.started).toBe(true);
    expect(result.target).toEqual({ host: "127.0.0.1", port: 54321 });
    // 第一轮没有凭证、第二轮拿到刚写出来的那串
    expect(test.connects.map((connect) => connect.token)).toEqual(["", "fresh-token"]);
  });

  it("只认新 pid：旧发现文件（进程已死）的端口不算「刚拉起的那个」", async () => {
    const test = harness({
      settings: { mode: "local" },
      serverFile: { pid: 111, host: "127.0.0.1", port: 8790, fromTick: 0 },
      token: { value: "tok", fromTick: 0 },
      // 旧 pid 那个端口没人应答
      onConnect: (options) =>
        options.target && typeof options.target === "object" && options.target.port === 8790
          ? { ok: false, code: "server_unavailable" }
          : { ok: true },
      onSpawn: (_context, files) => {
        files.set(SERVER_FILE, {
          content: JSON.stringify({ pid: 222, host: "127.0.0.1", port: 6000 }),
          fromTick: 1,
        });
      },
    });

    const result = await ensureServer(test.options);
    expect(result.started).toBe(true);
    expect(result.target.port).toBe(6000);
  });

  it("到时限还没就绪：报 server_did_not_start，并指出日志在哪", async () => {
    const test = harness({ settings: { mode: "local" }, timeoutMs: 300 });

    const error = (await ensureServer(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;
    expect(error.code).toBe("server_did_not_start");
    expect(error.detail).toMatchObject({
      dataRoot: DATA_ROOT,
      logFile: `${DATA_ROOT}/logs/server.log`,
    });
    expect(test.spawned).toHaveLength(1);
  });
});

describe("本地事实的读法", () => {
  it("发现文件坏了就当没有（不拦住「拉一个新的」）", async () => {
    const facts = await readServerFile(DATA_ROOT, async () => "{ 半个 JSON");
    expect(facts).toBeNull();
  });

  it("数据根：显式 > 环境变量 > 用户目录", () => {
    const previous = process.env.AI_ZEN_DIR;
    try {
      process.env.AI_ZEN_DIR = "/from-env";
      expect(resolveDataRoot("/explicit")).toBe("/explicit");
      expect(resolveDataRoot()).toBe("/from-env");
      delete process.env.AI_ZEN_DIR;
      expect(resolveDataRoot()).toMatch(/\.ai-zen$/);
    } finally {
      if (previous === undefined) delete process.env.AI_ZEN_DIR;
      else process.env.AI_ZEN_DIR = previous;
    }
  });
});
