/**
 * 处理器接线测试 —— 走真 socket。
 *
 * 业务逻辑在 `SessionManager.test.ts` 里用假 Agent 测透了；这里只证明三件事：
 * **事件真的能从服务端推过连接**、参数错会原样回给客户端、以及 `workspace.*` 里的
 * 「根目录来自工作区参数」真的生效（`workspace.files` 扫的是服务端自己的磁盘）。
 *
 * `workspace.files` 那个用例用真实临时目录（假件证明不了「扫的是哪个目录」），
 * 其余一律注入。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "./Daemon.js";
import { createSessionHandlers } from "./sessionHandlers.js";
import { SessionManager, type AgentLike, type CreateAgentInput } from "../service/session/SessionManager.js";
import { FileSessionStore } from "../service/store/FileSessionStore.js";
import { encodeFrame, FrameDecoder } from "../protocol/frames.js";
import { PROTOCOL_VERSION } from "../protocol/messages.js";
import { EVENT_METHODS, SESSION_METHODS, WORKSPACE_METHODS } from "../protocol/sessions.js";

/** 交接文档正文：SDK 有 400 字节的有效性阈值 */
const DOC = `# 交接\n\n${"- 桩\n".repeat(80)}`;

class FakeAgent implements AgentLike {
  messages: any[] = [];
  sent: string[] = [];
  aborted = 0;
  /** 交接要用的那几面（真件是 SDK 的 `SdkAgent`）：无 write 工具 → 走摘要模式 */
  definition = { messages: [{ role: "system", content: "模板" }] };
  tools: Array<{ function?: { name?: string } }> = [];
  model = "m";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  use(_plugin: unknown): void {}
  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  readonly events = {
    on: (event: string, handler: (payload: any) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (payload: any) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };
  send(input: string): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
  abort(): void {
    this.aborted++;
  }
  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

/**
 * 假的子 Agent：会话层只从它身上取 `messages`（快照）与 `events`（挂监听）。
 * 父 Agent 的事件载荷只需要一个 `{ subAgent }`，所以这里不实现 send / abort。
 */
class FakeSubAgent {
  messages: any[] = [];
  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  readonly events = {
    on: (event: string, handler: (payload: any) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
  };

  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

let dir: string;
/** 客户端不带工作目录时用的那个（组装根注入，真进程里是服务端自己的 cwd） */
let defaultWorkspacePath: string;
let daemon: Daemon | null = null;
let agent: FakeAgent;
let manager: SessionManager;
/** `createAgent` 收到的入参（断言「这一段会话跑在哪个路径上」，以及那两个会话层钩子） */
let agentInputs: CreateAgentInput[];
let client: TestClient | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-session-handlers-"));
  defaultWorkspacePath = join(dir, "default-ws");
  agent = new FakeAgent();
  agentInputs = [];
  let counter = 0;
  manager = new SessionManager({
    createAgent: async (input) => {
      agentInputs.push(input);
      return agent;
    },
    // 默认 id 只精确到秒：同一秒里 create 再 migrate 会撞名，用例要确定性
    nextSessionId: () => `chat_${++counter}`,
    storeFor: (workspaceId) => new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    // 交接要读 `handoff` Skill、写 `<工作区>/.ai-zen/handoffs`
    handoff: { aiZenDir: join(dir, "ai-zen"), homeDir: dir },
  });
});

afterEach(async () => {
  client?.close();
  client = null;
  manager.dispose();
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startDaemon(): Promise<void> {
  const instance = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.1.0-test",
    handlers: createSessionHandlers({
      manager,
      workspacesRoot: join(dir, "workspaces"),
      defaultWorkspacePath,
    }),
  });
  await instance.start();
  daemon = instance;
  client = await TestClient.connect(instance.port);
  await client.handshake();
}

describe("工作区处理器（真 socket）", () => {
  it("workspace.resolve 建目录并回 workspaceId", async () => {
    await startDaemon();
    const result = await client!.call(WORKSPACE_METHODS.resolve, { path: "/work/proj-a" });
    expect(result).toMatchObject({ path: "/work/proj-a" });
    expect((result as { workspaceId: string }).workspaceId).toMatch(/^proj-a-[0-9a-f]{8}$/);
  });

  it("workspace.resolve 不带 path：用服务端默认工作区（cwd 归属服务端）", async () => {
    await startDaemon();
    // 连 params 都不传：客户端不需要知道目录在哪
    const result = (await client!.call(WORKSPACE_METHODS.resolve)) as { workspaceId: string; path: string };

    expect(result.path).toBe(defaultWorkspacePath);
    expect(result.workspaceId).toMatch(/^default-ws-[0-9a-f]{8}$/);
  });

  it("参数错 → bad-params 错误帧（不是崩掉连接）", async () => {
    await startDaemon();
    // `path` 是可选的，但给了就得是字符串
    await expect(client!.call(WORKSPACE_METHODS.resolve, { path: 42 })).rejects.toThrow(/bad-params/);
    await expect(client!.call(WORKSPACE_METHODS.files, {})).rejects.toThrow(/bad-params/);
    await expect(client!.call(SESSION_METHODS.last, {})).rejects.toThrow(/bad-params/);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("workspace.files 扫的是**服务端**磁盘：按 workspaceId 找回根目录再列条目", async () => {
    await startDaemon();
    const projectRoot = join(dir, "proj");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "chat.tsx"), "");
    writeFileSync(join(projectRoot, "README.md"), "");

    const workspace = (await client!.call(WORKSPACE_METHODS.resolve, { path: projectRoot })) as {
      workspaceId: string;
    };
    const listed = (await client!.call(WORKSPACE_METHODS.files, {
      workspaceId: workspace.workspaceId,
    })) as { entries: Array<{ path: string; dir: boolean }> };

    const files = listed.entries.filter((entry) => !entry.dir).map((entry) => entry.path).sort();
    expect(files).toEqual(["README.md", "src/chat.tsx"]);
  });

  it("workspace.files 的未知工作区 → workspace-not-found（不是空清单）", async () => {
    await startDaemon();
    await expect(
      client!.call(WORKSPACE_METHODS.files, { workspaceId: "nope-00000000" }),
    ).rejects.toThrow(/workspace-not-found/);
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.last：没有指针回 null，存档之后回那段会话的 id", async () => {
    await startDaemon();
    expect(await client!.call(SESSION_METHODS.last, { workspaceId: "ws-1" })).toEqual({
      sessionId: null,
    });

    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    await client!.call(SESSION_METHODS.save, { sessionId: created.sessionId });

    expect(await client!.call(SESSION_METHODS.last, { workspaceId: "ws-1" })).toEqual({
      sessionId: created.sessionId,
    });
  });
});

describe("会话处理器（真 socket）", () => {
  it("watch 之后：create / send 的进展以事件帧推到这条连接上", async () => {
    await startDaemon();
    await client!.call(EVENT_METHODS.watch);

    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: "/work/proj-a",
    })) as { sessionId: string; agentId: string };
    expect(created.agentId).toBe("default");

    const sent = (await client!.call(SESSION_METHODS.send, {
      sessionId: created.sessionId,
      content: "你好",
    })) as { turnId: number };
    expect(sent.turnId).toBe(1);
    expect(agent.sent).toEqual(["你好"]);

    // send 当下就会有一条 phase（connecting）
    expect(await client!.next()).toMatchObject({
      event: "session.phase",
      sessionId: created.sessionId,
      turnId: 1,
      phase: { kind: "connecting" },
    });

    // 正文增量与轮次收尾
    agent.fire("chunk-parsed", { choices: [{ delta: { content: "答" } }] });
    const phaseAfterDelta = (await client!.next()) as any;
    expect(phaseAfterDelta).toMatchObject({ event: "session.phase", phase: { kind: "streaming" } });
    expect(await client!.next()).toMatchObject({ event: "message.delta", text: "答" });

    agent.fire("finally");
    const phaseReset = (await client!.next()) as any;
    expect(phaseReset.phase).toBeNull();
    expect(await client!.next()).toMatchObject({ event: "turn.end", ok: true, turnId: 1 });
  });

