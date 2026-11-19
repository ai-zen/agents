/**
 * 真起进程的集成用例：`node dist/cli.js serve` → 真 WebSocket 连上 → 建项目/对话 → 杀进程 →
 * 同一个数据根再起 → 数据还在 → 收尾时发现文件被摘掉。
 *
 * 与 `session.flow.test.ts` 的分工：那条把宿主当库用（同一进程内真监听），这一条走的是**产品真正的
 * 入口**（命令行、子进程、信号退出），验的是 `cli.ts` 与进程生命周期，而不是库的接线。
 *
 * 前提是 `dist/` 里有产物：用例自己跑一次 `tsc`（这一步也是验收里的「真编译」）。并行实施者
 * 的目录里可能还有类型错误，那不影响产物 —— `tsc` 照样 emit，只是退出码非 0，所以这里只要求
 * `dist/cli.js` 真的出现。
 */

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isError, isNotification, isSuccess, TestClient } from "./net/TestSupport.js";
import type { SessionListResult, MessageListResult, WorkspaceListResult } from "./wire/index.js";

/** 包根（`src/` 的上一级）：不读进程工作目录，从本文件的 URL 推 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = join(PACKAGE_ROOT, "dist", "cli.js");

/** 假端点的配置：本用例不连模型，写一份假 key 就够 */
const CONFIG = JSON.stringify(
  {
    endpoints: [
      { id: "fake", name: "Fake", baseUrl: "https://example.invalid/v1", apiKey: "sk-fake" },
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 1000, guard: 2000 },
        custom: true,
      },
    ],
  },
  null,
  2,
);

const AGENT = JSON.stringify(
  {
    id: "default",
    name: "Test Assistant",
    description: "进程冒烟用的助手",
    modelId: "test-model",
    messages: [{ id: "sys-1", role: "system", status: "completed", content: "你是测试助手。" }],
    custom: true,
  },
  undefined,
  2,
);

interface RunningHost {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
  /** 等进程真的退出（拿退出码） */
  exited: Promise<number | null>;
}

const children: RunningHost[] = [];
let dataRoot = "";
let workspaceDir = "";

beforeAll(async () => {
  // 真编译一次（并行实施者目录里的类型错误不影响 emit，只影响退出码）
  const built = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    timeout: 240_000,
  });
  await fs.access(CLI_ENTRY).catch(() => {
    throw new Error(`编译没有产出 ${CLI_ENTRY}：${built.stderr ?? ""}`);
  });

  dataRoot = await fs.mkdtemp(join(tmpdir(), "ai-zen-process-"));
  workspaceDir = await fs.mkdtemp(join(tmpdir(), "ai-zen-process-cwd-"));
  await fs.mkdir(join(dataRoot, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot, "agents", "default.json"), AGENT, "utf8");
}, 300_000);

afterAll(async () => {
  for (const running of children.splice(0)) {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  }
  if (dataRoot !== "") await fs.rm(dataRoot, { recursive: true, force: true });
  if (workspaceDir !== "") await fs.rm(workspaceDir, { recursive: true, force: true });
});

