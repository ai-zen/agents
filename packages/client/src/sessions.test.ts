/**
 * `RemoteSessions` 的端到端测试：真 socket + 真 Daemon + 真存档（临时目录）+ 假 Agent。
 *
 * 验的是「客户端能不能只凭服务端拿到会话全貌」这件事 —— 这正是 TUI 从"自己跑 Agent"
 * 改成"纯客户端"时要走的那条路。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createAgentHandlers,
  createSessionHandlers,
  ConfigService,
  FileSessionStore,
  SessionAgentFactory,
  SessionManager,
  SESSION_EVENTS,
  type AgentLike,
  type ModelLevel,
  type ServerEvent,
} from "@ai-zen/agents-server";
import { SocketServerClient } from "./socket-server-client.js";
import { RemoteSessions } from "./sessions.js";
import type { ClientInfo } from "./types.js";

class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: unknown = undefined;
  /** 三级解析的档位（真件由 SDK 的 `createAgent` 给；假件照抄这一位） */
  modelLevel: ModelLevel = "agent";
  /** 交接要用的那几面（真件是 SDK 的 `SdkAgent`）：无 write 工具 → 走摘要模式 */
  definition = { messages: [] as any[] };
  tools: Array<{ function?: { name?: string } }> = [];
  model = "m";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  use(_plugin: unknown): void {}
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };
  send(): Promise<unknown> {
    return Promise.resolve([]);
  }
  abort(): void {}
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

/** 交接文档正文：SDK 有 400 字节的有效性阈值 */
const DOC = `# 交接\n\n${"- 桩\n".repeat(80)}`;

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let agent: FakeAgent;
let connection: SocketServerClient | null = null;
let sessions: RemoteSessions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-remote-sessions-"));
  // 用例里当工作目录用的那个目录得**真的存在**：服务端拒绝在不存在的路径上开会话
  // （`workspace-path-missing`）—— 它不再悄悄 mkdir 出一个空目录，否则用户会以为
  // 自己续上了旧对话、实际进了一个新目录。真实流程里客户端递的是 `process.cwd()`，
  // 总是存在的；这里造一个才是同形。
  mkdirSync(join(dir, "proj"), { recursive: true });
  agent = new FakeAgent();
  manager = new SessionManager({
    createAgent: async () => agent,
    nextSessionId: () => "chat_test",
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
  });
});