  it("session.subAgent.snapshot 走通；未知子 Agent → sub-agent-missing 错误帧", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    await client!.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "帮我查两处" });

    const sub = new FakeSubAgent();
    sub.messages = [{ role: "user", content: "子任务" }];
    agent.fire("sub-agent-start", { subAgent: sub });

    expect(
      await client!.call(SESSION_METHODS.subAgentSnapshot, {
        sessionId: created.sessionId,
        subAgentId: "sub-1",
      }),
    ).toEqual({
      subAgentId: "sub-1",
      index: 1,
      status: "running",
      messages: [{ role: "user", content: "子任务" }],
    });

    // 子 Agent 只活在当前一轮：不存在的 id 带码报错，不回一份空对话
    await expect(
      client!.call(SESSION_METHODS.subAgentSnapshot, {
        sessionId: created.sessionId,
        subAgentId: "sub-404",
      }),
    ).rejects.toThrow(/sub-agent-missing/);
    // 参数缺失同样是 bad-params，且连接还能继续用
    await expect(
      client!.call(SESSION_METHODS.subAgentSnapshot, { sessionId: created.sessionId }),
    ).rejects.toThrow(/bad-params/);
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.list 报出活着的会话与当前阶段", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: "/p",
    })) as { sessionId: string };
    await client!.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "hi" });

    const listed = (await client!.call(SESSION_METHODS.list, { workspaceId: "ws-1" })) as {
      sessions: any[];
    };
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      sessionId: created.sessionId,
      workspaceId: "ws-1",
      turnId: 1,
      phase: { kind: "connecting" },
    });
  });

  it("未知会话 → unknown-session 错误帧；cancel 未知会话回 false（不是错）", async () => {
    await startDaemon();
    await expect(
      client!.call(SESSION_METHODS.send, { sessionId: "sess_404", content: "x" }),
    ).rejects.toThrow(/unknown-session/);

    expect(await client!.call(SESSION_METHODS.cancel, { sessionId: "sess_404" })).toEqual({
      cancelled: false,
    });
  });

  it("session.send 收「文本 + 图片」内容块：服务端不解释，原样交给 Agent", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    const content = [
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];

    const sent = (await client!.call(SESSION_METHODS.send, {
      sessionId: created.sessionId,
      content,
    })) as { turnId: number };

    expect(sent.turnId).toBe(1);
    // 原样到达 Agent：服务端不在中间改内容块
    expect(agent.sent).toEqual([content]);
  });

  it("不认识的内容块 → bad-params（放过去只会在端点那边变成更难懂的 400）", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(
      client!.call(SESSION_METHODS.send, {
        sessionId: created.sessionId,
        content: [{ type: "video", url: "x" }],
      }),
    ).rejects.toThrow(/bad-params/);
    await expect(
      client!.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: [] }),
    ).rejects.toThrow(/bad-params/);
    expect(agent.sent).toEqual([]);
  });

  it("session.handoff：返回文档路径与执行者，进度作为事件推过连接", async () => {
    await startDaemon();
    await client!.call(EVENT_METHODS.watch);
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [{ role: "user", content: "任务" }];

    const result = (await client!.call(SESSION_METHODS.handoff, {
      sessionId: created.sessionId,
    })) as any;

    expect(result.sessionId).toBe(created.sessionId); // 不换 id
    expect(result.mode).toBe("summary");
    expect(result.handoffPath.startsWith(join(dir, ".ai-zen", "handoffs"))).toBe(true);
    expect(result.messages).toEqual([{ role: "user", content: "任务" }]);

    // 交接按「一轮」记账：先报 connecting，中间是三条通知，最后收尾
    expect(await client!.next()).toMatchObject({
      event: "session.phase",
      sessionId: created.sessionId,
      turnId: 1,
      phase: { kind: "connecting" },
    });
    const notices: any[] = [];
    for (let i = 0; i < 3; i++) notices.push(await client!.next());
    expect(notices.map((notice) => notice.event)).toEqual([
      "session.notice",
      "session.notice",
      "session.notice",
    ]);
    expect(notices.map((notice) => notice.code)).toEqual([
      "handoffWriting",
      "migrationDegraded",
      "handoffPath",
    ]);
    // 通知里没有任何给人看的句子（客户端查自己的 i18n 表）
    expect(notices[0].params).toEqual({ mode: "self" });
  });

  it("session.migrate：旧会话入档、新会话落盘、旧 id 退场", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [{ role: "user", content: "旧任务" }];

    const result = (await client!.call(SESSION_METHODS.migrate, {
      sessionId: created.sessionId,
    })) as any;

    expect(result.sessionId).not.toBe(created.sessionId);
    // 活会话换了键：旧 id 不在列表里了
    const listed = (await client!.call(SESSION_METHODS.list, { workspaceId: "ws-1" })) as any;
    expect(listed.sessions.map((session: any) => session.sessionId)).toEqual([result.sessionId]);
    // 旧会话与新会话都在存档里（旧的是交接前那份完整历史）
    const saved = (await client!.call(SESSION_METHODS.listSaved, { workspaceId: "ws-1" })) as any;
    expect(saved.sessions.map((ref: any) => ref.id).sort()).toEqual(
      [created.sessionId, result.sessionId].sort(),
    );
  });

  it("session.handoff 的 mode 只认两个取值：别的原样回 bad-params", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(
      client!.call(SESSION_METHODS.handoff, { sessionId: created.sessionId, mode: "auto" }),
    ).rejects.toThrow(/bad-params/);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.answer：提问以事件推过连接，回答之后服务端那一轮继续跑（迁移用的是用户选的 mode）", async () => {
    await startDaemon();
    await client!.call(EVENT_METHODS.watch);
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [{ role: "user", content: "旧任务" }];

    // 走「插件 → 会话层」那条路：会话层拿到的那两个钩子就是装配时给的
    const input = agentInputs.at(-1)!;
    const migrated = (async () => {
      const mode = await input.resolveMode!({ promptTokens: 999, handoffTokens: 500 });
      if (mode === null) return;
      await input.autoMigrate!(mode);
    })();

    const question = (await client!.next()) as any;
    expect(question).toMatchObject({
      event: "session.question",
      sessionId: created.sessionId,
      kind: "handoff-mode",
      input: "select",
      options: ["self", "summary"],
      allowSkip: true,
      fallback: null,
      params: { promptTokens: 999, handoffTokens: 500 },
    });

    expect(
      await client!.call(SESSION_METHODS.answer, {
        sessionId: created.sessionId,
        questionId: question.questionId,
        choice: "summary",
      }),
    ).toEqual({ answered: true });
    await migrated;

    // 旧 id 退场、新 id 登场：迁移真的按用户的选择发生了
    const listed = (await client!.call(SESSION_METHODS.list, { workspaceId: "ws-1" })) as any;
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].sessionId).not.toBe(created.sessionId);
  });

  it("session.answer 参数错 → bad-params（choice 缺失不等于「跳过」：那是 null）", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(
      client!.call(SESSION_METHODS.answer, { sessionId: created.sessionId, choice: "self" }),
    ).rejects.toThrow(/bad-params/);
    await expect(
      client!.call(SESSION_METHODS.answer, {
        sessionId: created.sessionId,
        questionId: "q-1",
        choice: "",
      }),
    ).rejects.toThrow(/bad-params/);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.answer 回答一个已经不在的问题 → answered:false（来晚了，不是错）", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    // 超时 / 已答过 / 会话已收，对客户端都是同一件事：不用重试
    expect(
      await client!.call(SESSION_METHODS.answer, {
        sessionId: created.sessionId,
        questionId: "q-404",
        choice: null,
      }),
    ).toEqual({ answered: false });
    expect(await client!.call("ping")).toEqual({ pong: true });
  });
});