/** 起一个真的宿主进程（`--port 0`：端口由系统分配，只能从发现文件读） */
function startProcess(): RunningHost {
  const child = spawn(process.execPath, [CLI_ENTRY, "serve", "--port", "0", "--local", "--ai-zen-dir", dataRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const running: RunningHost = {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
  };
  children.push(running);
  return running;
}

/** 等发现文件出现并读出端口（宿主只在监听成功之后才写它） */
async function waitForHostFile(): Promise<{ port: number; token: string }> {
  const hostFile = join(dataRoot, "run", "host.json");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const info: unknown = JSON.parse(await fs.readFile(hostFile, "utf8"));
      const port = (info as { port?: unknown }).port;
      if (typeof port === "number" && port > 0) {
        const token = (await fs.readFile(join(dataRoot, "run", "token"), "utf8")).trim();
        return { port, token };
      }
    } catch {
      // 还没写出来：继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等不到发现文件：${hostFile}`);
}

async function connect(port: number): Promise<TestClient> {
  return await TestClient.connect(`ws://127.0.0.1:${port}/`);
}

/**
 * 发一个请求并等它的回包，中间插进来的推送（事件）先跳过。
 *
 * 发过消息的那个进程正在干活（端点不存在，很快以失败收尾），`state` / `message.changed` /
 * `session.changed` 会与后面的回包交错到达；`TestClient.call` 按到达顺序取帧，在这段
 * 流程里不够用。
 */
async function callSkippingEvents(
  client: TestClient,
  method: string,
  params: unknown = {},
): Promise<unknown> {
  const id = client.request(method, params);
  for (;;) {
    const frame = await client.queue.next(20_000);
    if (isNotification(frame)) continue;
    if (!isSuccess(frame)) throw new Error(`期望成功响应，拿到：${JSON.stringify(frame)}`);
    expect(frame.id).toBe(id);
    return frame.result;
  }
}

/** 停一个进程并等它真的走 */
async function stop(running: RunningHost): Promise<number | null> {
  running.child.kill("SIGTERM");
  return await running.exited;
}

describe("命令行本身：退出码与让人看得懂的错误", () => {
  /** 跑一次命令行，拿到 stdout / stderr / 退出码（都是真进程） */
  function runCli(
    args: readonly string[],
    env: Record<string, string> = {},
  ): { code: number | null; out: string; err: string } {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
  }

  it("version 打版本与协议版本，退出码 0", () => {
    const result = runCli(["version"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("@ai-zen/agents-host");
    expect(result.out).toContain("协议 1");
  });

  /**
   * 发布出去的形状：`dist/cli.js` 的第一行必须是 shebang。
   *
   * 这一条盯的是「装到机器上能不能用」：`bin` 装出来的 `.bin/agents-host` 直接指向这个文件，
   * 缺 shebang 时 shell 会把它当脚本去解释，用户看到的是 `xxx: not found` 这种跟 CLI 毫无关系的
   * 报错（发布 alpha.0 时真撞上了，所以补这条）。执行位由 npm 打包时按 `bin` 打上，不在这一步验。
   */
  it("dist/cli.js 带 shebang：装成 bin 之后能直接执行", async () => {
    const first = (await fs.readFile(CLI_ENTRY, "utf8")).split("\n")[0];
    expect(first).toBe("#!/usr/bin/env node");
  });

  it("--help 打用法，退出码 0", () => {
    const result = runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("用法：");
    expect(result.out).toContain("--ai-zen-dir");
  });

  it("用错参数：退出码 2，并且说的是人话", () => {
    for (const args of [
      ["不认识的命令"],
      ["serve", "--port"],
      ["serve", "--port", "99999"],
      ["serve", "--不认识的参数"],
      ["token", "revoke"],
      ["token", "不认识的动件"],
    ]) {
      const result = runCli(args);
      expect(result.code).toBe(2);
      expect(result.err.length).toBeGreaterThan(0);
      // 人话，不是栈
      expect(result.err).not.toMatch(/\n\s+at /);
    }
  });

  it("--local 与非回环地址矛盾时当场拒（退出码 2）", () => {
    const result = runCli(["serve", "--local", "--host", "0.0.0.0"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("矛盾");
  });

  it("token 三个动作都不用起服务（create → list → revoke）", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ai-zen-cli-token-"));
    try {
      const empty = runCli(["token", "list", "--ai-zen-dir", root]);
      expect(empty.code).toBe(0);
      expect(empty.out).toContain("还没有任何凭证");

      const created = runCli(["token", "create", "--note", "笔记本", "--ai-zen-dir", root]);
      expect(created.code).toBe(0);
      expect(created.out).toContain("凭证已创建");
      expect(created.out).toContain("笔记本");
      const id = /id: ([0-9a-f-]{36})/.exec(created.out)?.[1] ?? "";
      expect(id.length).toBeGreaterThan(0);

      const listed = runCli(["token", "list", "--ai-zen-dir", root]);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain(id);
      expect(listed.out).toContain("有效");

      const revoked = runCli(["token", "revoke", id, "--ai-zen-dir", root]);
      expect(revoked.code).toBe(0);
      expect(revoked.out).toContain("已吊销");
      // 已吊销的再吊销一次：不报错，只是没改动库（R42）
      const again = runCli(["token", "revoke", id, "--ai-zen-dir", root]);
      expect(again.code).toBe(0);
      expect(again.out).toContain("本来就已吊销");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("数据根用不了时：退出码 1、一句人话、不甩栈", () => {
    const result = runCli(["serve", "--ai-zen-dir", "/dev/null/ai-zen-sub"]);
    expect(result.code).toBe(1);
    expect(result.err.trim().length).toBeGreaterThan(0);
    expect(result.err).not.toMatch(/\n\s+at /);
  }, 60_000);
});

describe("进程冒烟：命令行起服务 → 连接 → 建项目/对话 → 重启 → 数据还在 → 收尾清场", () => {
  it("跑完整条链路", async () => {
    // ---- 1. 起进程，从发现文件读实际端口与凭证 ----
    const first = startProcess();
    const host = await waitForHostFile();
    expect(host.port).toBeGreaterThan(0);
    expect(host.token.length).toBeGreaterThan(0);
    // 命令行把地址说清楚了（人看的那一行）
    expect(first.stdout()).toContain("宿主已启动：ws://127.0.0.1:");

    // ---- 2. 握手：带凭证成功，不带/带错都被拒 ----
    const anon = await connect(host.port);
    // 没握手就发别的请求：一律 unauthorized（连方法名都不判断）
    anon.request("workspace.list", {});
    const notHello = await anon.queue.next();
    expect(isError(notHello)).toBe(true);
    if (isError(notHello)) expect(notHello.error.data.code).toBe("unauthorized");

    // 不带凭证握手：被拒
    anon.request("host.hello", { clientInfo: { name: "smoke", version: "0.0.0" } });
    const noToken = await anon.queue.next();
    expect(isError(noToken)).toBe(true);

    // 凭证不对：unauthorized
    anon.request("host.hello", {
      token: "definitely-not-the-token",
      clientInfo: { name: "smoke", version: "0.0.0" },
    });
    const badToken = await anon.queue.next();
    expect(isError(badToken)).toBe(true);
    if (isError(badToken)) expect(badToken.error.data.code).toBe("unauthorized");
    await anon.close();

    // 凭证对：握手成功
    const client = await connect(host.port);
    const hello = await client.hello(host.token, { language: "zh" });
    const helloResult = hello.result as { language: string; protocolVersion: string };
    expect(helloResult.language).toBe("zh");
    expect(helloResult.protocolVersion).toBe("1");

    // ---- 3. 建项目 → 建对话 → 消息还是空的 → 对话列表里有一条 ----
    const createdWorkspace = await client.call("workspace.create", { cwd: workspaceDir });
    const workspaceId = (createdWorkspace.result as { workspace: { id: string } }).workspace.id;
    expect(workspaceId.length).toBeGreaterThan(0);

    const createdSession = await client.call("session.create", {
      workspaceId,
      agentId: "default",
      modelId: "test-model",
    });
    const sessionId = (createdSession.result as { session: { id: string } })
      .session.id;

    const messages = await client.call("message.list", { sessionId });
    expect((messages.result as MessageListResult).messages).toEqual([]);

    // R56 / F-C2：还没发过消息的对话只在内存里（草稿），所以侧栏列表里看不到它
    const beforeSend = await client.call("session.list", {});
    expect((beforeSend.result as SessionListResult).total).toBe(0);

    // 发一条：首次 send 用同一个 id 落库（端点不存在，那次回答会以失败收束，
    // 但「投递即落库」与模型答不答得上来无关）
    await client.call("session.send", { sessionId, input: { content: "你好" } });

    const sessions = await callSkippingEvents(client, "session.list", {});
    const listed = sessions as SessionListResult;
    expect(listed.total).toBe(1);
    expect(listed.sessions[0]?.id).toBe(sessionId);

    // ---- 4. 杀掉进程：发现文件被摘掉 ----
    const code = await stop(first);
    expect(code).toBe(0);
    await expect(fs.access(join(dataRoot, "run", "host.json"))).rejects.toBeTruthy();

    // ---- 5. 同一个数据根再起一个：项目和对话都还在（数据在库里） ----
    const second = startProcess();
    const restarted = await waitForHostFile();
    expect(restarted.token).toBe(host.token);
    // 端口是新的（上一个进程的监听已经放了）
    const again = await connect(restarted.port);
    await again.hello(restarted.token);

    const workspacesAfter = await again.call("workspace.list", {});
    expect((workspacesAfter.result as WorkspaceListResult).workspaces.map((item) => item.id)).toEqual([
      workspaceId,
    ]);

    const sessionsAfter = await again.call("session.list", { workspaceId });
    const afterList = sessionsAfter.result as SessionListResult;
    expect(afterList.total).toBe(1);
    expect(afterList.sessions[0]?.id).toBe(sessionId);

    const messagesAfter = await again.call("message.list", { sessionId });
    const storedMessages = (messagesAfter.result as MessageListResult).messages;
    // 用户那条已经落库了（会话创建时那条隐藏的 cwd 消息不在默认返回里，F-D9）
    expect(storedMessages.length).toBeGreaterThan(0);
    expect(storedMessages[0]?.role).toBe("user");

    // ---- 6. 再收尾一次：这一次也走「摘发现文件 → 关库 → 退出 0」 ----
    await again.close();
    expect(await stop(second)).toBe(0);
    await expect(fs.access(join(dataRoot, "run", "host.json"))).rejects.toBeTruthy();
  }, 120_000);
});