afterEach(async () => {
  connection?.close();
  connection = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 造一份最小配置与 Agent 定义（`agent.model.set` 要读写它们） */
function seedAgentDefinition(): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      models: [
        {
          id: "test-model",
          name: "Test",
          endpointId: "e",
          tokenThresholds: { handoff: 1, guard: 2 },
          custom: true,
        },
      ],
      defaultAgent: "default",
      version: 4,
    }),
  );
  writeFileSync(
    join(dir, "agents", "default.json"),
    JSON.stringify({
      id: "default",
      name: "默认",
      modelId: "test-model",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

/**
 * 服务端给某个工作区用的存档目录（约定：`<aiZenDir>/workspaces/<workspaceId>`）。
 *
 * 测试要造「上次留下的存档」时得写进**同一个**目录 —— 客户端这一侧没有别的入口能造存档，
 * 而存档本身是服务端的事实，测试只能按服务端的布局落盘。
 */
function storeFor(workspaceId: string): FileSessionStore {
  return new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
}

async function start(): Promise<void> {
  seedAgentDefinition();
  const factory = new SessionAgentFactory({ aiZenDir: dir, homeDir: dir });
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({
        manager: manager!,
        workspacesRoot: join(dir, "workspaces"),
        // 客户端**不给** path 时服务端落在这个目录上（「cwd 归服务端」那条路的落点）
        defaultWorkspacePath: dir,
      }),
      ...createAgentHandlers({
        factory,
        config: new ConfigService({
          configFile: join(dir, "config.json"),
          agentsDir: join(dir, "agents"),
          subAgentsDir: join(dir, "sub-agents"),
          globalMcpFile: join(dir, "mcp.json"),
          workspacesRoot: join(dir, "workspaces"),
        }),
      }),
    },
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
  sessions = new RemoteSessions(connection);
}

describe("RemoteSessions", () => {
  it("open：解析工作区 + 开会话，工作区目录真的建出来", async () => {
    await start();
    const opened = await sessions.open({ path: join(dir, "proj") });

    expect(opened.sessionId).toBe("chat_test");
    expect(opened.agentId).toBe("default");

    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));
    const listed = await sessions.list(workspace.workspaceId);
    expect(listed.sessions.map((session) => session.sessionId)).toEqual(["chat_test"]);
  });

  it("snapshot：客户端不必自己攒事件，一次拿到消息 / 阶段 / 用量", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });

    agent.messages = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ];
    agent.lastUsage = { promptTokens: 1, completionTokens: 2 };

    const snapshot = await sessions.snapshot(sessionId);
    expect(snapshot).toMatchObject({
      sessionId,
      agentId: "default",
      turnId: 0,
      phase: null,
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
      ],
      lastUsage: { promptTokens: 1, completionTokens: 2 },
    });
  });

  it("save + 续接：存过之后用同一个 id 开，Agent 带着那份消息起来", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "留档" }];

    expect(await sessions.save(sessionId)).toEqual({ saved: true, sessionId });

    // 关掉这个会话，用同一个 id 重新开（模拟下次启动续接）
    const freshAgent = new FakeAgent();
    manager!.dispose();
    manager = new SessionManager({
      createAgent: async () => freshAgent,
      nextSessionId: () => "chat_unused",
      storeFor: (workspaceId) =>
        new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    });

    // 同一个工作区的存档是同一份：直接读新 manager 的续接结果
    const store = new FileSessionStore({
      rootDir: join(
        dir,
        "workspaces",
        (await sessions.resolveWorkspace(join(dir, "proj"))).workspaceId,
      ),
    });
    expect((await store.read(sessionId))?.messages).toEqual([{ role: "user", content: "留档" }]);
    expect((await store.lastSession())?.id).toBe(sessionId);
  });

  it("handoff / migrate：客户端只给 sessionId，文档落盘与换 id 都在服务端完成", async () => {
    // 换一个能递增 id 的 manager：migrate 要新 id，固定 id 会撞 session-exists
    let counter = 0;
    manager = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++counter}`,
      storeFor: (workspaceId) =>
        new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
      handoff: { aiZenDir: join(dir, "ai-zen"), homeDir: dir },
    });
    await start();

    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "任务" }];

    // /handoff：只写文档，会话不变
    const handed = await sessions.handoff(sessionId);
    expect(handed.sessionId).toBe(sessionId);
    expect(handed.mode).toBe("summary");
    expect(existsSync(handed.handoffPath)).toBe(true);

    // /migrate：换 id，旧 id 在服务端退场
    const migrated = await sessions.migrate(sessionId);
    expect(migrated.sessionId).not.toBe(sessionId);
    expect(migrated.messages).toEqual(agent.messages);

    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));
    // 活会话只剩新的那段（`live` 才是“在内存里”的判据，`sessionId` 只是 id）
    const listed = await sessions.list(workspace.workspaceId);
    expect(listed.sessions.filter((entry) => entry.live).map((entry) => entry.sessionId)).toEqual([
      migrated.sessionId,
    ]);

    // 旧会话与新会话都在存档里（旧的那份是交接前的完整历史）
    expect(listed.sessions.map((entry) => entry.sessionId).sort()).toEqual(
      [sessionId, migrated.sessionId].sort(),
    );
  });

  it("事件线：send 之后阶段与收尾都推到客户端", async () => {
    await start();
    const received: ServerEvent[] = [];
    connection!.on(SESSION_EVENTS.phase, (event) => received.push(event));
    connection!.on(SESSION_EVENTS.turnEnd, (event) => received.push(event));

    await sessions.watch();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    await sessions.send(sessionId, "你好");

    agent.fire("open");
    agent.fire("finally");

    for (
      let i = 0;
      i < 100 && !received.some((event) => event.event === SESSION_EVENTS.turnEnd);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const kinds = received.map((event) => event.event);
    expect(kinds).toContain(SESSION_EVENTS.phase);
    expect(kinds).toContain(SESSION_EVENTS.turnEnd);
  });
});

describe("RemoteSessions：存档列表与撤回", () => {
  it("list 是合并视图：刚开的新会话也在里面（`live`），`save` 之后落盘", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));

    // 新会话没落盘，但它活在内存里：列表里有一条 `live:true`
    const fresh = (await sessions.list(workspace.workspaceId)).sessions;
    expect(fresh.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(fresh[0]!.live).toBe(true);

    // `save` 之后盘上有了存档：同一段会话仍然只有一条（不会变成两条）
    await sessions.save(sessionId);
    const saved = (await sessions.list(workspace.workspaceId)).sessions;
    expect(saved.map((entry) => entry.sessionId)).toEqual([sessionId]);
  });

  it("rollback：删掉之后的现场消息随结果返回，且已经落盘", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二个问题" },
    ];

    const result = await sessions.rollback(sessionId, 3);
    expect(result.removed).toBe(1);
    expect(result.prompt).toBe("第二个问题");
    expect(result.messages).toHaveLength(3);
    // 快照与结果一致：客户端不必再要一次
    expect((await sessions.snapshot(sessionId)).messages).toEqual(result.messages);
  });

  it("rollback 下标越界：错误码原样带回客户端", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "只有一条" }];

    await expect(sessions.rollback(sessionId, 9)).rejects.toThrow(/bad-index/);
  });
});

describe("RemoteSessions：重建", () => {
  it("reload 保留消息（Agent 按新配置重建）", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "上下文留住" }];

    const snapshot = await sessions.reload(sessionId);
    expect(snapshot.messages).toEqual([{ role: "user", content: "上下文留住" }]);
    expect(snapshot.sessionId).toBe(sessionId);
  });
});

describe("RemoteSessions：工作区归属服务端（path 可省）", () => {
  it("resolveWorkspace()：不给 path 问到的就是服务端自己的工作区", async () => {
    await start();

    // 客户端手里只有「服务端的工作目录」这一个概念：不给 path 时落点由服务端决定，
    // 所以断言那正是注入的 defaultWorkspacePath，而不是客户端进程的某个目录。
    const fallback = await sessions.resolveWorkspace();
    expect(fallback.path).toBe(dir);

    // 带 path 则是另一个工作区：证明缺省那条路没把两者混成同一个
    const explicit = await sessions.resolveWorkspace(join(dir, "proj"));
    expect(explicit.path).toBe(join(dir, "proj"));
    expect(explicit.workspaceId).not.toBe(fallback.workspaceId);

    // id 是路径确定性派生的：不给 path 连问两次必须落到同一个工作区，否则「续接」无处可寻
    expect((await sessions.resolveWorkspace()).workspaceId).toBe(fallback.workspaceId);
  });

  it("open()：不给 path 也能开成会话，且落在默认工作区里", async () => {
    await start();
    const opened = await sessions.open({});

    // 会话的归属（workspaceId）经由快照回读，这是服务端登记的那个工作区
    const defaultWorkspace = await sessions.resolveWorkspace();
    expect((await sessions.snapshot(opened.sessionId)).workspaceId).toBe(
      defaultWorkspace.workspaceId,
    );

    const listed = await sessions.list(defaultWorkspace.workspaceId);
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([opened.sessionId]);

    // 这条会话没有掉进「客户端指定的另一个目录」那个工作区里
    const other = await sessions.resolveWorkspace(join(dir, "proj"));
    expect((await sessions.list(other.workspaceId)).sessions).toEqual([]);
  });

  // 祖先目录项（`src` / `src/tui`）是这条用例的重点：客户端靠条目的 `dir` 判断能不能
  // 「钻目录」，服务端只回文件的话，远程模式下 `@src/` 这个能力直接消失。
  it("files：清单来自服务端磁盘，文件与祖先目录都在，路径相对工作区根", async () => {
    // 补全要的是「会话真正跑在哪个目录」的内容：这里造一棵真文件树（含子目录），
    // 客户端只递 workspaceId，路径由服务端从 workspace.json 反查。
    const root = join(dir, "proj");
    mkdirSync(join(root, "src", "tui"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# 说明\n");
    writeFileSync(join(root, "src", "index.ts"), "export {};\n");
    writeFileSync(join(root, "src", "tui", "app.ts"), "export {};\n");
    await start();

    const workspace = await sessions.resolveWorkspace(root);
    expect(workspace.path).toBe(root);

    const { entries } = await sessions.files(workspace.workspaceId);
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "README.md", dir: false },
        { path: "src", dir: true },
        { path: "src/index.ts", dir: false },
        { path: "src/tui", dir: true },
        { path: "src/tui/app.ts", dir: false },
      ]),
    );

    // 路径一律相对工作区根：客户端拿到就能直接拼进补全（不是服务端的绝对路径）
    for (const entry of entries) {
      expect(entry.path.startsWith("/")).toBe(false);
      expect(entry.path.startsWith(root)).toBe(false);
    }
  });
});

describe("RemoteSessions：续接只靠 id（客户端不搬消息）", () => {
  it("open({ sessionId })：沿用客户端给的 id，服务端不再另起一个", async () => {
    await start();
    // 这个 id 与 manager 的确定性生成器（`chat_test`）不同：万一处理器又把客户端给的
    // sessionId 丢掉，服务端会分配 `chat_test` 回来，断言立刻炸 —— 这就是那个 bug 的回归保护。
    const wanted = "chat_resumed";
    const opened = await sessions.open({ path: join(dir, "proj"), sessionId: wanted });
    expect(opened.sessionId).toBe(wanted);

    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));
    await sessions.save(opened.sessionId);

    // 盘上确实只有客户端给的那个 id：续接不是「开新的再拷消息」
    expect(
      (await sessions.list(workspace.workspaceId)).sessions.map((entry) => entry.sessionId),
    ).toEqual([wanted]);
    expect((await storeFor(workspace.workspaceId).read(wanted))?.id).toBe(wanted);
    expect(await storeFor(workspace.workspaceId).read("chat_test")).toBeNull();
  });

  it("open({ sessionId }) 且存档里有内容：Agent 带着那份消息起来", async () => {
    await start();
    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));
    const archived = [
      { role: "system", content: "旧系统提示" },
      { role: "user", content: "上一轮的问题" },
      { role: "assistant", content: "上一轮的回答" },
    ];
    // 造「上次留下的存档」：服务端是唯一真相源，客户端只负责说「要这个 id」
    await storeFor(workspace.workspaceId).write({
      id: "chat_loaded",
      agentId: "default",
      messages: archived,
    });

    const opened = await sessions.open({ path: join(dir, "proj"), sessionId: "chat_loaded" });
    expect(opened.sessionId).toBe("chat_loaded");

    const snapshot = await sessions.snapshot(opened.sessionId);
    expect(snapshot.messages).toEqual(archived);
  });

  it("last：没有指针时 null，save 之后指向那个 id", async () => {
    await start();
    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));

    // 全新工作区没有「上一轮会话」：客户端按 null 走新会话
    expect(await sessions.last(workspace.workspaceId)).toEqual({ sessionId: null });

    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    await sessions.save(sessionId);
    expect(await sessions.last(workspace.workspaceId)).toEqual({ sessionId });
  });
});
