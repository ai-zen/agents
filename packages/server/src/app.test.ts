/**
 * `ServerApp`（单根）的验收：组装、启停对称、单实例、退出判据、删除路径的跨层补齐。
 *
 * 这里关心的是「谁被接上了、什么时刻会发生什么」，所以有一部分用例直接调用 handler 表
 * （省掉网络这一层），需要看连接数变化的那几条才真开 WebSocket —— 端到端那条完整链路在
 * `e2e.test.ts` 里，真起进程的那条在 `cli.process.test.ts` 里。
 */

import { promises as fs } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer, resolveServerVersion } from "./app.js";
import type { ExitFacts, ServerApp, ServerAppOptions } from "./app.js";
import { resolvePaths } from "./config.js";
import { DEFAULT_PORT, resolveListenTarget } from "./config.js";
import type { ConnectionInfo } from "./net/index.js";
import { readServerFile, writeServerFile } from "./net/discovery.js";
import {
  isError,
  isNotification,
  isSuccess,
  makeTempDir,
  TestClient,
  wait,
  type TempDir,
} from "./net/TestSupport.js";
import { BRIDGED_METHODS } from "./handlers/index.js";
import { FakeAgent } from "./runtime/TestSupport.js";
import { transientScopeKey } from "./runtime/TransientRunner.js";
import { Database } from "./storage/index.js";
import { METHOD_NAMES } from "./wire/index.js";
import { ServerError } from "./wire/index.js";
import type {
  ConversationTransientResult,
  ConversationView,
  MethodName,
  MethodParams,
  MethodResult,
} from "./wire/index.js";

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
/**
 * 建一段对话并让它落库（R56：`conversation.create` 只发 id 与身份，首次 `send` 才写行）。
 *
 * 这里的用例要看的是删除路径与钩子，所以直接把草稿落成真行，不跑一轮。
 */
async function seedConversation(app: ServerApp, workspaceId: string): Promise<ConversationView> {
  const created = await callMethod(app, "conversation.create", {
    workspaceId,
    agentId: "default",
    modelId: "test-model",
  });
  if (!created.conversation) throw new Error("conversation.create 没有建出对话");
  await app.conversationService.ensurePersisted(created.conversation.id);
  return created.conversation;
}

async function callMethod<M extends MethodName>(
  app: ServerApp,
  method: M,
  params: MethodParams<M> = {} as MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: CONNECTION });
}