/** 最小握手客户端：只做这一层要用的「发一帧、等一帧」 */
class TestClient {
  private inbox: unknown[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private nextRequestId = 1;

  private constructor(private readonly socket: Socket, private readonly decoder: FrameDecoder) {}

  static async connect(port: number): Promise<TestClient> {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf-8");
    const instance = new TestClient(socket, new FrameDecoder());
    socket.on("data", (chunk: string) => {
      for (const frame of instance.decoder.push(chunk)) instance.inbox.push(frame);
      instance.wake();
    });
    socket.on("close", () => {
      instance.closed = true;
      instance.wake();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    return instance;
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async next(): Promise<unknown> {
    while (this.inbox.length === 0) {
      if (this.closed) throw new Error("connection closed while waiting for a frame");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.inbox.shift();
  }

  async handshake(): Promise<void> {
    this.socket.write(
      encodeFrame({ kind: "hello", protocol: PROTOCOL_VERSION, client: { name: "test", version: "0" } }),
    );
    expect(await this.next()).toMatchObject({ kind: "hello", ok: true });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    this.socket.write(encodeFrame({ id, method, params }));
    // 事件帧没有 id：它们可能比响应**先**到（如 send 里先推 phase 再回执），
    // 所以不是丢掉，而是原样塞回队列，等调用方用 next() 按序取
    const skipped: unknown[] = [];
    try {
      for (;;) {
        const frame = await this.next();
        if ((frame as any)?.id !== id) {
          skipped.push(frame);
          continue;
        }
        if ((frame as any).ok) return (frame as any).result;
        throw new Error(`${(frame as any).error.code}: ${(frame as any).error.message}`);
      }
    } finally {
      this.inbox.unshift(...skipped);
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("会话创建：path 可缺省，sessionId 必须被尊重", () => {
  it("不带 path：用 workspace.json 记的路径（客户端不需要知道目录在哪）", async () => {
    await startDaemon();
    // 先认一个工作区，让服务端手上有一份 workspace.json
    const workspace = (await client!.call(WORKSPACE_METHODS.resolve, {
      path: join(dir, "proj-a"),
    })) as { workspaceId: string; path: string };

    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: workspace.workspaceId,
    })) as { sessionId: string };

    expect(created.sessionId).toBeTruthy();
    // Agent 是被**服务端**反查出来的路径装配的，不是客户端递上来的
    expect(agentInputs.at(-1)).toMatchObject({ path: workspace.path });
  });

  it("不带 path 又是个服务端不认识的工作区：报 workspace-not-found，不静默造目录", async () => {
    await startDaemon();
    await expect(client!.call(SESSION_METHODS.create, { workspaceId: "ws-unknown" })).rejects.toThrow(
      /workspace-not-found/,
    );
  });

  it("带了 sessionId 就沿用它，并把存档里的消息装进 Agent（续接 / `/load` 的根）", async () => {
    await startDaemon();
    const workspaceId = "ws-resume";
    const store = new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
    // 存档里的 agentId 也要被沿用：客户端只给一个 id
    await store.write({ id: "chat_old", agentId: "reviewer", messages: [{ role: "user", content: "旧对话" }] });

    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId,
      path: "/work/proj-resume",
      sessionId: "chat_old",
    })) as { sessionId: string; agentId: string };

    expect(created.sessionId).toBe("chat_old");
    expect(created.agentId).toBe("reviewer");
    expect(agent.messages).toEqual([{ role: "user", content: "旧对话" }]);
  });
});

describe("session.attach：会话活得比连接久", () => {
  it("活着的会话直接接上（不再报 session-exists）", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: join(dir, "proj-a"),
    })) as { sessionId: string; agentId: string };

    // 「接着上次」走的就是这条：客户端只给 id，服务端知道它还在内存里
    const attached = await client!.call(SESSION_METHODS.attach, {
      workspaceId: "ws-1",
      path: join(dir, "proj-a"),
      sessionId: created.sessionId,
    });

    expect(attached).toEqual(created);
    expect(manager.list("ws-1")).toHaveLength(1);
  });

  it("内存与盘上都没有这个 id → session-missing（不悄悄开一段空的）", async () => {
    await startDaemon();
    await expect(
      client!.call(SESSION_METHODS.attach, { workspaceId: "ws-1", path: dir, sessionId: "chat_gone" }),
    ).rejects.toThrow(/session-missing|no such session/);
  });
});
