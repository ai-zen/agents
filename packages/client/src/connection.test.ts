/**
 * `ensureHost` 的验收：有就上、没有就拉一个、**给了显式地址就只连**。
 *
 * spawn 与文件读取都注入成假的，所以这里既不真起进程、也不真读盘；「拉起 → 轮询 → 就绪」这条链
 * 用一个手摇的时钟（`sleep` 推进 `now`）走完，不必真等 15 秒。
 *
 * 拉起那两条路（给了 `entry` / 没给而走 npx）在最后两组里单独验：那两组要把子进程也换成假的
 * （`SpawnDeps.spawn`），否则会真的去联网拉一个包。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ClientInfo } from "@ai-zen/agents-host";

import type { Client, ClientOptions } from "./client.js";
import {
  ensureHost,
  npxHostArgv,
  readHostFile,
  resolveDataRoot,
  hostFilePath,
  spawnHostByContext,
  spawnHostViaNpx,
  tokenFilePath,
  type EnsureHostOptions,
  type HostLaunchStage,
  type SpawnDeps,
  type SpawnHostContext,
} from "./connection.js";
import { fromHostError, localError, type ClientError } from "./errors.js";

const DATA_ROOT = "/data/ai-zen";
const CLIENT_INFO: ClientInfo = { name: "test-client", version: "0.0.0-test" };

/**
 * 拉起日志的落点由**调用方**给，所以用例自己定一个（CLI 那边给的是 `<数据根>/logs/cli/launch.log`）。
 * 本包不再有「按数据根推出来」的那个函数。
 */
function launchLogOf(dataRoot: string): string {
  return join(dataRoot, "logs", "cli", "launch.log");
}
const HOST_FILE = hostFilePath(DATA_ROOT);
const TOKEN_FILE = tokenFilePath(DATA_ROOT);

/** 假客户端的标记（只有 `endpoint` 在这几条用例里被看） */
function fakeClient(endpoint: string): Client {
  return { endpoint } as unknown as Client;
}

interface ScheduledFile {
  content: string;
  /** 到这个 tick 才出现（模拟「刚拉起的宿主还没写完文件」） */
  fromTick: number;
}

interface HarnessResult {
  options: EnsureHostOptions;
  spawned: SpawnHostContext[];
  connects: ClientOptions[];
  /** 推进手摇时钟（`sleep` 被调用一次就 +1） */
  tick(): number;
}