async function connect(app: ServerApp): Promise<TestClient> {  const target = app.address;
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

/** 按指定语言调一个方法（文案随连接语言变的那些接口要用它） */
async function callInLanguage<M extends MethodName>(
  app: ServerApp,
  method: M,
  params: MethodParams<M>,
  language: ConnectionInfo["language"],
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: { ...CONNECTION, language } });
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

  it("契约里的每个方法都接上了（桥接名单之外）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const registered = new Set(Object.keys(app.handlers));

    // 归宿只有两种：在 handler 表里，或由接线层代管（hello / setLanguage / 上传）
    const homeless = METHOD_NAMES.filter(
      (method) => !registered.has(method) && !BRIDGED_METHODS.includes(method),
    );
    expect(homeless).toEqual([]);
    for (const method of registered) expect(METHOD_NAMES).toContain(method);

    // 桥接名单里的四条由接线层实现，表里不能再注册一份
    for (const method of BRIDGED_METHODS) expect(registered.has(method)).toBe(false);

    // 契约之外的方法名才回 unsupported，而且带着「不认识这个方法」这个结构化原因（R11）
    const client = await connect(app);
    for (const method of ["nope.nothing", "conversation.explode"]) {
      client.request(method, {});
      const frame = await client.queue.next();
      expect(isError(frame)).toBe(true);
      if (isError(frame)) {
        expect(frame.error.data.code).toBe("unsupported");
        expect(frame.error.data.detail).toMatchObject({ reason: "unknown_method" });
      }
    }
  });

  it("server.version / server.usage / server.capabilities 报的都是事实", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const version = await callMethod(app, "server.version");
    expect(version.version).toBe(app.version);
    expect(version.pid).toBe(process.pid);
    expect(version.startedAt).toBe(app.startedAt);

    const capabilities = await callMethod(app, "server.capabilities");
    // 清单是真实的那一份：每个方法一条，标题与说明都有句子（F-E5）
    expect(capabilities.capabilities.map((item) => item.method)).toEqual([...METHOD_NAMES]);
    expect(capabilities.capabilities[0]?.title.message.length).toBeGreaterThan(0);
    expect(capabilities.capabilities[0]?.id).toMatch(/^(F-[A-Z]\d+|D\d+)(#\w+)?$/);

    const usage = await callMethod(app, "server.usage");
    expect(usage.scope).toBe("server");
    expect(usage.usage.total.total_tokens).toBe(0);

    // 升级判定：磁盘版本与正在跑的一样 → 已经是最新，不重启（D4 / F-E3）
    const upgrade = await callMethod(app, "server.upgrade", {});
    expect(upgrade.state).toBe("already_latest");
    expect(upgrade.currentVersion).toBe(app.version);
    expect(upgrade.diskVersion).toBe(app.version);

    // 要一个磁盘上还没有的版本 → 没有可升的东西（不会平白重启）
    const nowhere = await callMethod(app, "server.upgrade", { targetVersion: "99.9.9" });
    expect(nowhere.state).toBe("not_available");
    expect(nowhere.targetVersion).toBe("99.9.9");
  });

  it("启动时通知栏是空的（R50 的警告等到真装配 agent 时才说）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const notices = await callMethod(app, "notice.list");
    expect(notices.notices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scope 的装配（R54 / L9）
// ---------------------------------------------------------------------------

describe("Scope 工厂", () => {
  it("按 cwd 从发现服务拿能力目录，认 Workspace 与临时目录两种键", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });

    // 能力目录由发现服务按 cwd 算好（R54）：MCP 是 5 层链，Skill 4 层、工具与子 Agent 各 2 层
    const paths = app.discoveryService.scopeAbilityPaths(fixture.workspaceDir.path);
    expect(paths.mcpPaths).toHaveLength(5);
    expect(paths.skillsPaths).toHaveLength(4);
    expect(paths.toolsPaths).toHaveLength(2);
    expect(paths.subAgentsPaths).toHaveLength(2);

    // 真装配一次（默认工厂，不注入替身）：Scope 的 cwd 就是项目的 cwd
    const scope = await app.scopeRegistry.acquire(workspace.id);
    expect(scope.cwd).toBe(fixture.workspaceDir.path);
    app.scopeRegistry.release(workspace.id);

    // 临时对话按目录借同一个通道（D3：只借 Scope，与 Workspace 无关）
    const transientKey = transientScopeKey(fixture.workspaceDir.path);
    const transientScope = await app.scopeRegistry.acquire(transientKey);
    expect(transientScope.cwd).toBe(fixture.workspaceDir.path);
    app.scopeRegistry.release(transientKey);

    await app.scopeRegistry.recycleAll();
    expect(app.scopeRegistry.size()).toBe(0);
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
    const conversation = await seedConversation(app, workspace.id);

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
    await seedConversation(app, workspace.id);

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

// ---------------------------------------------------------------------------
// 配置改完就生效（F-E2 / F-F9）：ConfigApplyPort 接上了没有
// ---------------------------------------------------------------------------

describe("配置生效", () => {
  it("改完配置会回收 Scope、合成一条通知，并把两样事实回给调用方", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture, { scopeIdleTimeoutMs: 10 * 60 * 1000 });
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    // 让这个项目有一个 Scope 可回收（空闲计时调长了，不会自己走）
    await app.scopeRegistry.acquire(workspace.id);
    app.scopeRegistry.release(workspace.id);
    expect(app.scopeRegistry.size()).toBe(1);

    const applied = await callMethod(app, "config.patch", {
      patch: { behavior: { autoRefreshTools: "inner-loop-start" } },
    });

    // 受影响的 Scope 被回收（下一段对话会用新配置重建）
    expect(applied.applied.recycledWorkspaceIds).toEqual([workspace.id]);
    expect(app.scopeRegistry.size()).toBe(0);
    // 一次改动合成一条通知（F-F9）
    expect(applied.applied.noticeId).not.toBeNull();
    const listed = await callMethod(app, "notice.list");
    expect(listed.notices.map((notice) => notice.id)).toContain(applied.applied.noticeId);
    // 没有需要重启才生效的项（F-E2）
    expect(applied.applied.restartRequired).toBe(false);
  });

  it("推出去的通知按收件人那条连接的语言重新渲染（D8 / localizeEvent）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const target = app.address;
    const client = await TestClient.connect(`ws://127.0.0.1:${target?.port ?? 0}/`);
    clients.push(client);
    const token = (await fs.readFile(app.paths.tokenFile, "utf8")).trim();
    await client.hello(token, { language: "zh" });

    // 库里存的是码 + 参数（按缺省语言渲染一份），出网前换成这条连接的语言
    client.request("config.patch", { patch: { limits: { maxToolOutput: 2048 } } });
    let noticeText = "";
    for (let index = 0; index < 4 && noticeText === ""; index += 1) {
      const frame = await client.queue.next();
      if (isNotification(frame) && frame.method === "notice") {
        const payload = frame.params as { notice: { text: { message: string } } };
        noticeText = payload.notice.text.message;
      }
    }
    expect(noticeText).toContain("配置已生效");
  });
});

describe("从磁盘重载（F-E1 / R63）", () => {
  it("server.reload 回收受影响 Scope、合成一条通知，并回与 config.patch 同一份报告", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture, { scopeIdleTimeoutMs: 10 * 60 * 1000 });
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    await app.scopeRegistry.acquire(workspace.id);
    app.scopeRegistry.release(workspace.id);
    expect(app.scopeRegistry.size()).toBe(1);

    const reloaded = await callMethod(app, "server.reload", { scope: "skills" });

    // 与 config.patch 同一份报告形状：这次只说要重载的那一类
    expect(reloaded.applied.reloaded).toEqual({
      config: false,
      tools: false,
      skills: true,
      agents: false,
      mcp: false,
    });
    expect(reloaded.applied.recycledWorkspaceIds).toEqual([workspace.id]);
    expect(app.scopeRegistry.size()).toBe(0);
    expect(reloaded.applied.noticeId).not.toBeNull();
    expect(reloaded.applied.restartRequired).toBe(false);
    // 配置本身没被改（重载只读不写）
    expect(reloaded.config.configDir).toBe(app.configManager.basePath);
  });

  it("不给 scope 就是全部重载；认不出的 scope 按参数不对拒", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const all = await callMethod(app, "server.reload", {});
    expect(all.applied.reloaded).toEqual({
      config: true,
      tools: true,
      skills: true,
      agents: true,
      mcp: true,
    });

    await expect(
      callMethod(app, "server.reload", { scope: "没这一类" as unknown as "config" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("D10：目录未登记成项目时先问一次", () => {
  it("create 回 requiresRegistration，问题能在 question.list（不带对话）里看到", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    // 这个 cwd 从来没登记成项目
    const created = await callMethod(app, "conversation.create", {
      cwd: fixture.workspaceDir.path,
      agentId: "default",
      modelId: "test-model",
    });
    expect(created.conversation).toBeNull();
    expect(created.requiresRegistration).toBe(true);
    expect(created.cwd).toBe(fixture.workspaceDir.path);
    expect(created.questionId).toBeTruthy();

    // 没建对话也没建项目
    expect((await callMethod(app, "workspace.list")).workspaces).toEqual([]);
    expect((await callMethod(app, "conversation.list")).total).toBe(0);

    // 问题挂不上对话，所以只能按「全库」查（R61）
    const pending = await callMethod(app, "question.list", { state: "pending" });
    const question = pending.questions.find((item) => item.id === created.questionId);
    expect(question).toBeDefined();
    expect(question?.kind).toBe("workspace_registration");
    expect(question?.conversationId).toBeNull();
  });

  it("答「要」之后登记项目，并用它把那段对话接着建出来", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const created = await callMethod(app, "conversation.create", {
      cwd: fixture.workspaceDir.path,
      agentId: "default",
      modelId: "test-model",
    });
    const questionId = created.questionId ?? "";

    const answered = await callMethod(app, "question.answer", {
      questionId,
      value: "accept",
    });
    expect(answered.question.state).toBe("answered");

    // 项目已登记（cwd 就是那个目录）
    const workspaces = await callMethod(app, "workspace.list");
    expect(workspaces.workspaces.map((item) => item.folder.cwd)).toEqual([
      fixture.workspaceDir.path,
    ]);

    // 对话也建出来了（还是草稿：没发过消息就不进列表，R56）
    const newId = answered.effects.newConversationId;
    expect(newId).toBeTruthy();
    const opened = await callMethod(app, "conversation.get", { conversationId: newId ?? "" });
    expect(opened.conversation.workspaceId).toBe(workspaces.workspaces[0]?.id);
    expect(opened.conversation.modelId).toBe("test-model");
    expect((await callMethod(app, "conversation.list")).total).toBe(0);
  });

  it("答「不要」就什么都不做", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const created = await callMethod(app, "conversation.create", {
      cwd: fixture.workspaceDir.path,
      agentId: "default",
      modelId: "test-model",
    });
    const answered = await callMethod(app, "question.answer", {
      questionId: created.questionId ?? "",
      value: "decline",
    });
    expect(answered.effects.newConversationId).toBeNull();
    expect((await callMethod(app, "workspace.list")).workspaces).toEqual([]);
    expect((await callMethod(app, "conversation.list")).total).toBe(0);
  });
});

describe("到交接线才提问（R59 / F-D2）", () => {
  /** 建一段对话并跑一轮，等它结算 */
  async function runAndSettle(app: ServerApp, workspaceId: string): Promise<void> {
    const conversation = await seedConversation(app, workspaceId);
    await callMethod(app, "conversation.send", {
      conversationId: conversation.id,
      input: { content: "说点什么" },
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (app.chatRunner.turn(conversation.id) === undefined) return;
      await wait(10);
    }
    throw new Error("这一轮没有结算");
  }

  it("越过交接线才问，未到线不问", async () => {
    const fixture = await makeFixture();
    let promptTokens = 0;
    const app = await startApp(fixture, {
      createAgent: async () =>
        new FakeAgent([
          {
            deltas: [{ content: "答完了" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: 5,
              total_tokens: promptTokens + 5,
            },
          },
        ]),
    });
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });

    // 交接线是 1000（见上面的 CONFIG）：这一轮只用了 500，不问
    promptTokens = 500;
    await runAndSettle(app, workspace.id);
    await wait(50);
    const quiet = await callMethod(app, "question.list", { state: "pending" });
    expect(quiet.questions).toEqual([]);

    // 这一轮 1500：到线了，问
    promptTokens = 1500;
    await runAndSettle(app, workspace.id);
    let asked: Awaited<ReturnType<typeof callMethod<"question.list">>>["questions"] = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      asked = (await callMethod(app, "question.list", { state: "pending" })).questions;
      if (asked.length > 0) break;
      await wait(10);
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe("handoff");
    expect(asked[0]?.options.map((option) => option.value)).toEqual(["self", "summary", "decline"]);
  });
});

// ---------------------------------------------------------------------------
// conversation.* 的三个跨服务钩子
// ---------------------------------------------------------------------------

describe("对话的三个钩子", () => {
  it("有挡着的问题时 conversation.send 被拒（D23）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const conversation = await seedConversation(app, workspace.id);

    // 一个挡着对话的问题（不可撤销动作的确认）
    await app.questionService.ask({
      conversationId: conversation.id,
      kind: "confirmation",
      prompt: { messageKey: "question.confirm.prompt", params: { action: "delete" } },
      options: [
        { value: "yes", label: { messageKey: "question.confirm.accept" } },
        { value: "no", label: { messageKey: "question.confirm.decline" } },
      ],
      blocking: true,
    });

    await expect(
      callMethod(app, "conversation.send", {
        conversationId: conversation.id,
        input: { content: "你好" },
      }),
    ).rejects.toMatchObject({ code: "question_pending" });
    // 库里没有这一轮的任何消息（受理之前就挡下了）
    const page = await callMethod(app, "message.list", { conversationId: conversation.id });
    expect(page.messages).toEqual([]);

    // 现场快照里也看得到这条问题（D22 / L5：重连先拉状态就知道有东西在等回答）
    const snapshot = await callMethod(app, "conversation.state", { conversationId: conversation.id });
    expect(snapshot.state.questions.map((item) => item.id)).toHaveLength(1);
    expect(snapshot.state.questions[0]?.blocking).toBe(true);
  });

  it("临时对话：跑完把消息交回来，库里一条都没有，也不推流式事件（R1 / R49）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture, {
      createAgent: async () =>
        new FakeAgent([{ deltas: [{ content: "一次性回答" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }]),
    });
    // 临时对话要一个 cwd 作为相对路径基准，但不需要登记成项目
    const client = await connect(app);

    client.request("conversation.transient", {
      cwd: fixture.workspaceDir.path,
      input: { content: "随便问问" },
      agentId: "default",
      modelId: "test-model",
    });
    const frame = await client.queue.next(5000);
    if (!isSuccess(frame)) throw new Error(`临时对话没跑成：${JSON.stringify(frame)}`);
    const result = frame.result as ConversationTransientResult;
    expect(result.message.content).toBe("一次性回答");
    expect(result.problem).toBeNull();

    // 不落库：对话与消息表都是空的
    expect((await callMethod(app, "conversation.list")).total).toBe(0);
    // 不推流式事件：回包之后队列里不该再冒出增量或六态
    await wait(120);
    expect(client.queue.size()).toBe(0);
    app.scopeRegistry.recycleAll();
  });
});

