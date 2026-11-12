/**
 * `ServerApp`（单根）的验收：组装、启停对称、单实例、退出判据、删除路径的跨层补齐。
 *
 * 这里关心的是「谁被接上了、什么时刻会发生什么」，所以有一部分用例直接调用 handler 表
 * （省掉网络这一层），需要看连接数变化的那几条才真开 WebSocket —— 端到端那条完整链路在
 * `e2e.test.ts` 里，真起进程的那条在 `cli.process.test.ts` 里。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer, resolveServerVersion } from "./app.js";
import type { ExitFacts, ServerApp, ServerAppOptions } from "./app.js";
import { resolvePaths } from "./config.js";
import type { ConnectionInfo } from "./net/index.js";
import { readServerFile, writeServerFile } from "./net/discovery.js";
import { isError, makeTempDir, TestClient, wait, type TempDir } from "./net/TestSupport.js";
import { METHOD_NAMES } from "./wire/index.js";
import type { MethodName, MethodParams, MethodResult } from "./wire/index.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 只有一个假端点的配置（端到端冒烟与这里共用同一套口径：假 key，不连模型） */
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
    modelId: "test-model",
    messages: [{ id: "sys-1", role: "system", status: "completed", content: "测试助手" }],
    custom: true,
  },
  null,
  2,
);

/** 与 handler 表打交道的假连接（语言固定英文：这几个用例不断言文案） */
const CONNECTION: ConnectionInfo = {
  id: "test-connection",
  language: "en",
  clientInfo: null,
  credentialId: null,
};

interface Fixture {
  dataRoot: TempDir;
  workspaceDir: TempDir;
}

const fixtures: Fixture[] = [];
const apps: ServerApp[] = [];
const clients: TestClient[] = [];

async function makeFixture(): Promise<Fixture> {
  const base = await fs.mkdtemp(join(tmpdir(), "ai-zen-app-"));
  const dataRoot: TempDir = {
    path: base,
    remove: () => fs.rm(base, { recursive: true, force: true }),
  };
  await fs.mkdir(join(base, "agents"), { recursive: true });
  await fs.writeFile(join(base, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(base, "agents", "default.json"), AGENT, "utf8");
  const fixture: Fixture = { dataRoot, workspaceDir: await makeTempDir("ai-zen-app-cwd-") };
  fixtures.push(fixture);
  return fixture;
}

/** 起一个服务（端口 0 让系统分配；退出动作换成记账，不真的把测试进程送走） */
async function startApp(fixture: Fixture, options: ServerAppOptions = {}): Promise<ServerApp> {
  const app = await createServer({
    aiZenDir: fixture.dataRoot.path,
    port: 0,
    local: true,
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
    ...options,
  });
  await app.start();
  apps.push(app);
  return app;
}

/** 直接调 handler 表（省掉网络：这几条断言看的是「接上了没有」） */
async function callMethod<M extends MethodName>(
  app: ServerApp,
  method: M,
  params: MethodParams<M> = {} as MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: CONNECTION });
}

async function connect(app: ServerApp): Promise<TestClient> {
  const target = app.address;
  if (!target) throw new Error("服务端没在监听");
  const client = await TestClient.connect(`ws://127.0.0.1:${target.port}/`);
  clients.push(client);
  const token = (await fs.readFile(app.paths.tokenFile, "utf8")).trim();
  await client.hello(token);
  return client;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const fixture of fixtures.splice(0)) {
    await fixture.workspaceDir.remove();
    await fixture.dataRoot.remove();
  }
});

// ---------------------------------------------------------------------------
// 组装与启停
// ---------------------------------------------------------------------------