/** 造一套「假文件系统 + 假 spawn + 假建连」，按脚本回答 */
function harness(config: {
  settings?: EnsureHostOptions["settings"];
  files?: Record<string, ScheduledFile>;
  hostFile?: { pid: number; host: string; port: number; fromTick: number };
  token?: { value: string; fromTick: number };
  /** 建连脚本：返回 `null` 表示「现在连不上」，返回 `"unauthorized"` 表示「宿主拒了」 */
  onConnect?: (
    options: ClientOptions,
  ) => { ok: true } | { ok: false; code: "host_unavailable" } | { ok: false; code: "unauthorized" };
  /** spawn 时做什么（缺省什么都不做） */
  onSpawn?: (context: SpawnHostContext, files: Map<string, ScheduledFile>) => void;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): HarnessResult {
  const files = new Map<string, ScheduledFile>(Object.entries(config.files ?? {}));
  if (config.hostFile) {
    files.set(HOST_FILE, {
      content: JSON.stringify({
        pid: config.hostFile.pid,
        host: config.hostFile.host,
        port: config.hostFile.port,
      }),
      fromTick: config.hostFile.fromTick,
    });
  }
  if (config.token) {
    files.set(TOKEN_FILE, { content: `${config.token.value}\n`, fromTick: config.token.fromTick });
  }

  let ticks = 0;
  let clock = 0;
  const spawned: SpawnHostContext[] = [];
  const connects: ClientOptions[] = [];

  const options: EnsureHostOptions = {
    dataRoot: DATA_ROOT,
    launchLog: launchLogOf(DATA_ROOT),
    clientInfo: CLIENT_INFO,
    ...(config.settings ? { settings: config.settings } : {}),
    hostEntry: "/host/dist/cli.js",
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
    spawnHost: async (context) => {
      spawned.push(context);
      // 缺省的拉起方式（npx）先报这两步：假件照着报，好让用例断言整条顺序
      context.onStage?.("resolving");
      context.onStage?.("installing");
      config.onSpawn?.(context, files);
    },
    connect: async (connectOptions) => {
      connects.push(connectOptions);
      const outcome = config.onConnect?.(connectOptions) ?? { ok: true };
      if (!outcome.ok) {
        // 两种失败分开造：连不上是本地码，被拒是宿主回的业务错误
        throw outcome.code === "unauthorized"
          ? fromHostError({
              code: -32001,
              message: "凭证没被接受",
              data: { code: "unauthorized", message: "凭证没被接受", params: {} },
            })
          : localError("host_unavailable", { params: { endpoint: "x" } });
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
      hostFile: { pid: 111, host: "127.0.0.1", port: 8790, fromTick: 0 },
    });

    const result = await ensureHost(test.options);

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
      onConnect: () => ({ ok: false, code: "host_unavailable" }),
    });

    const error = (await ensureHost(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;
    expect(error.code).toBe("host_unavailable");
    expect(error.detail).toMatchObject({ host: "10.0.0.5", port: 8790, explicit: true });
    expect(test.spawned).toEqual([]);
  });

  it("宿主拒了凭证：那句话原样抛出去，不折成「起不来」", async () => {
    const test = harness({
      settings: { mode: "remote", url: "ws://10.0.0.5:8790", token: "wrong" },
      onConnect: () => ({ ok: false, code: "unauthorized" }),
    });

    const error = (await ensureHost(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;
    // `unauthorized` 是「这样不行」（宿主在、话也说了），不是「现在不行」
    expect(error.code).toBe("unauthorized");
    expect(test.spawned).toEqual([]);
  });

  it("显式地址指向本机且没给凭证时，用本机 run/token", async () => {
    const test = harness({
      settings: { mode: "remote", url: "ws://127.0.0.1:8790" },
      token: { value: "local-token", fromTick: 0 },
    });

    await ensureHost(test.options);
    expect(test.connects[0]?.token).toBe("local-token");
  });

  it("显式地址在远端且没给凭证时，不去翻本机那串", async () => {
    const test = harness({
      settings: { mode: "remote", url: "wss://example.test/ai-zen" },
      token: { value: "local-token", fromTick: 0 },
    });

    await ensureHost(test.options);
    expect(test.connects[0]?.token).toBe("");
  });
});

describe("本机：有就上", () => {
  it("发现文件里的实例还活着：直接连上，不拉起", async () => {
    const test = harness({
      settings: { mode: "local" },
      hostFile: { pid: 111, host: "127.0.0.1", port: 8790, fromTick: 0 },
      token: { value: "tok", fromTick: 0 },
    });

    const result = await ensureHost(test.options);

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
        files.set(HOST_FILE, {
          content: JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 54321 }),
          fromTick: 1,
        });
        files.set(TOKEN_FILE, { content: "fresh-token\n", fromTick: 2 });
      },
      // 没有凭证时宿主不会认（这一轮算「还没就绪」）
      onConnect: (options) =>
        options.token === "" ? { ok: false, code: "host_unavailable" } : { ok: true },
    });

    const result = await ensureHost(test.options);

    expect(test.spawned).toHaveLength(1);
    expect(test.spawned[0]).toMatchObject({ dataRoot: DATA_ROOT, entry: "/host/dist/cli.js" });
    expect(result.started).toBe(true);
    expect(result.target).toEqual({ host: "127.0.0.1", port: 54321 });
    // 第一轮没有凭证、第二轮拿到刚写出来的那串
    expect(test.connects.map((connect) => connect.token)).toEqual(["", "fresh-token"]);
  });

  it("只认新 pid：旧发现文件（进程已死）的端口不算「刚拉起的那个」", async () => {
    const test = harness({
      settings: { mode: "local" },
      hostFile: { pid: 111, host: "127.0.0.1", port: 8790, fromTick: 0 },
      token: { value: "tok", fromTick: 0 },
      // 旧 pid 那个端口没人应答
      onConnect: (options) =>
        options.target && typeof options.target === "object" && options.target.port === 8790
          ? { ok: false, code: "host_unavailable" }
          : { ok: true },
      onSpawn: (_context, files) => {
        files.set(HOST_FILE, {
          content: JSON.stringify({ pid: 222, host: "127.0.0.1", port: 6000 }),
          fromTick: 1,
        });
      },
    });

    const result = await ensureHost(test.options);
    expect(result.started).toBe(true);
    expect(result.target.port).toBe(6000);
  });

  it("到时限还没就绪：报 host_did_not_start，并指出日志在哪", async () => {
    const test = harness({ settings: { mode: "local" }, timeoutMs: 300 });

    const error = (await ensureHost(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;
    expect(error.code).toBe("host_did_not_start");
    expect(error.detail).toMatchObject({
      dataRoot: DATA_ROOT,
      logFile: `${DATA_ROOT}/logs/host/host.log`,
    });
    expect(test.spawned).toHaveLength(1);
  });
});