// ---------------------------------------------------------------------------
// 缺省语言（D8 / 裁定 R58）
// ---------------------------------------------------------------------------

/** 往夹具的 config.json 里补几个字段（`ConfigManager` 读原文，不认识的字段原样保留） */
async function patchConfigFile(fixture: Fixture, patch: Record<string, unknown>): Promise<void> {
  const path = join(fixture.dataRoot.path, "config.json");
  const current = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  await fs.writeFile(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf8");
}

/** 拿一个当前空闲的端口（先占再放：只为了拿到一个数） */
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * 等一件真实异步的事做完（收尾要关真套接字、关库，这些不是微任务）。
 *
 * 每轮让出 10ms 真时间：`setImmediate` 循环跑得比套接字关闭快得多，等不到结果。
 */
async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(message);
}

/** 让真实异步推进几轮（但还不足以等完一次收尾） */
async function flushAsync(): Promise<void> {
  await wait(20);
}

/** 手写一次握手（不经过 harness 的 `connect`，因为这里要控制带不带 language） */
async function handshake(
  app: ServerApp,
  language?: "en" | "zh",
): Promise<{ language: string; capabilities: string[] }> {
  const target = app.address;
  if (!target) throw new Error("服务端没在监听");
  const client = await TestClient.connect(`ws://127.0.0.1:${target.port}/`);
  clients.push(client);
  const token = (await fs.readFile(app.paths.tokenFile, "utf8")).trim();
  const frame = await client.hello(token, language === undefined ? {} : { language });
  return frame.result as { language: string; capabilities: string[] };
}

