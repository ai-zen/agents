/**
 * `HostApp`（单根）的验收：组装、启停对称、单实例、退出判据、删除路径的跨层补齐。
 *
 * 这里关心的是「谁被接上了、什么时刻会发生什么」，所以有一部分用例直接调用 handler 表
 * （省掉网络这一层），需要看连接数变化的那几条才真开 WebSocket —— 端到端那条完整链路在
 * `session.flow.test.ts` 里，真起进程的那条在 `serve.process.test.ts` 里。
 */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHost, resolveHostVersion } from "./app.js";
import type { ExitFacts, HostApp, HostAppOptions } from "./app.js";
import { resolvePaths } from "./config.js";
import { DEFAULT_PORT, resolveListenTarget } from "./config.js";
import type { ConnectionInfo } from "./net/index.js";
import { encodeChunkFrame } from "./net/index.js";
import { readHostFile, writeHostFile } from "./net/discovery.js";
import {
  isError,
  isNotification,
  isSuccess,
  listDir,
  makeTempDir,
  TestClient,
  wait,
  type TempDir,
} from "./net/TestSupport.js";
import { BRIDGED_METHODS } from "./handlers/index.js";
import { createFakeScope, deferred, FakeAgent } from "./runtime/TestSupport.js";
import { Scope } from "@ai-zen/agents-sdk";
import { transientScopeKey } from "./runtime/TransientRunner.js";
import { Database } from "./storage/index.js";
import { METHOD_NAMES } from "./wire/index.js";
import type { LocalMessageContentSection } from "./wire/index.js";
import { HostError } from "./wire/index.js";
import type {
  AssetRef,
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
const apps: HostApp[] = [];
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
async function startApp(fixture: Fixture, options: HostAppOptions = {}): Promise<HostApp> {
  const app = await createHost({
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
async function seedConversation(app: HostApp, workspaceId: string): Promise<ConversationView> {
  const created = await callMethod(app, "conversation.create", {
    workspaceId,
    agentId: "default",
    modelId: "test-model",
  });
  if (!created.conversation) throw new Error("conversation.create 没有建出对话");
  await app.conversationService.ensurePersisted(created.conversation.id);
  return created.conversation;
}

/** 带本地扩展字段的内容段（字面量直接写的话，core 的类型不认这些 `__` 键） */
function localSections(...sections: LocalMessageContentSection[]): LocalMessageContentSection[] {
  return sections;
}

/**
 * 造一条引用素材的用户消息，并写下那条关系行（等价于 `ChatRunner` 在消息落库那一刻做的事）。
 *
 * 素材行本身不记对话，所以「删对话会带走哪些素材」只能靠关系行回答。
 */
async function seedAssetMessage(
  app: HostApp,
  conversationId: string,
  assetId: string,
  suffix = "1",
): Promise<string> {
  const messageId = `msg-${assetId}-${suffix}`;
  await app.messages.upsert({
    id: messageId,
    conversationId,
    role: "user",
    status: "completed",
    content: localSections({ type: "image_url", image_url: { url: "" }, __asset_id: assetId }),
    createdAt: Date.now(),
  });
  await app.assets.linkAsset({ conversationId, messageId, assetId, createdAt: Date.now() });
  return messageId;
}

async function callMethod<M extends MethodName>(
  app: HostApp,
  method: M,
  params: MethodParams<M> = {} as MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: CONNECTION });
}

async function connect(app: HostApp): Promise<TestClient> {  const target = app.address;
  if (!target) throw new Error("宿主没在监听");
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

describe("HostApp 的组装", () => {
  it("按对象图的顺序造出全部零件，start / stop 对称", async () => {
    const fixture = await makeFixture();
    const app = await createHost({
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
    expect(app.scopeRegistry.workspaceIds().length).toBe(0);
    expect(app.runRegistry.size()).toBe(0);
    // 服务层要的两件运行时事实（模型与档位在会话行上，不在这里）
    expect(app.conversationRuntime.isRunning("没有这段对话")).toBe(false);
    expect(typeof app.conversationRuntime.forget).toBe("function");
    // 服务
    expect(typeof app.workspaceService.create).toBe("function");
    expect(typeof app.conversationService.create).toBe("function");
    expect(typeof app.messageService.list).toBe("function");
    expect(typeof app.searchService.messages).toBe("function");
    expect(typeof app.credentialService.create).toBe("function");
    expect(typeof app.assetService.prepareAttachments).toBe("function");
    // 接线
    expect(app.version).toBe(resolveHostVersion());
    expect(app.local).toBe(true);
    expect(app.running).toBe(false);

    // 没监听之前不该有发现文件
    expect(await readHostFile(app.paths)).toBeNull();

    const target = await app.start();
    expect(target.port).toBeGreaterThan(0);
    expect(app.running).toBe(true);
    const info = await readHostFile(app.paths);
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
    expect(await readHostFile(app.paths)).toBeNull();
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

  it("host.version 报的都是事实", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const version = await callMethod(app, "host.version");
    expect(version.version).toBe(app.version);
    expect(version.pid).toBe(process.pid);
    expect(version.startedAt).toBe(app.startedAt);

    // 升级判定：磁盘版本与正在跑的一样 → 已经是最新，不重启（D4 / F-E3）
    const upgrade = await callMethod(app, "host.upgrade", {});
    expect(upgrade.state).toBe("already_latest");
    expect(upgrade.currentVersion).toBe(app.version);
    expect(upgrade.diskVersion).toBe(app.version);

    // 要一个磁盘上还没有的版本 → 没有可升的东西（不会平白重启）
    const nowhere = await callMethod(app, "host.upgrade", { targetVersion: "99.9.9" });
    expect(nowhere.state).toBe("not_available");
    expect(nowhere.targetVersion).toBe("99.9.9");
  });

  it("启动时通知栏是空的（R50 的警告等到真装配 agent 时才说）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const notices = await callMethod(app, "notice.list");
    expect(notices.notices).toEqual([]);
  });

  it("config.json 坏了：恢复出厂、写回磁盘、落一条带文件路径的 warning（D32）", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(join(fixture.dataRoot.path, "config.json"), "{ 这不是 JSON", "utf8");

    const app = await startApp(fixture);

    const notices = await callMethod(app, "notice.list");
    const recovered = notices.notices.filter(
      (notice) => notice.text.code === "notice.configRecovered",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.level).toBe("warning");
    // 文案里是哪个文件坏了（缺省语言英文）
    expect(recovered[0]?.text.message).toContain(app.configManager.configPath);
    expect(recovered[0]?.text.message).toContain("factory settings");

    // 磁盘上已经是合法的出厂配置：下次启动不用再恢复一次
    const onDisk = JSON.parse(
      await fs.readFile(app.configManager.configPath, "utf8"),
    ) as { models: unknown[] };
    expect(onDisk.models.length).toBeGreaterThan(0);
  });

  it("host.json 坏了：恢复出厂、写回合法的 {}、落一条带文件路径的 warning（D32）", async () => {
    const fixture = await makeFixture();
    const hostConfigFile = join(fixture.dataRoot.path, "host.json");
    await fs.writeFile(hostConfigFile, "{ 这不是 JSON", "utf8");

    // 不给端口参数才会去读 host.json；这一条不监听（8790 留给真进程那几条用例）
    const app = await createHost({
      aiZenDir: fixture.dataRoot.path,
      exit: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
    });
    apps.push(app);

    const notices = await callMethod(app, "notice.list");
    const recovered = notices.notices.filter(
      (notice) => notice.text.code === "notice.configRecovered",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.level).toBe("warning");
    expect(recovered[0]?.text.message).toContain(hostConfigFile);

    await expect(fs.readFile(hostConfigFile, "utf8")).resolves.toBe("{}\n");
  });

  it("mcp.json 坏了：宿主要能起来、恢复出厂、残骸留档、落一条带文件路径的 warning（D32）", async () => {
    const fixture = await makeFixture();
    const mcpFile = join(fixture.dataRoot.path, "mcp.json");
    const broken = "{ 这不是 JSON";
    await fs.writeFile(mcpFile, broken, "utf8");

    // 真起一次宿主：坏 mcp.json 不该把装配拦下来
    const app = await startApp(fixture);
    expect(app.running).toBe(true);
    // 恢复的是同一个文件：SDK 的 mcpPath 与发现里那一层是同一路径
    expect(app.configManager.mcpPath).toBe(mcpFile);

    const notices = await callMethod(app, "notice.list");
    const recovered = notices.notices.filter(
      (notice) => notice.text.code === "notice.configRecovered",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.level).toBe("warning");
    expect(recovered[0]?.text.message).toContain(mcpFile);
    expect(recovered[0]?.text.message).toContain("factory settings");

    // 磁盘上已经是合法的出厂配置，残骸原封不动
    const onDisk = JSON.parse(await fs.readFile(mcpFile, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.mcpServers).sort()).toEqual(["chrome-devtools", "socket-pty"]);
    await expect(fs.readFile(`${mcpFile}.broken`, "utf8")).resolves.toBe(broken);

    // 发现里那一层不再是 broken（数据根下只有这一个 mcp 层）
    const discovery = await callMethod(app, "config.getDiscovery");
    const mine = discovery.discovery.mcps.filter((layer) => layer.path === mcpFile);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.state).toBe("ok");
    expect(mine[0]?.entries.map((entry) => entry.id).sort()).toEqual([
      "chrome-devtools",
      "socket-pty",
    ]);
    const underDataRoot = discovery.discovery.mcps.filter((layer) =>
      layer.path.startsWith(fixture.dataRoot.path),
    );
    expect(underDataRoot.every((layer) => layer.state !== "broken")).toBe(true);
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
    const scope = await app.scopeRegistry.create(workspace.id);
    expect(scope.cwd).toBe(fixture.workspaceDir.path);

    // 临时对话按目录借同一个通道（D3：只借 Scope，与 Workspace 无关）
    const transientKey = transientScopeKey(fixture.workspaceDir.path);
    const transientScope = await app.scopeRegistry.create(transientKey);
    expect(transientScope.cwd).toBe(fixture.workspaceDir.path);

    await app.scopeRegistry.disposeAll();
    expect(app.scopeRegistry.workspaceIds().length).toBe(0);
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
    await writeHostFile(pathsOf(fixture), running);

    const app = await startApp(fixture);
    expect(app.attached).toBe(true);
    expect(app.running).toBe(false);
    expect(app.address).toEqual({ host: "127.0.0.1", port: 45671 });

    // 挂靠时不碰别人那份发现文件（本进程没在监听，删了它客户端就连不上了）
    await app.stop("requested");
    expect(await readHostFile(pathsOf(fixture))).toEqual(running);
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
    await writeHostFile(pathsOf(fixture), stale);

    const app = await startApp(fixture);
    expect(app.running).toBe(true);
    const info = await readHostFile(app.paths);
    expect(info?.pid).toBe(process.pid);
    expect(info?.port).toBe(app.address?.port);
    expect(info?.port).not.toBe(stale.port);
  });

  it("发现文件坏了 → 清掉再起（坏文件不该让服务起不来）", async () => {
    const fixture = await makeFixture();
    const paths = pathsOf(fixture);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.hostFile, "{ 这不是 JSON", "utf8");

    const app = await startApp(fixture);
    expect(app.running).toBe(true);
    expect((await readHostFile(app.paths))?.port).toBe(app.address?.port);
  });
});

/** 还没起服务时也要能按同一套规则算出路径（写「别人的」发现文件用） */
function pathsOf(fixture: Fixture) {
  return resolvePaths(fixture.dataRoot.path);
}

// ---------------------------------------------------------------------------
// 退出判据（PRD L4 / R53）
// ---------------------------------------------------------------------------

/** 一轮的 `send` 被闸门按住的假 agent：结算由用例放行，用来钉住「跑着的时候不退」 */
class GatedAgent extends FakeAgent {
  constructor(private readonly gate: Promise<void>) {
    super([
      {
        deltas: [{ content: "跑完了" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
  }

  async send(content: Parameters<FakeAgent["send"]>[0]): ReturnType<FakeAgent["send"]> {
    await this.gate;
    return await super.send(content);
  }
}

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

  it("连过然后断开、也没有在跑的轮次 → 收尾并退出（手里还剩 Scope 也照退）", async () => {
    const fixture = await makeFixture();
    const exits: ExitFacts[] = [];
    // 真 `Scope` + 记账式插件：收尾时「Scope 被销掉、插件的 `dispose` 被调到」这条链路是真的
    const fake = createFakeScope(fixture.workspaceDir.path);
    const app = await startApp(fixture, {
      exit: (facts) => {
        exits.push(facts);
      },
      createScope: async () => fake.scope,
    });
    const disposeAll = vi.spyOn(app.scopeRegistry, "disposeAll");

    const client = await connect(app);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    // 手里握着一个 Scope：它不会自己消失（没有空闲计时、也没有引用计数）
    await app.scopeRegistry.create(workspace.id);

    // 有连接 → 不判（连接就是「还有人等着说话」）
    await app.checkExit();
    expect(exits).toEqual([]);

    // 连接断开、也没有在跑的轮次 → 什么都不欠了：收尾（`disposeAll` 把 Scope 与 MCP 连接一起拆）并退出
    await client.close();
    await until(() => exits.length === 1, "最后一个客户端断开后应当收尾并退出");
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(fake.plugin.disposeCalls).toBe(1);
    expect(app.scopeRegistry.workspaceIds()).toEqual([]);
    expect(app.running).toBe(false);
    // 事实是「收尾那一刻还持有 1 个 Scope」（随后被 `disposeAll` 拆掉），不是 0
    expect(exits[0]).toEqual({ reason: "idle", connections: 0, runs: 0, scopes: 1 });
  });

  it("还有一轮在跑就不退；那一轮结算之后才退", async () => {
    const fixture = await makeFixture();
    const exits: ExitFacts[] = [];
    // 闸门按住这一轮的 `send`：放行之前 `runRegistry` 里一直有它
    const gate = deferred<void>();
    const fake = createFakeScope(fixture.workspaceDir.path);
    const app = await startApp(fixture, {
      exit: (facts) => {
        exits.push(facts);
      },
      createScope: async () => fake.scope,
      createAgent: async () => new GatedAgent(gate.promise),
    });

    const client = await connect(app);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const conversation = await seedConversation(app, workspace.id);

    await callMethod(app, "conversation.send", {
      conversationId: conversation.id,
      input: { content: "慢慢答" },
    });
    expect(app.runRegistry.size()).toBe(1);

    // 连接断了，但这一轮还在跑：还有活欠着，不退
    await client.close();
    await wait(50);
    await app.checkExit();
    expect(exits).toEqual([]);
    expect(app.running).toBe(true);

    // 放行 → 这一轮结算 → `onTurnSettled` 再判一次 → 收尾退出
    gate.resolve();
    await until(() => exits.length === 1, "最后一轮结算之后应当收尾并退出");
    expect(exits[0]).toEqual({ reason: "idle", connections: 0, runs: 0, scopes: 1 });
    expect(fake.plugin.disposeCalls).toBe(1);
    expect(app.scopeRegistry.workspaceIds()).toEqual([]);
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
    // 归属只在关系行上：一条消息引用它，删对话时它才算「受影响的素材」
    const assetMessageId = await seedAssetMessage(app, conversation.id, ref.assetId);

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
    expect(await app.assets.countReferences(ref.assetId)).toBe(0);
    expect(assetMessageId.length).toBeGreaterThan(0);
    // 运行时那边这段对话的现场被丢掉了
    expect(app.chatRunner.turn(conversation.id)).toBeUndefined();
  });

  it("同一张图贴到两个对话：磁盘一份、素材一行、关系两行；删掉一个不算完，删掉最后一个才清字节", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const first = await seedConversation(app, workspace.id);
    const second = await seedConversation(app, workspace.id);

    // 同一份字节传两次（第二次走全局去重：回的也是同一个 assetId）
    const bytes = new TextEncoder().encode("same-image-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploadOnce = async (conversationId: string): Promise<string> => {
      const tempPath = join(app.paths.assetsDir, `.upload-${conversationId}.part`);
      await fs.mkdir(app.paths.assetsDir, { recursive: true });
      await fs.writeFile(tempPath, bytes);
      const ref = await app.assetService.finalizeUpload({
        uploadId: `upload-${conversationId}`,
        tempPath,
        mime: "image/png",
        bytes: bytes.byteLength,
        sha256,
        name: "same.png",
        purpose: "message_image",
        conversationId,
      });
      return ref.assetId;
    };
    const firstAssetId = await uploadOnce(first.id);
    const secondAssetId = await uploadOnce(second.id);
    expect(secondAssetId).toBe(firstAssetId);

    // 素材表里一行（sha256 全局唯一），磁盘上一份
    const assetRows = await app.db.all<{ id: string }>("SELECT id FROM assets");
    expect(assetRows.map((row) => row.id)).toEqual([firstAssetId]);
    const assetPath = join(app.paths.dataRoot, "assets", `${firstAssetId}.png`);
    expect((await fs.readdir(app.paths.assetsDir)).filter((name) => !name.startsWith("."))).toEqual(
      [`${firstAssetId}.png`],
    );

    // 两个对话各有一条消息引用它 → 关系两行
    await seedAssetMessage(app, first.id, firstAssetId, "a");
    await seedAssetMessage(app, second.id, firstAssetId, "b");
    expect(await app.assets.countReferences(firstAssetId)).toBe(2);
    // 「几个会话引用了这张图」
    expect(await app.assets.countConversations(firstAssetId)).toBe(1 + 1);
    expect([...(await app.assets.listConversationIds(firstAssetId))].sort()).toEqual(
      [first.id, second.id].sort(),
    );

    // 删掉其中一个对话：关系行消失，素材行与文件仍在
    await callMethod(app, "conversation.delete", { conversationId: first.id });
    expect(await app.assets.countConversations(firstAssetId)).toBe(1);
    expect(await app.assetService.get(firstAssetId)).toBeDefined();
    expect(await exists(assetPath)).toBe(true);

    // 删掉最后一个引用：文件与行一起消失
    await callMethod(app, "conversation.delete", { conversationId: second.id });
    expect(await app.assets.countReferences(firstAssetId)).toBe(0);
    expect(await app.assetService.get(firstAssetId)).toBeUndefined();
    expect(await exists(assetPath)).toBe(false);
  });

  it("删项目会销毁它的 Scope 并连名下对话一起清（R43）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    await seedConversation(app, workspace.id);

    // 先把这个项目的 Scope 建出来（它不会自己消失）
    await app.scopeRegistry.create(workspace.id);
    expect(app.scopeRegistry.workspaceIds().length).toBe(1);

    const result = await callMethod(app, "workspace.remove", { workspaceId: workspace.id });
    expect(result.removed).toBe(true);
    expect(result.consequences.conversations).toBe(1);
    // Scope 被主动销毁（MCP 连接在这里断开），名下对话也没了
    expect(app.scopeRegistry.workspaceIds().length).toBe(0);
    const remaining = await callMethod(app, "conversation.list", { workspaceId: workspace.id });
    expect(remaining.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 带图的第一条消息：草稿对话在上传这一步落库（R56 / F-H8）
// ---------------------------------------------------------------------------

describe("草稿对话上的上传（R56 / F-H8）", () => {
  it("begin → chunk → end 走通：对话落库、只写一条隐藏的 cwd 消息、素材登记", async () => {
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
    const conversationId = conversation?.id ?? "";
    // 建出来还只是草稿：库里没有这一行（R56）
    expect(await app.db.all("SELECT id FROM conversations")).toEqual([]);

    const client = await connect(app);
    const bytes = new Uint8Array(2048);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    const began = await callThroughPush(client, "asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      name: "photo.png",
      conversationId,
    });
    const uploadId = (began as { uploadId: string }).uploadId;

    // 落库发生在 `asset.begin`：那一刻这段对话已经在库里，且带上了那条隐藏的 cwd 消息
    expect((await app.db.all<{ id: string }>("SELECT id FROM conversations")).map((row) => row.id))
      .toEqual([conversationId]);

    client.sendBinary(encodeChunkFrame(uploadId, bytes.subarray(0, 1000)));
    client.sendBinary(encodeChunkFrame(uploadId, bytes.subarray(1000)));
    // 分片没有回执：用一次请求当栅栏，确认它们都已经被处理
    await callThroughPush(client, "host.setLanguage", { language: "en" });

    const ended = await callThroughPush(client, "asset.end", {
      uploadId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const asset = (ended as { asset: AssetRef }).asset;
    expect(asset).toMatchObject({ mime: "image/png", bytes: bytes.byteLength, name: "photo.png" });
    // 素材进库了（上传落定的那一行），归属要等消息落库那一刻才有关系行
    expect(await app.assetService.get(asset.assetId)).toBeDefined();
    expect(await app.assets.listAssetIdsByConversation(conversationId)).toEqual([]);

    // 库里只有一条隐藏消息，正文含这段对话的 cwd
    const hidden = await hiddenMessagesOf(app, conversationId);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.content).toContain(fixture.workspaceDir.path);

    // 再落一次同一个草稿（例如第二张图、或者紧接着那次 send）：行与 cwd 消息都不该多出来
    await app.conversationService.ensurePersisted(conversationId);
    expect(await app.db.all("SELECT id FROM conversations")).toHaveLength(1);
    expect(await hiddenMessagesOf(app, conversationId)).toHaveLength(1);
  });

  it("不存在的 conversationId：可判别的业务码，不落临时文件", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const client = await connect(app);

    const id = client.request("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: 16,
      conversationId: "no-such-conversation",
    });
    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    expect(frame.id).toBe(id);
    expect(frame.error.data.code).toBe("not_found");
    expect(frame.error.data.detail).toMatchObject({
      conversationId: "no-such-conversation",
    });
    expect(await listDir(app.paths.assetsDir)).toEqual([]);
  });
});

/** 一段对话名下那条隐藏的 cwd 消息（`data.hidden` 为真的那些） */
async function hiddenMessagesOf(
  app: HostApp,
  conversationId: string,
): Promise<Array<{ content: string; data: string | null }>> {
  const rows = await app.db.all<{ content: string; data: string | null }>(
    "SELECT content, data FROM messages WHERE conversationId = ? ORDER BY seq",
    [conversationId],
  );
  return rows.filter((row) => row.data !== null && row.data.includes("\"hidden\":true"));
}

/**
 * 发一个请求并取回它的回包，跳过中间插进来的推送。
 *
 * `asset.begin` 会在处理过程中落库，于是先产生一条 `conversation.changed`（R47：它排在回包之后
 * 出网，但对用例来说仍是队列里的一帧）。
 */
async function callThroughPush(
  client: TestClient,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = client.request(method, params);
  for (;;) {
    const frame = await client.queue.next();
    if (isNotification(frame)) continue;
    if (!isSuccess(frame)) throw new Error(`期望成功响应，拿到：${JSON.stringify(frame)}`);
    if (frame.id !== id) throw new Error(`回包对不上：期望 ${id}，拿到 ${frame.id}`);
    return frame.result;
  }
}

// ---------------------------------------------------------------------------
// 配置改完就生效（F-E2 / F-F9）：ConfigApplyPort 接上了没有
// ---------------------------------------------------------------------------

describe("配置生效", () => {
  it("生效 = 就地刷新同一个 Scope：实例不变、读到新值、不销毁任何一个", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    // 让这个项目有一个 Scope 可刷（它不会自己消失）
    const scope = await app.scopeRegistry.create(workspace.id);
    expect(app.scopeRegistry.workspaceIds().length).toBe(1);
    expect(scope.config.maxToolOutput).not.toBe(2048);

    // 配置生效不该销毁任何 Scope（销毁 = `dispose()`：MCP 连接也会一起断）
    const dispose = vi.spyOn(Scope.prototype, "dispose");
    let applied: MethodResult<"config.patch">;
    try {
      applied = await callMethod(app, "config.patch", {
        patch: { limits: { maxToolOutput: 2048 } },
      });
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      dispose.mockRestore();
    }

    // 刷的是「已经存在的那个」：同一个对象，不是拆了重建出来的另一个
    expect(app.scopeRegistry.get(workspace.id)).toBe(scope);
    expect(app.scopeRegistry.workspaceIds().length).toBe(1);
    // 而且它读到的是新值（config 是活的：refresh() 时跟着换掉）
    expect(scope.config.maxToolOutput).toBe(2048);
    expect(scope.env.config.maxToolOutput).toBe(2048);

    // 报告里点名「这些项目的 Scope 已就地刷新」
    expect(applied.applied.refreshedWorkspaceIds).toEqual([workspace.id]);
    // 一次改动合成一条通知（F-F9）
    expect(applied.applied.noticeId).not.toBeNull();
    const listed = await callMethod(app, "notice.list");
    expect(listed.notices.map((notice) => notice.id)).toContain(applied.applied.noticeId);
    // 没有需要重启才生效的项（F-E2）
    expect(applied.applied.restartRequired).toBe(false);
  });

  it("只改某个项目的 MCP：只刷那几个项目已经存在的 Scope，别的项目不碰", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const first = await callMethod(app, "workspace.create", { cwd: fixture.workspaceDir.path });
    const secondCwd = join(fixture.workspaceDir.path, "second");
    await fs.mkdir(secondCwd, { recursive: true });
    const second = await callMethod(app, "workspace.create", { cwd: secondCwd });

    for (const workspaceId of [first.workspace.id, second.workspace.id]) {
      await app.scopeRegistry.create(workspaceId);
    }
    const firstScope = app.scopeRegistry.get(first.workspace.id);
    const secondScope = app.scopeRegistry.get(second.workspace.id);

    const saved = await callMethod(app, "config.saveMcp", {
      scope: "workspace",
      workspaceId: first.workspace.id,
      entry: { id: "demo", transport: "stdio", command: "node" },
    });

    // 只刷改到的那个项目；两个 Scope 都还是原来那个实例（一个都没重建）
    expect(saved.applied.refreshedWorkspaceIds).toEqual([first.workspace.id]);
    expect(app.scopeRegistry.get(first.workspace.id)).toBe(firstScope);
    expect(app.scopeRegistry.get(second.workspace.id)).toBe(secondScope);
    expect(app.scopeRegistry.workspaceIds().length).toBe(2);
  });

  it("生效时也换掉受影响的 agent：每个刷过的项目都 markStale 一次（配置改了就生效的唯一保证）", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    // 让这个项目有一个存在的 Scope（刷的范围就是「现存的那些」）
    await app.scopeRegistry.create(workspace.id);

    // `Scope.refresh()` 刷得动能力，刷不动已经建好的模型客户端 —— 所以必须显式让 agent 陈旧
    const markStale = vi.spyOn(app.agentRegistry, "markStale");
    try {
      await callMethod(app, "config.patch", { patch: { limits: { maxToolOutput: 2048 } } });
      expect(markStale.mock.calls.map((call) => call[0])).toEqual([workspace.id]);
    } finally {
      markStale.mockRestore();
    }
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
  it("host.reload 刷新受影响 Scope、合成一条通知，并回与 config.patch 同一份报告", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const scope = await app.scopeRegistry.create(workspace.id);
    expect(app.scopeRegistry.workspaceIds().length).toBe(1);

    const reloaded = await callMethod(app, "host.reload", {});

    // 与 config.patch 同一份报告形状：重载就是「五类全重读一遍」（`scope` 那一档已删，
    // 它从来没有调用方 —— 见 `ConfigService.reloadedOf()` 的注释）
    expect(reloaded.applied.reloaded).toEqual({
      config: true,
      tools: true,
      skills: true,
      agents: true,
      mcp: true,
    });
    expect(reloaded.applied.refreshedWorkspaceIds).toEqual([workspace.id]);
    // 重载同样只刷不拆：还是同一个 Scope
    expect(app.scopeRegistry.get(workspace.id)).toBe(scope);
    expect(app.scopeRegistry.workspaceIds().length).toBe(1);
    expect(reloaded.applied.noticeId).not.toBeNull();
    expect(reloaded.applied.restartRequired).toBe(false);
    // 配置本身没被改（重载只读不写）
    expect(reloaded.config.configDir).toBe(app.configManager.basePath);
  });

  it("重载不需要参数；带上没人认的字段也不改变行为", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture);

    const all = await callMethod(app, "host.reload", {});
    expect(all.applied.reloaded).toEqual({
      config: true,
      tools: true,
      skills: true,
      agents: true,
      mcp: true,
    });
  });
});

describe("到交接线才提问（R59 / F-D2）", () => {
  /** 建一段对话并跑一轮，等它结算 */
  async function runAndSettle(app: HostApp, workspaceId: string): Promise<void> {
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

  it("自动推送叫起来的轮次不问：没人看着这条连接，交接问题是噪音", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture, {
      createAgent: async () =>
        new FakeAgent([
          {
            deltas: [{ content: "结果是这些" }],
            usage: { prompt_tokens: 1500, completion_tokens: 5, total_tokens: 1505 },
          },
        ]),
    });
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const conversation = await seedConversation(app, workspace.id);

    // `conversation.send` 的线上参数里没有来源（来源不是内容的一部分），所以这里直接起一轮 ——
    // 这一单开的口子在 `ChatRunner.run(params.source)` 上
    const turn = await app.chatRunner.run({
      conversationId: conversation.id,
      input: { content: "会话 3 的结果" },
      source: "会话「会话 3」",
    });
    await turn.done;
    await wait(50);

    // 用量（1500）明明越过了交接线（1000），但这一轮不是用户叫起来的：不挂问题
    expect((await callMethod(app, "question.list", { state: "pending" })).questions).toEqual([]);
  });

  it("派生会话不问：它自己会压（插件的那条路），问题这套不介入", async () => {
    const fixture = await makeFixture();
    const app = await startApp(fixture, {
      createAgent: async () =>
        new FakeAgent([
          {
            deltas: [{ content: "查到了" }],
            usage: { prompt_tokens: 1500, completion_tokens: 5, total_tokens: 1505 },
          },
        ]),
    });
    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: fixture.workspaceDir.path,
    });
    const parent = await seedConversation(app, workspace.id);

    // 一段真的派生会话：父对话那边的模型开了一段（`PeerSessionService` 的进程内记录就是判据）
    const caller = new FakeAgent();
    app.peerSessions.bind(caller, parent.id);
    const created = await app.peerSessions.create({
      caller: caller as unknown as Parameters<typeof app.peerSessions.create>[0]["caller"],
      prompt: "去把这件事查清楚",
    });
    if (!created.ok) throw new Error(`派生会话没开成：${created.reason}`);
    // 那一段的第一轮由父对话投递唤醒（`source` 是「父对话」），结算时本来就不会问
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (app.chatRunner.turn(created.sessionId) === undefined) break;
      await wait(10);
    }

    // 用户本人接着在这段派生会话里说话：这一轮的 source 就是 `"user"`。
    // 不问的判据是**会话类型**（派生会话一律自动压），不是这一轮的来源。
    const turn = await app.chatRunner.run({
      conversationId: created.sessionId,
      input: { content: "接着说" },
    });
    await turn.done;
    await wait(50);

    // 用量（1500）明明越过了交接线（1000），这段派生会话也不挂问题
    expect((await callMethod(app, "question.list", { state: "pending" })).questions).toEqual([]);
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
      prompt: { messageKey: "question.handoff.prompt" },
      options: [
        { value: "yes", label: { messageKey: "question.handoff.self" } },
        { value: "no", label: { messageKey: "question.handoff.decline" } },
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
    app.scopeRegistry.disposeAll();
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
  app: HostApp,
  language?: "en" | "zh",
): Promise<{ language: string }> {
  const target = app.address;
  if (!target) throw new Error("宿主没在监听");
  const client = await TestClient.connect(`ws://127.0.0.1:${target.port}/`);
  clients.push(client);
  const token = (await fs.readFile(app.paths.tokenFile, "utf8")).trim();
  const frame = await client.hello(token, language === undefined ? {} : { language });
  return frame.result as { language: string };
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

    // 契约的 `DefaultSelection.language` 就在 `defaults` 里（R58），写与读走同一份形状
    const written = await callMethod(app, "config.setDefaults", { defaults: { language: "zh" } });
    expect(written.config.defaults.language).toBe("zh");
    expect((await handshake(app)).language).toBe("zh");

    // 写 `null` 就是清掉这一项：缺省语言回到英文
    await callMethod(app, "config.setDefaults", { defaults: { language: null } });
    expect((await handshake(app)).language).toBe("en");

    // 认不出来的语言直接驳回，不悄悄换成英文
    const bad = { defaults: { language: "fr" } } as unknown as MethodParams<"config.setDefaults">;
    await expect(callMethod(app, "config.setDefaults", bad)).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

});

// ---------------------------------------------------------------------------
// 端口的三档来源（D25 / 裁定 R67）
// ---------------------------------------------------------------------------

describe("端口的三档来源（D25 / 裁定 R67）", () => {
  it("<dataRoot>/host.json 的 port 会被采用", async () => {
    const fixture = await makeFixture();
    const port = await freePort();
    await fs.writeFile(
      join(fixture.dataRoot.path, "host.json"),
      JSON.stringify({ port }),
      "utf8",
    );

    const app = await createHost({
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
      join(fixture.dataRoot.path, "host.json"),
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
      join(fixture.dataRoot.path, "host.json"),
      JSON.stringify({ port: 70000 }),
      "utf8",
    );

    await expect(
      createHost({ aiZenDir: fixture.dataRoot.path, local: true, exit: () => undefined }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        HostError.is(error) &&
        error.code === "config_invalid" &&
        (error.detail as { field?: string }).field === "port",
    );
  });

  it("两档都没给时回落默认 8790（解析这一跳的结论，不去真占 8790）", async () => {
    const fixture = await makeFixture();
    // 没有 host.json、也不给 port：解析结果就是默认端口
    expect(resolveListenTarget({ local: true, port: undefined, configPort: undefined }).port).toBe(
      DEFAULT_PORT,
    );
    // 同一个数据根上建出来（不 start）不会因为端口而失败
    const app = await createHost({
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

    const app = await createHost({
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

    const app = await createHost({
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