describe("ServerApp 的组装", () => {
  it("按对象图的顺序造出全部零件，start / stop 对称", async () => {
    const fixture = await makeFixture();
    const app = await createServer({
      aiZenDir: fixture.dataRoot.path,
      port: 0,
      local: true,
      exit: () => undefined,
    });
    apps.push(app);

    // 基础设施
    expect(app.paths.dataRoot).toBe(fixture.dataRoot.path);
    expect(app.configManager.configPath).toBe(join(fixture.dataRoot.path, "config.json"));
    await expect(app.db.all("SELECT 1 AS one")).resolves.toBeDefined();
    // 运行时
    expect(app.scopeRegistry.size()).toBe(0);
    expect(app.runRegistry.size()).toBe(0);
    expect(app.conversationStates.size()).toBe(0);
    // 服务
    expect(typeof app.workspaceService.create).toBe("function");
    expect(typeof app.conversationService.create).toBe("function");
    expect(typeof app.messageService.list).toBe("function");
    expect(typeof app.searchService.messages).toBe("function");
    expect(typeof app.credentialService.create).toBe("function");
    expect(typeof app.assetService.prepareAttachments).toBe("function");
    // 接线
    expect(app.version).toBe(resolveServerVersion());
    expect(app.local).toBe(true);
    expect(app.running).toBe(false);

    // 没监听之前不该有发现文件
    expect(await readServerFile(app.paths)).toBeNull();

    const target = await app.start();
    expect(target.port).toBeGreaterThan(0);
    expect(app.running).toBe(true);
    const info = await readServerFile(app.paths);
    expect(info?.port).toBe(target.port);
    expect(info?.pid).toBe(process.pid);
    expect(info?.local).toBe(true);
    expect(info?.version).toBe(app.version);
    // 本地实例启动时备好交付文件（客户端直接取）
    expect(await exists(app.paths.tokenFile)).toBe(true);

    // 收尾：摘发现文件 + 关库（对称于 start）
    const facts = await app.stop("requested");
    expect(facts).toEqual({ reason: "requested", connections: 0, runs: 0, scopes: 0 });
    expect(app.running).toBe(false);
    expect(await readServerFile(app.paths)).toBeNull();
    await expect(app.db.all("SELECT 1")).rejects.toBeTruthy();
  });

  it("注册了有实现者的方法，其余方法由接线层回 unsupported", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const registered = Object.keys(app.handlers).sort();

    expect(registered).toEqual(
      [
        "conversation.abort",
        "conversation.create",
        "conversation.delete",
        "conversation.get",
        "conversation.list",
        "conversation.pin",
        "conversation.rename",
        "conversation.revert",
        "conversation.send",
        "conversation.setModel",
        "conversation.setThinking",
        "conversation.state",
        "credential.create",
        "credential.list",
        "credential.revoke",
        "message.list",
        "search.conversations",
        "search.messages",
        "server.capabilities",
        "server.shutdown",
        "server.usage",
        "server.version",
        "workspace.create",
        "workspace.get",
        "workspace.list",
        "workspace.remove",
        "workspace.rename",
      ].sort(),
    );
    // 已注册的都在契约里（没有手滑写错的方法名）
    for (const method of registered) expect(METHOD_NAMES).toContain(method);

    // 还没实现的域：接线层回 unsupported，而不是 internal 或参数错（R11）
    const client = await connect(app);
    for (const method of [
      "config.get",
      "agent.list",
      "model.list",
      "notice.list",
      "question.list",
      "handoff.start",
      "completion.files",
      "conversation.transient",
    ]) {
      client.request(method, {});
      const frame = await client.queue.next();
      expect(isError(frame)).toBe(true);
      if (isError(frame)) {
        expect(frame.error.data.code).toBe("unsupported");
        expect(frame.error.data.detail).toMatchObject({ reason: "handler_not_registered" });
      }
    }

    // `asset.begin` / `asset.end` 由接线层接管（上传要按连接分帧），不在 handler 表里
    expect(registered).not.toContain("asset.begin");
    expect(registered).not.toContain("asset.end");
  });

  it("server.version / server.usage / server.capabilities 报的都是事实", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const version = await callMethod(app, "server.version");
    expect(version.version).toBe(app.version);
    expect(version.pid).toBe(process.pid);
    expect(version.startedAt).toBe(app.startedAt);

    const capabilities = await callMethod(app, "server.capabilities");
    expect(capabilities.capabilities).toEqual([]);

    const usage = await callMethod(app, "server.usage");
    expect(usage.scope).toBe("server");
    expect(usage.usage.total.total_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 单实例（architecture §2：发现文件是「这台机器上谁在服务」的唯一真相）
// ---------------------------------------------------------------------------

describe("单实例", () => {
  it("发现文件里那个进程还活着 → 挂靠它的地址，不再重复监听", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(join(fixture.dataRoot.path, "run"), { recursive: true });
    // pid 1 一定在（这台机器上就是 init/systemd），用来代表「别人正在服务」
    const running = {
      pid: 1,
      host: "127.0.0.1",
      port: 45671,
      version: "9.9.9",
      local: true,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeServerFile(pathsOf(fixture), running);

    const app = await startApp(fixture);
    expect(app.attached).toBe(true);
    expect(app.running).toBe(false);
    expect(app.address).toEqual({ host: "127.0.0.1", port: 45671 });

    // 挂靠时不碰别人那份发现文件（本进程没在监听，删了它客户端就连不上了）
    await app.stop("requested");
    expect(await readServerFile(pathsOf(fixture))).toEqual(running);
  });

  it("发现文件是陈旧的（pid 已死）→ 清掉再起，并写成自己的实际端口", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(join(fixture.dataRoot.path, "run"), { recursive: true });
    const stale = {
      // 远超常见 pid_max 的编号：这台机器上不会真有这个进程
      pid: 4194303,
      host: "127.0.0.1",
      port: 45672,
      version: "0.0.1",
      local: true,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeServerFile(pathsOf(fixture), stale);

    const app = await startApp(fixture);
    expect(app.running).toBe(true);
    const info = await readServerFile(app.paths);
    expect(info?.pid).toBe(process.pid);
    expect(info?.port).toBe(app.address?.port);
    expect(info?.port).not.toBe(stale.port);
  });

  it("发现文件坏了 → 清掉再起（坏文件不该让服务起不来）", async () => {
    const fixture = await makeFixture();
    const paths = pathsOf(fixture);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.serverFile, "{ 这不是 JSON", "utf8");

    const app = await startApp(fixture);
    expect(app.running).toBe(true);
    expect((await readServerFile(app.paths))?.port).toBe(app.address?.port);
  });
});

/** 还没起服务时也要能按同一套规则算出路径（写「别人的」发现文件用） */
function pathsOf(fixture: Fixture) {
  return resolvePaths(fixture.dataRoot.path);
}

// ---------------------------------------------------------------------------
// 退出判据（PRD L4 / R53）
// ---------------------------------------------------------------------------

describe("退出判据", () => {
  it("还没被用过时不判退出（刚起来的进程在等客户端）", async () => {
    const fixture = await makeFixture();
    const exits: ExitFacts[] = [];
    const app = await startApp(fixture, {
      exit: (facts) => {
        exits.push(facts);
      },
    });

    await app.checkExit();
    expect(exits).toEqual([]);
    expect(app.running).toBe(true);
  });

  it("有连接时不判；连接断开且 Scope 回收之后（onAllRecycled）才退", async () => {
    const fixture = await makeFixture();
    const exits: ExitFacts[] = [];
    const app = await startApp(fixture, {
      // 空闲回收调到几十毫秒：用例不能真等十分钟
      scopeIdleTimeoutMs: 30,
      exit: (facts) => {
        exits.push(facts);
      },
    });

    const client = await connect(app);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    await app.scopeRegistry.acquire(workspace.id);

    // 有连接 → 什么都不欠也不退（连接就是「还有人等着说话」）
    await app.checkExit();
    expect(exits).toEqual([]);

    // 依赖归零 → 空闲到点 → 销毁 → onAllRecycled → 判据成立
    // 这一次连接还开着，所以仍然不退
    app.scopeRegistry.release(workspace.id);
    await wait(120);
    expect(app.scopeRegistry.size()).toBe(0);
    expect(exits).toEqual([]);

    // 再借一次、断开连接、再归还：这次什么都不欠了
    await app.scopeRegistry.acquire(workspace.id);
    await client.close();
    await app.checkExit();
    expect(exits).toEqual([]);
    app.scopeRegistry.release(workspace.id);
    await wait(150);
    expect(exits).toEqual([{ reason: "idle", connections: 0, runs: 0, scopes: 0 }]);
    expect(app.running).toBe(false);
  });

  it("收尾只做一次、交棒只交一次", async () => {
    const fixture = await makeFixture();
    const exits: ExitFacts[] = [];
    const app = await startApp(fixture, {
      exit: (facts) => {
        exits.push(facts);
      },
    });

    const [first, second] = await Promise.all([
      app.shutdown("requested"),
      app.shutdown("requested"),
    ]);
    expect(first).toBe(second);
    expect(exits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 删除路径的跨层补齐（R33 / R43）
// ---------------------------------------------------------------------------

describe("删除路径", () => {
  it("删对话会清掉它的素材文件（R33）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const { conversation } = await callMethod(app, "conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
      modelId: "test-model",
    });

    // 造一条素材行（等价于一次上传落定）：临时文件 → 正式文件 + 库里的引用
    const tempPath = join(app.paths.assetsDir, ".upload-test.part");
    await fs.writeFile(tempPath, "png-bytes");
    const ref = await app.assetService.finalizeUpload({
      uploadId: "upload-test",
      tempPath,
      mime: "image/png",
      bytes: 9,
      sha256: "not-checked-here",
      name: "a.png",
      purpose: "message_image",
      conversationId: conversation.id,
    });
    const assetPath = join(app.paths.dataRoot, "assets", `${ref.assetId}.png`);
    expect(await exists(assetPath)).toBe(true);

    const dryRun = await callMethod(app, "conversation.delete", {
      conversationId: conversation.id,
      dryRun: true,
    });
    expect(dryRun.removed).toBe(false);
    expect(dryRun.consequences.assets).toBe(1);
    expect(await exists(assetPath)).toBe(true);

    const result = await callMethod(app, "conversation.delete", {
      conversationId: conversation.id,
    });
    expect(result.removed).toBe(true);
    // 素材文件按引用清掉，库里的行也在
    expect(await exists(assetPath)).toBe(false);
    expect(await app.assetService.get(ref.assetId)).toBeUndefined();
    // 运行时那边这段对话的现场被丢掉了
    expect(app.chatRunner.turn(conversation.id)).toBeUndefined();
  });

  it("删项目会回收它的 Scope 并连名下对话一起清（R43）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture, {
      // 空闲回收调长：这一条要看的是「删项目时被主动销毁」，不是空闲到点
      scopeIdleTimeoutMs: 10 * 60 * 1000,
    });
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    await callMethod(app, "conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
      modelId: "test-model",
    });

    // 借一次 Scope 再还（依赖归零，但空闲计时还没到）
    await app.scopeRegistry.acquire(workspace.id);
    app.scopeRegistry.release(workspace.id);
    expect(app.scopeRegistry.size()).toBe(1);

    const result = await callMethod(app, "workspace.remove", { workspaceId: workspace.id });
    expect(result.removed).toBe(true);
    expect(result.consequences.conversations).toBe(1);
    // Scope 被主动销毁（MCP 连接在这里断开），名下对话也没了
    expect(app.scopeRegistry.size()).toBe(0);
    const remaining = await callMethod(app, "conversation.list", { workspaceId: workspace.id });
    expect(remaining.total).toBe(0);
  });
});