describe("缺省语言（D8 / 裁定 R58）", () => {
  it("hello 不带 language 时用配置里的语言，带了就以连接为准", async () => {
    const fixture = await makeFixture();
    await patchConfigFile(fixture, { language: "zh" });
    const app = await startApp(fixture);

    expect((await handshake(app)).language).toBe("zh");
    // 连接自己声明的语言优先级更高（语言挂连接，断开即忘）
    expect((await handshake(app, "en")).language).toBe("en");
  });

  it("配置里没写 language 时缺省英文", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    expect((await handshake(app)).language).toBe("en");
  });

  it("config.setDefaults 写得进 language，下一条连接立刻用新的缺省", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    expect((await handshake(app)).language).toBe("en");

    // 契约的 `DefaultSelection` 还没有 `language` 这一项（`wire/methods.ts` 不在本轮的
    // 可改范围里），服务端按 `DefaultsInput` 收下它 —— 这一句断言就是把那条路打通。
    const params = { defaults: { language: "zh" } } as unknown as MethodParams<"config.setDefaults">;
    const written = await callMethod(app, "config.setDefaults", params);
    expect(written.config.configDir).toBe(fixture.dataRoot.path);

    expect((await handshake(app)).language).toBe("zh");
    // 认不出来的语言直接驳回，不悄悄换成英文
    const bad = { defaults: { language: "fr" } } as unknown as MethodParams<"config.setDefaults">;
    await expect(callMethod(app, "config.setDefaults", bad)).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("server.capabilities 按连接语言渲染，id 与顺序不变（R57 / R58）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const english = await callInLanguage(app, "server.capabilities", {}, "en");
    const chinese = await callInLanguage(app, "server.capabilities", {}, "zh");

    expect(english.capabilities.map((item) => item.id)).toEqual(
      chinese.capabilities.map((item) => item.id),
    );
    expect(english.capabilities.map((item) => item.method)).toEqual(
      chinese.capabilities.map((item) => item.method),
    );
    expect(english.capabilities[0]?.title.message).not.toBe(chinese.capabilities[0]?.title.message);
    // 同一份事实：码与参数不动，只有句子换了语言
    expect(english.capabilities[0]?.title.messageKey).toBe(chinese.capabilities[0]?.title.messageKey);
  });
});