describe("本地事实的读法", () => {
  it("发现文件坏了就当没有（不拦住「拉一个新的」）", async () => {
    const facts = await readHostFile(DATA_ROOT, async () => "{ 半个 JSON");
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

// ==================== 拉起：两条路 ====================

/** 一个假子进程：只长着拉起那一层用到的那几件事（`once` / `emit` 来自 `EventEmitter`） */
class FakeChild extends EventEmitter {
  pid: number | undefined = 999_999;
  killed: string[] = [];
  unrefd = false;
  unref(): void {
    this.unrefd = true;
  }
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * 假 spawn：记下命令行与选项，下一轮微任务里报 `spawn`（此时「子进程」可以往日志里写东西）；
 * 给了 `exit` 再接着报 `close`（模拟「拉起的那个子进程自己退了」）。
 */
function fakeSpawn(
  plan: {
    exit?: { code: number | null; signal?: string | null };
    /** 「子进程」往拉起日志里写的那几行（npm 的输出来自子进程，不是我们写的） */
    output?: { path: string; text: string };
  } = {},
) {
  const calls: SpawnCall[] = [];
  const child = new FakeChild();
  const spawnImpl = (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    queueMicrotask(() => {
      if (plan.output) writeFileSync(plan.output.path, plan.output.text, "utf-8");
      child.emit("spawn");
      if (plan.exit) child.emit("close", plan.exit.code, plan.exit.signal ?? null);
    });
    return child;
  };
  return {
    calls,
    child,
    spawn: spawnImpl as unknown as NonNullable<SpawnDeps["spawn"]>,
  };
}

/** 每个用例一个临时数据根（拉起日志真的要写盘）；用例结束统一收掉 */
let dirs: string[] = [];

function tempDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiz-launch-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const RANGE = "^0.1.0-alpha.0";

describe("npx 那条路的命令行", () => {
  it("POSIX：npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>", () => {
    expect(
      npxHostArgv({ versionRange: RANGE, dataRoot: "/data/ai-zen", platform: "linux" }),
    ).toEqual({
      command: "npx",
      shell: false,
      // `-y` 不能省：npx 装新包时会问一句，而屏幕上没有人能答
      args: ["-y", `@ai-zen/agents-host@${RANGE}`, "serve", "--ai-zen-dir", "/data/ai-zen"],
    });
  });

  it("Windows：npx.cmd 过一层 shell，范围里的 ^ 与路径各自加引号（否则被 cmd 当转义吃掉）", () => {
    const argv = npxHostArgv({
      versionRange: RANGE,
      dataRoot: "C:\\Users\\u\\.ai-zen",
      platform: "win32",
    });
    expect(argv.command).toBe("npx.cmd");
    expect(argv.shell).toBe(true);
    expect(argv.args).toEqual([
      "-y",
      `"@ai-zen/agents-host@${RANGE}"`,
      "serve",
      "--ai-zen-dir",
      '"C:\\Users\\u\\.ai-zen"',
    ]);
  });
});

describe("两条路的判据：给了 entry 就起它，没给就 npx", () => {
  it("给了 entry → process.execPath 跑那个入口（桌面端那条路一个字都没变）", async () => {
    const fake = fakeSpawn();

    const spawned = await spawnHostByContext(
      {
        dataRoot: "/data/ai-zen",
        launchLog: launchLogOf("/data/ai-zen"),
        entry: "/host/dist/host.mjs",
        versionRange: RANGE,
      },
      { spawn: fake.spawn, platform: "linux" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe(process.execPath);
    expect(fake.calls[0]?.args).toEqual([
      "/host/dist/host.mjs",
      "serve",
      "--ai-zen-dir",
      "/data/ai-zen",
    ]);
    expect(fake.calls[0]?.options).toMatchObject({
      detached: true,
      windowsHide: true,
      env: expect.objectContaining({ AI_ZEN_DIR: "/data/ai-zen" }),
    });
    expect(typeof spawned.exited.then).toBe("function");
  });

  it("没给 entry → npx", async () => {
    const fake = fakeSpawn();

    await spawnHostByContext(
      { dataRoot: "/data/ai-zen", launchLog: launchLogOf("/data/ai-zen"), versionRange: RANGE },
      { spawn: fake.spawn, platform: "linux" },
    );

    expect(fake.calls[0]?.command).toBe("npx");
    expect(fake.calls[0]?.args).toContain(`@ai-zen/agents-host@${RANGE}`);
  });
});

describe("npx 那条路的子进程", () => {
  it("windowsHide + detached；输出落调用方给的那个拉起日志（不进终端、不占管道）", async () => {
    const dir = tempDataRoot();
    const fake = fakeSpawn();

    await spawnHostViaNpx(
      { dataRoot: dir, launchLog: launchLogOf(dir), versionRange: RANGE },
      { spawn: fake.spawn, platform: "linux" },
    );

    const options = fake.calls[0]?.options ?? {};
    expect(options.windowsHide).toBe(true);
    expect(options.detached).toBe(true);
    expect(options.shell).toBeFalsy();
    const stdio = options.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(stdio[1]).toBe("ignore");
    // 第三格是一个打开的文件描述符：进程的输出写进那个文件，而不是一条活管道
    expect(typeof stdio[2]).toBe("number");
    expect(existsSync(launchLogOf(dir))).toBe(true);
    expect(fake.child.unrefd).toBe(true);
  });

  it("阶段先报 resolving 再报 installing（解析在前、下载安装在后）", async () => {
    const dir = tempDataRoot();
    const fake = fakeSpawn();
    const stages: HostLaunchStage[] = [];

    await spawnHostViaNpx(
      {
        dataRoot: dir,
        launchLog: launchLogOf(dir),
        versionRange: RANGE,
        onStage: (stage) => stages.push(stage),
      },
      { spawn: fake.spawn, platform: "linux" },
    );

    expect(stages).toEqual(["resolving", "installing"]);
  });

  it("没给版本范围 → host_version_range_missing，一个进程都不起", async () => {
    const fake = fakeSpawn();
    const error = (await spawnHostViaNpx(
      { dataRoot: "/data/ai-zen", launchLog: launchLogOf("/data/ai-zen") },
      { spawn: fake.spawn },
    ).catch((caught: unknown) => caught)) as ClientError;

    expect(error.code).toBe("host_version_range_missing");
    expect(fake.calls).toEqual([]);
  });
});

describe("阶段与取消", () => {
  it("阶段按 resolving → installing → starting → connected 走完一遍", async () => {
    const test = harness({
      settings: { mode: "local" },
      // 发现文件要等一轮才出现：`starting` 那一刻才有东西可说
      hostFile: { pid: 4321, host: "127.0.0.1", port: 54321, fromTick: 1 },
      token: { value: "fresh-token", fromTick: 1 },
    });
    const stages: HostLaunchStage[] = [];
    test.options.onStage = (stage) => stages.push(stage);

    await ensureHost(test.options);

    expect(stages).toEqual(["resolving", "installing", "starting", "connected"]);
  });

  it("取消会杀掉正在拉起的那个子进程", async () => {
    const dir = tempDataRoot();
    const controller = new AbortController();
    const fake = fakeSpawn();

    const spawning = spawnHostViaNpx(
      {
        dataRoot: dir,
        launchLog: launchLogOf(dir),
        versionRange: RANGE,
        signal: controller.signal,
      },
      // win32 那一支不走 `process.kill(-pid)`：用例不该真的去碰一个进程组
      { spawn: fake.spawn, platform: "win32" },
    );
    controller.abort();
    await spawning;

    expect(fake.child.killed).toEqual(["SIGTERM"]);
  });

  it("拉起过程中被取消 → host_launch_cancelled（不是「起不来」）", async () => {
    const controller = new AbortController();
    const test = harness({
      settings: { mode: "local" },
      // 拉到一半用户按了 Ctrl+C
      onSpawn: () => controller.abort(),
    });
    test.options.signal = controller.signal;

    const error = (await ensureHost(test.options).catch(
      (caught: unknown) => caught,
    )) as ClientError;

    expect(error.code).toBe("host_launch_cancelled");
  });
});

describe("拉起失败：拿子进程最后一行输出当原因", () => {
  it("npx 自己退了 → exited 带上退出码与那行原因（抹掉颜色控制序列）", async () => {
    const dir = tempDataRoot();
    const fake = fakeSpawn({
      exit: { code: 1 },
      output: {
        path: launchLogOf(dir),
        text: "npm warn exec 需要安装\n\u001b[31mnpm error 404 not found @ai-zen/agents-host\u001b[0m\n\n",
      },
    });

    const spawned = await spawnHostViaNpx(
      { dataRoot: dir, launchLog: launchLogOf(dir), versionRange: RANGE },
      { spawn: fake.spawn, platform: "linux" },
    );

    await expect(spawned.exited).resolves.toEqual({
      code: 1,
      reason: "npm error 404 not found @ai-zen/agents-host",
    });
  });

  it("宿主进程提前退出 → 当场报 host_launch_failed（不必等满 15 秒），原话上屏", async () => {
    const test = harness({ settings: { mode: "local" }, timeoutMs: 60_000 });
    const options: EnsureHostOptions = {
      ...test.options,
      spawnHost: async () => ({
        exited: Promise.resolve({ code: 1, reason: "npm error 404 not found" }),
      }),
    };

    const error = (await ensureHost(options).catch((caught: unknown) => caught)) as ClientError;

    expect(error.code).toBe("host_launch_failed");
    expect(error.message).toContain("npm error 404 not found");
    expect(error.detail).toMatchObject({ code: 1, logFile: launchLogOf(DATA_ROOT) });
  });
});