// ---------------------------------------------------------------------------
// 端口的三档来源（D25 / 裁定 R67）
// ---------------------------------------------------------------------------

describe("端口的三档来源（D25 / 裁定 R67）", () => {
  it("<dataRoot>/server.json 的 port 会被采用", async () => {
    const fixture = await makeFixture();
    const port = await freePort();
    await fs.writeFile(
      join(fixture.dataRoot.path, "server.json"),
      JSON.stringify({ port }),
      "utf8",
    );

    const app = await createServer({
      aiZenDir: fixture.dataRoot.path,
      local: true,
      exit: () => undefined,
    });
    apps.push(app);
    const target = await app.start();
    expect(target.port).toBe(port);
  });

  it("启动参数优先于配置文件", async () => {
    const fixture = await makeFixture();
    const fromFile = await freePort();
    await fs.writeFile(
      join(fixture.dataRoot.path, "server.json"),
      JSON.stringify({ port: fromFile }),
      "utf8",
    );

    // `startApp` 传的是 `port: 0`（系统分配）：配置文件那一档轮不到它说话
    const app = await startApp(fixture);
    expect(app.address?.port).toBeGreaterThan(0);
    expect(app.address?.port).not.toBe(fromFile);
  });

  it("配置文件里的端口不合法 → config_invalid，不静默回落", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(
      join(fixture.dataRoot.path, "server.json"),
      JSON.stringify({ port: 70000 }),
      "utf8",
    );

    await expect(
      createServer({ aiZenDir: fixture.dataRoot.path, local: true, exit: () => undefined }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        ServerError.is(error) &&
        error.code === "config_invalid" &&
        (error.detail as { field?: string }).field === "port",
    );
  });

  it("两档都没给时回落默认 8790（解析这一跳的结论，不去真占 8790）", async () => {
    const fixture = await makeFixture();
    // 没有 server.json、也不给 port：解析结果就是默认端口
    expect(resolveListenTarget({ local: true, port: undefined, configPort: undefined }).port).toBe(
      DEFAULT_PORT,
    );
    // 同一个数据根上建出来（不 start）不会因为端口而失败
    const app = await createServer({
      aiZenDir: fixture.dataRoot.path,
      local: true,
      port: 0,
      exit: () => undefined,
    });
    apps.push(app);
    expect(app.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 升级自检（D4 / F-E3 / 裁定 R66）
// ---------------------------------------------------------------------------

describe("升级自检（D4 / F-E3 / 裁定 R66）", () => {
  /** 把自检定时器换成手摇的：用例自己决定什么时候「过了 30 秒」，不必真等 */
  function manualTimer(): {
    startVersionTimer: (task: () => void, everyMs: number) => () => void;
    tick: () => void;
    cancels: number[];
    starts: number[];
  } {
    let task: (() => void) | null = null;
    const cancels: number[] = [];
    const starts: number[] = [];
    return {
      startVersionTimer: (nextTask, everyMs) => {
        task = nextTask;
        starts.push(everyMs);
        return () => {
          cancels.push(everyMs);
          task = null;
        };
      },
      tick: () => {
        if (task === null) throw new Error("自检定时器已经被清掉");
        task();
      },
      cancels,
      starts,
    };
  }

  it("磁盘版本变新就收尾退出并推通知；定时器在 stop() 里清掉", async () => {
    const fixture = await makeFixture();
    let disk = "0.0.1";
    const facts: ExitFacts[] = [];
    const timer = manualTimer();

    const app = await createServer({
      aiZenDir: fixture.dataRoot.path,
      port: 0,
      local: true,
      version: "1.0.0",
      diskVersion: () => disk,
      versionCheckIntervalMs: 30_000,
      startVersionTimer: timer.startVersionTimer,
      exit: (exitFacts) => {
        facts.push(exitFacts);
      },
    });
    apps.push(app);
    await app.start();
    // 启动时按 30 秒起了那一个低频定时器
    expect(timer.starts).toEqual([30_000]);

    // 磁盘上还是旧版本：自检什么都不做
    timer.tick();
    await flushAsync();
    expect(app.running).toBe(true);
    expect(facts).toEqual([]);
    expect(timer.cancels).toEqual([]);

    // 新版本落盘：下一次自检收尾退出（由启动方式重拉）
    disk = "1.1.0";
    timer.tick();
    await until(() => facts.length > 0, "自检没有收尾退出");
    expect(app.running).toBe(false);
    expect(facts.map((item) => item.reason)).toEqual(["requested"]);

    // 说明「为什么进程要走」的那条通知（收尾之后库已关，重开一份读库里的行）
    const reopened = new Database(app.paths.dbFile);
    try {
      const rows = await reopened.all<{ code: string; params: string | null }>(
        "SELECT code, params FROM notices",
      );
      expect(rows.map((row) => row.code)).toEqual(["notice.upgradeRestarting"]);
      expect(rows[0]?.params).toContain("1.1.0");
    } finally {
      await reopened.close();
    }

    // 定时器已经清掉：不会再有一次检查
    expect(timer.cancels).toEqual([30_000]);
  });

  it("磁盘版本没变（或更旧）时一直不动", async () => {
    const fixture = await makeFixture();
    let disk = "1.0.0";
    const facts: ExitFacts[] = [];
    const timer = manualTimer();

    const app = await createServer({
      aiZenDir: fixture.dataRoot.path,
      port: 0,
      local: true,
      version: "1.0.0",
      diskVersion: () => disk,
      startVersionTimer: timer.startVersionTimer,
      exit: (exitFacts) => {
        facts.push(exitFacts);
      },
    });
    apps.push(app);
    await app.start();

    timer.tick();
    await flushAsync();
    expect(app.running).toBe(true);

    // 回退不算升级（重启只会把用户拉回旧版本）
    disk = "0.9.0";
    timer.tick();
    await flushAsync();
    expect(app.running).toBe(true);
    expect(facts).toEqual([]);

    // 收尾把定时器清掉（不留悬挂定时器）
    await app.stop("requested");
    expect(timer.cancels).toHaveLength(1);
    expect(() => timer.tick()).toThrow("自检定时器已经被清掉");
  });
});
