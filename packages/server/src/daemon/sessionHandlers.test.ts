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
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "./Daemon.js";
import { createSessionHandlers } from "./sessionHandlers.js";
import {
  SessionManager,
  type AgentLike,
  type CreateAgentInput,
} from "../domain/session/SessionManager.js";
import { FileSessionStore } from "../domain/session/store/FileSessionStore.js";
import { encodeFrame, FrameDecoder } from "../wire/frames.js";
import { PROTOCOL_VERSION } from "../wire/messages.js";

import type { ServerEvent } from "../protocol/index.js";

/** 交接文档正文：SDK 有 400 字节的有效性阈值 */
const DOC = `# 交接\n\n${"- 桩\n".repeat(80)}`;

class FakeAgent implements AgentLike {
  messages: any[] = [];
  sent: string[] = [];
  aborted = 0;
  /** 交接要用的那几面（真件是 SDK 的 `SdkAgent`）：无 write 工具 → 走摘要模式 */
  definition = { messages: [{ role: "system", content: "模板" }] };
  /** 三级解析的档位（真件由 `createAgent` 给；假件手装配，等价于「写在定义上」那一档） */
  modelLevel: "agent" | "session" | "global" = "agent";
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
  send(input: string): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
  abort(): void {
    this.aborted++;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/**
 * 假的子 Agent：会话层只从它身上取 `messages`（快照）与 `events`（挂监听）。
 * 父 Agent 的事件载荷只需要一个 `{ subAgent }`，所以这里不实现 send / abort。
 */
class FakeSubAgent {
  messages: any[] = [];
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
  };

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

let dir: string;
/** 客户端不带工作目录时用的那个（组装根注入，真进程里是服务端自己的 cwd） */
let defaultWorkspacePath: string;

/**
 * 造一个真实存在的工作区目录。
 *
 * `session.create` 现在**要求**工作区路径存在（目录缺失时它报 `workspace-path-missing`，
 * 绝不替用户 `mkdir`），所以用例里递给它的路径必须先真的在盘上。
 */
function workDir(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

let daemon: Daemon | null = null;
let agent: FakeAgent;
let manager: SessionManager;
/** `createAgent` 收到的入参（断言「这一段会话跑在哪个路径上」，以及那两个会话层钩子） */
let agentInputs: CreateAgentInput[];
let client: TestClient | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-session-handlers-"));
  defaultWorkspacePath = join(dir, "default-ws");
  mkdirSync(defaultWorkspacePath, { recursive: true });
  agent = new FakeAgent();
  agentInputs = [];
  let counter = 0;
  manager = new SessionManager({
    createAgent: async (input) => {
      agentInputs.push(input);
      // 假件照抄真件的形状：SDK 会把三级解析的结果写进它交给 Agent 的那份定义
      // （服务端只是把「会话级覆盖」递进去）。这里按入参原样回填 —— 假件不替 SDK 做解析。
      (agent as unknown as { definition: { modelId?: string } }).definition.modelId =
        input.modelId ?? "m-definition";
      agent.modelLevel = input.modelId ? "session" : "agent";
      return agent;
    },
    // 默认 id 只精确到秒：同一秒里 create 再 migrate 会撞名，用例要确定性
    nextSessionId: () => `chat_${++counter}`,
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
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
    const result = await client!.call("workspace.resolve", { path: "/work/proj-a" });
    expect(result).toMatchObject({ path: "/work/proj-a" });
    expect((result as { workspaceId: string }).workspaceId).toMatch(/^proj-a-[0-9a-f]{8}$/);
  });

  it("workspace.resolve 不带 path：用服务端默认工作区（cwd 归属服务端）", async () => {
    await startDaemon();
    // 连 params 都不传：客户端不需要知道目录在哪
    const result = (await client!.call("workspace.resolve")) as {
      workspaceId: string;
      path: string;
    };

    expect(result.path).toBe(defaultWorkspacePath);
    expect(result.workspaceId).toMatch(/^default-ws-[0-9a-f]{8}$/);
  });

  it("参数错 → bad-params 错误帧（不是崩掉连接）", async () => {
    await startDaemon();
    // `path` 是可选的，但给了就得是字符串
    await expect(client!.call("workspace.resolve", { path: 42 })).rejects.toThrow(/bad-params/);
    await expect(client!.call("workspace.files", {})).rejects.toThrow(/bad-params/);
    await expect(client!.call("session.last", {})).rejects.toThrow(/bad-params/);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("workspace.files 扫的是**服务端**磁盘：按 workspaceId 找回根目录再列条目", async () => {
    await startDaemon();
    const projectRoot = join(dir, "proj");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "chat.tsx"), "");
    writeFileSync(join(projectRoot, "README.md"), "");

    const workspace = (await client!.call("workspace.resolve", { path: projectRoot })) as {
      workspaceId: string;
    };
    const listed = (await client!.call("workspace.files", {
      workspaceId: workspace.workspaceId,
    })) as { entries: Array<{ path: string; dir: boolean }> };

    const files = listed.entries
      .filter((entry) => !entry.dir)
      .map((entry) => entry.path)
      .sort();
    expect(files).toEqual(["README.md", "src/chat.tsx"]);
  });

  it("workspace.files 的未知工作区 → unknown-workspace（不是空清单）", async () => {
    await startDaemon();
    await expect(client!.call("workspace.files", { workspaceId: "nope-00000000" })).rejects.toThrow(
      /unknown-workspace/,
    );
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.last：没有指针回 null，存档之后回那段会话的 id", async () => {
    await startDaemon();
    expect(await client!.call("session.last", { workspaceId: "ws-1" })).toEqual({
      sessionId: null,
    });

    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    await client!.call("session.save", { sessionId: created.sessionId });

    expect(await client!.call("session.last", { workspaceId: "ws-1" })).toEqual({
      sessionId: created.sessionId,
    });
  });
});

describe("会话处理器（真 socket）", () => {
  it("watch 之后：create / send 的进展以事件帧推到这条连接上", async () => {
    await startDaemon();
    await client!.call("events.watch");

    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: workDir("proj-a"),
    })) as { sessionId: string; agentId: string };
    expect(created.agentId).toBe("default");

    const sent = (await client!.call("session.send", {
      sessionId: created.sessionId,
      content: "你好",
    })) as { turnId: number };
    expect(sent.turnId).toBe(1);
    expect(agent.sent).toEqual(["你好"]);

    // send 当下就会有一条 phase（connecting）
    expect(await client!.next()).toMatchObject({
      event: "session-phase",
      sessionId: created.sessionId,
      turnId: 1,
      phase: { kind: "connecting" },
    });

    // 原始片与轮次收尾
    // `chunk-parsed` 是两参：`(receiver, chunk)` —— 第二个才是原始 chunk。
    // 一片 chunk 出两条帧：原始片（core `chunk`）→ 派生出来的阶段。正文增量不上线，
    // 客户端拿原始片自己折（core 的 `applyChunk`）。
    // core 是先发 `chunk` 再解析（`Agent.parseStreamData`），所以假件也按这个顺序 fire。
    const piece = { choices: [{ delta: { content: "答" } }] };
    agent.fire("chunk", piece);
    agent.fire("chunk-parsed", {}, piece);
    expect(await client!.next()).toMatchObject({ event: "chunk", turnId: 1 });
    const phaseAfterDelta = (await client!.next()) as any;
    expect(phaseAfterDelta).toMatchObject({ event: "session-phase", phase: { kind: "streaming" } });

    agent.fire("finally");
    expect(await client!.next()).toMatchObject({ event: "finally", turnId: 1 });
    const phaseReset = (await client!.next()) as any;
    expect(phaseReset.phase).toBeNull();
    expect(await client!.next()).toMatchObject({ event: "session-turn-end", ok: true, turnId: 1 });
  });

  it("session.subAgent.snapshot 走通；未知子 Agent → sub-agent-missing 错误帧", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    await client!.call("session.send", {
      sessionId: created.sessionId,
      content: "帮我查两处",
    });

    const sub = new FakeSubAgent();
    sub.messages = [{ role: "user", content: "子任务" }];
    agent.fire("sub-agent-start", { subAgent: sub });

    expect(
      await client!.call("session.subAgent.snapshot", {
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
      client!.call("session.subAgent.snapshot", {
        sessionId: created.sessionId,
        subAgentId: "sub-404",
      }),
    ).rejects.toThrow(/sub-agent-missing/);
    // 参数缺失同样是 bad-params，且连接还能继续用
    await expect(
      client!.call("session.subAgent.snapshot", { sessionId: created.sessionId }),
    ).rejects.toThrow(/bad-params/);
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.list 报出活着的会话与当前阶段", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: workDir("proj-list"),
    })) as { sessionId: string };
    await client!.call("session.send", { sessionId: created.sessionId, content: "hi" });

    const listed = (await client!.call("session.list", { workspaceId: "ws-1" })) as {
      sessions: any[];
    };
    expect(listed.sessions).toHaveLength(1);
    // 列表条目只说「侧栏渲染需要的事」；`turnId` 不在里面（那是事件过滤用的，
    // 客户端自己发过一条就知道），所以这里只断言展示相关的字段 + 阶段
    expect(listed.sessions[0]).toMatchObject({
      sessionId: created.sessionId,
      agentId: "default",
      live: true,
      phase: { kind: "connecting" },
    });
    expect(typeof listed.sessions[0].updatedAt).toBe("string");
  });

  it("未知会话 → unknown-session 错误帧；cancel 未知会话回 false（不是错）", async () => {
    await startDaemon();
    await expect(
      client!.call("session.send", { sessionId: "sess_404", content: "x" }),
    ).rejects.toThrow(/unknown-session/);

    expect(await client!.call("session.cancel", { sessionId: "sess_404" })).toEqual({
      cancelled: false,
    });
  });

  it("session.send 收「文本 + 图片」内容块：服务端不解释，原样交给 Agent", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    const content = [
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];

    const sent = (await client!.call("session.send", {
      sessionId: created.sessionId,
      content,
    })) as { turnId: number };

    expect(sent.turnId).toBe(1);
    // 原样到达 Agent：服务端不在中间改内容块
    expect(agent.sent).toEqual([content]);
  });

  it("不认识的内容块 → bad-params（放过去只会在端点那边变成更难懂的 400）", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(
      client!.call("session.send", {
        sessionId: created.sessionId,
        content: [{ type: "video", url: "x" }],
      }),
    ).rejects.toThrow(/bad-params/);
    await expect(
      client!.call("session.send", { sessionId: created.sessionId, content: [] }),
    ).rejects.toThrow(/bad-params/);
    expect(agent.sent).toEqual([]);
  });

  it("session.handoff：返回文档路径与执行者，进度作为事件推过连接", async () => {
    await startDaemon();
    await client!.call("events.watch");
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [{ role: "user", content: "任务" }];

    const result = (await client!.call("session.handoff", {
      sessionId: created.sessionId,
    })) as any;

    expect(result.sessionId).toBe(created.sessionId); // 不换 id
    expect(result.mode).toBe("summary");
    expect(result.handoffPath.startsWith(join(dir, ".ai-zen", "handoffs"))).toBe(true);
    expect(result.messages).toEqual([{ role: "user", content: "任务" }]);

    // 交接按「一轮」记账：先报 connecting，中间是三条通知，最后收尾
    expect(await client!.next()).toMatchObject({
      event: "session-phase",
      sessionId: created.sessionId,
      turnId: 1,
      phase: { kind: "connecting" },
    });
    const notices: any[] = [];
    for (let i = 0; i < 3; i++) notices.push(await client!.next());
    expect(notices.map((notice) => notice.event)).toEqual([
      "session-notice",
      "session-notice",
      "session-notice",
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
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [{ role: "user", content: "旧任务" }];

    const result = (await client!.call("session.migrate", {
      sessionId: created.sessionId,
    })) as any;

    expect(result.sessionId).not.toBe(created.sessionId);
    // 活会话换了键：旧 id 不再是活会话（但它作为存档仍在列表里）
    const live = (await client!.call("session.list", {
      workspaceId: "ws-1",
      includeSaved: false,
    })) as any;
    expect(live.sessions.map((session: any) => session.sessionId)).toEqual([result.sessionId]);
    // 旧会话与新会话都在存档里（旧的是交接前那份完整历史）—— 列表是合并视图，
    // 所以这里按 id 集合断言，不看 `live`
    const saved = (await client!.call("session.list", { workspaceId: "ws-1" })) as any;
    expect(saved.sessions.map((session: any) => session.sessionId).sort()).toEqual(
      [created.sessionId, result.sessionId].sort(),
    );
  });

  it("session.migrate 的 strategy 只认两个取值：别的原样回 bad-params", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [{ role: "user", content: "旧任务" }];

    await expect(
      client!.call("session.migrate", { sessionId: created.sessionId, strategy: "drop" }),
    ).rejects.toThrow(/bad-params/);
    // 消息原样未动：参数错不会走到交接那一步
    expect(agent.messages).toEqual([{ role: "user", content: "旧任务" }]);
  });

  it("session.migrate{strategy:'omit'}：同一个 id 回来，会话列表里也只有这一段", async () => {
    await startDaemon();
    // 事件从这个管理器的**源头**上收（这条用例要看的是「没发 idChanged」，不是接线）
    const seen: ServerEvent[] = [];
    manager.subscribe((event) => seen.push(event));
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };
    agent.messages = [
      { role: "system", content: "模板" },
      { role: "user", content: "旧任务" },
    ];

    const result = (await client!.call("session.migrate", {
      sessionId: created.sessionId,
      strategy: "omit",
    })) as any;

    expect(result.sessionId).toBe(created.sessionId);
    // 没换 id，就没有 idChanged 事件（客户端不会把后面的请求切到另一个 id 上）
    expect(seen.filter((event) => event.event === "session-id-changed")).toEqual([]);
    const saved = (await client!.call("session.list", { workspaceId: "ws-1" })) as any;
    expect(saved.sessions.map((session: any) => session.sessionId)).toEqual([created.sessionId]);
    // 旧消息还在，只是标了不再发送
    expect(agent.messages[1]).toMatchObject({ content: "旧任务", omit: true });
  });

  it("session.handoff 的 mode 只认两个取值：别的原样回 bad-params", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(
      client!.call("session.handoff", { sessionId: created.sessionId, mode: "auto" }),
    ).rejects.toThrow(/bad-params/);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("session.answer：提问以事件推过连接，回答之后服务端那一轮继续跑（迁移用的是用户选的 mode）", async () => {
    await startDaemon();
    await client!.call("events.watch");
    const created = (await client!.call("session.create", {
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
      event: "session-question",
      sessionId: created.sessionId,
      kind: "handoff-mode",
      input: "select",
      options: ["self", "summary"],
      allowSkip: true,
      fallback: null,
      params: { promptTokens: 999, handoffTokens: 500 },
    });

    expect(
      await client!.call("session.answer", {
        sessionId: created.sessionId,
        questionId: question.questionId,
        choice: "summary",
      }),
    ).toEqual({ answered: true });
    await migrated;

    // 旧 id 退场、新 id 登场：迁移真的按用户的选择发生了（旧那段已入档，所以只看活会话）
    const listed = (await client!.call("session.list", {
      workspaceId: "ws-1",
      includeSaved: false,
    })) as any;
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].sessionId).not.toBe(created.sessionId);
    expect(listed.sessions[0].live).toBe(true);
  });

  it("session.answer 参数错 → bad-params（choice 缺失不等于「跳过」：那是 null）", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(
      client!.call("session.answer", { sessionId: created.sessionId, choice: "self" }),
    ).rejects.toThrow(/bad-params/);
    await expect(
      client!.call("session.answer", {
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
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    // 超时 / 已答过 / 会话已收，对客户端都是同一件事：不用重试
    expect(
      await client!.call("session.answer", {
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

  private constructor(
    private readonly socket: Socket,
    private readonly decoder: FrameDecoder,
  ) {}

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
      encodeFrame({
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        client: { name: "test", version: "0" },
      }),
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
    const workspace = (await client!.call("workspace.resolve", {
      path: workDir("proj-a"),
    })) as { workspaceId: string; path: string };

    const created = (await client!.call("session.create", {
      workspaceId: workspace.workspaceId,
    })) as { sessionId: string };

    expect(created.sessionId).toBeTruthy();
    // Agent 是被**服务端**反查出来的路径装配的，不是客户端递上来的
    expect(agentInputs.at(-1)).toMatchObject({ path: workspace.path });
  });

  it("不带 path 又是个服务端不认识的工作区：报 unknown-workspace，不静默造目录", async () => {
    await startDaemon();
    await expect(client!.call("session.create", { workspaceId: "ws-unknown" })).rejects.toThrow(
      /unknown-workspace/,
    );
  });

  it("带了 sessionId 就沿用它，并把存档里的消息装进 Agent（续接 / `/load` 的根）", async () => {
    await startDaemon();
    const workspaceId = "ws-resume";
    const store = new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
    // 存档里的 agentId 也要被沿用：客户端只给一个 id
    await store.write({
      id: "chat_old",
      agentId: "reviewer",
      messages: [{ role: "user", content: "旧对话" }],
    });

    const created = (await client!.call("session.create", {
      workspaceId,
      path: workDir("proj-resume"),
      sessionId: "chat_old",
    })) as { sessionId: string; agentId: string };

    expect(created.sessionId).toBe("chat_old");
    expect(created.agentId).toBe("reviewer");
    expect(agent.messages).toEqual([{ role: "user", content: "旧对话" }]);
  });
});

/**
 * `session.model.set`：会话级模型覆盖，走真 socket 验一次接线。
 *
 * 业务（落盘、换 Agent 时清掉、失败时不落）在 `SessionManager.test.ts` 里测透了；这里只钉
 * 「参数验过之后原样进了服务层」与「回的是新快照」。
 */
describe("session.model.set（真 socket）", () => {
  it("改这一段会话的模型：回新快照（生效模型 + 档位），装配方收到会话级覆盖", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    const snapshot = (await client!.call("session.model.set", {
      sessionId: created.sessionId,
      modelId: "gpt-6-astra",
    })) as { modelId: string; modelLevel: string; sessionId: string };

    expect(snapshot.sessionId).toBe(created.sessionId);
    expect(snapshot.modelId).toBe("gpt-6-astra");
    expect(snapshot.modelLevel).toBe("session");
    // 服务端只把「会话级覆盖」递给装配方，解析顺序不在这一层（假 Agent 原样回填）
    expect(agentInputs.at(-1)!.modelId).toBe("gpt-6-astra");
  });

  it("缺 sessionId / modelId → bad-params（空串不是「没给」）", async () => {
    await startDaemon();
    await expect(client!.call("session.model.set", { modelId: "m" })).rejects.toThrow(/bad-params/);
    await expect(
      client!.call("session.model.set", { sessionId: "chat_1", modelId: "" }),
    ).rejects.toThrow(/bad-params/);
  });
});

/**
 * `session.modelParams.set`：会话级模型参数，走真 socket 验一次接线。
 *
 * 业务（落盘、换模型 / 换 Agent 时清掉）在 `SessionManager.test.ts` 里测透了；这里只钉
 * 「不透明载荷原样进了服务层」与「回的是新快照」。
 */
describe("session.modelParams.set（真 socket）", () => {
  it("写会话级参数：装配方收到它、回新快照", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    const snapshot = (await client!.call("session.modelParams.set", {
      sessionId: created.sessionId,
      modelParams: { reasoning_effort: "high" },
    })) as { sessionId: string; modelId: string };

    expect(snapshot.sessionId).toBe(created.sessionId);
    // 服务端只把这一级的覆盖递给装配方（它不解释键名，也不在这里解析档位）
    expect(agentInputs.at(-1)!.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("缺 sessionId → bad-params；`null` 是合法值（= 清掉覆盖）", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: dir,
    })) as { sessionId: string };

    await expect(client!.call("session.modelParams.set", { modelParams: {} })).rejects.toThrow(
      /bad-params/,
    );

    // `null` 不能被参数校验拦掉：它是「清除」的唯一表达方式
    await client!.call("session.modelParams.set", {
      sessionId: created.sessionId,
      modelParams: null,
    });
    expect(agentInputs.at(-1)!.modelParams).toBeUndefined();
  });
});

describe("session.attach：会话活得比连接久", () => {
  it("活着的会话直接接上（不再报 session-exists）", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: workDir("proj-a"),
    })) as { sessionId: string; agentId: string };

    // 「接着上次」走的就是这条：客户端只给 id，服务端知道它还在内存里
    const attached = await client!.call("session.attach", {
      workspaceId: "ws-1",
      path: workDir("proj-a"),
      sessionId: created.sessionId,
    });

    expect(attached).toEqual(created);
    expect(await manager.list("ws-1")).toHaveLength(1);
  });

  it("内存与盘上都没有这个 id → session-missing（不悄悄开一段空的）", async () => {
    await startDaemon();
    await expect(
      client!.call("session.attach", {
        workspaceId: "ws-1",
        path: dir,
        sessionId: "chat_gone",
      }),
    ).rejects.toThrow(/session-missing|no such session/);
  });
});

/**
 * 「活着」的另一半事实：连接还在不在。
 *
 * 业务判定（持有者、宽限期、到点再判一次）在 `SessionManager.test.ts` 里
 * 用假时钟测透了。这里只证明**接线**：`create` / `attach` 真的把这条连接登记成了持有者，
 * 而它断开时服务端自己能摘掉 —— 全程**不需要客户端发任何帧**。
 *
 * 这一段必须用真计时器：宽限期设成 200ms、轮询到它生效，与「判定本身」是两件事。
 */
describe("会话跟着连接走：断开后按宽限期回收（不靠客户端发帧）", () => {
  /** 轮询到条件成立（禁止固定 sleep：等的是「服务端做完这件事」，不是「过了多久」） */
  const waitFor = async (
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 3000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("condition not met within timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it("连接突然断开（一个字节都不发）：宽限期内还活，到点收；期间 attach 得到同一段", async () => {
    const idle = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_hold",
      sessionIdleTimeoutMs: 200,
    });
    const instance = new Daemon({
      aiZenDir: join(dir, "ai-zen-hold"),
      port: 0,
      version: "0.1.0-test",
      handlers: createSessionHandlers({
        manager: idle,
        workspacesRoot: join(dir, "workspaces"),
        defaultWorkspacePath,
      }),
    });
    await instance.start();
    try {
      const conn = await TestClient.connect(instance.port);
      await conn.handshake();
      const created = (await conn.call("session.create", {
        workspaceId: "ws-hold",
        path: workDir("proj-hold"),
      })) as { sessionId: string };

      // ① 断线：socket 直接关掉，一个字节都不发（等价于进程被 kill -9 / 掉网）
      conn.close();

      // ② 宽限期内它还在：这正是「重连能接回正在跑的那一轮」的依据
      await waitFor(async () => (await idle.list("ws-hold")).length === 1);
      expect((await idle.list("ws-hold")).map((item) => item.sessionId)).toEqual([
        created.sessionId,
      ]);

      // ③ 到点：没人看着 → 收（不需要谁来通知）
      await waitFor(async () => (await idle.list("ws-hold")).length === 0);
    } finally {
      await instance.stop("test teardown");
      idle.dispose();
    }
  });
});

/** 改名与删除：两条都是"侧栏动作"，必须能对**盘上的存档**做（不必先进内存） */
describe("session.rename / session.remove（真 socket）", () => {
  it("rename 改 title 不动 id；remove 之后列表与存档都没了", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: workDir("proj-title"),
    })) as { sessionId: string };

    const renamed = await client!.call("session.rename", {
      workspaceId: "ws-1",
      sessionId: created.sessionId,
      title: "重构会话",
    });
    expect(renamed).toEqual({ sessionId: created.sessionId, title: "重构会话" });

    const listed = (await client!.call("session.list", { workspaceId: "ws-1" })) as any;
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ sessionId: created.sessionId, title: "重构会话" });

    expect(
      await client!.call("session.remove", {
        workspaceId: "ws-1",
        sessionId: created.sessionId,
      }),
    ).toEqual({ removed: true });

    const after = (await client!.call("session.list", { workspaceId: "ws-1" })) as any;
    expect(after.sessions).toEqual([]);
    // 幂等
    expect(
      await client!.call("session.remove", {
        workspaceId: "ws-1",
        sessionId: created.sessionId,
      }),
    ).toEqual({ removed: false });
  });

  it("rename 参数缺 title → bad-params（不静默当空名字）", async () => {
    await startDaemon();
    const created = (await client!.call("session.create", {
      workspaceId: "ws-1",
      path: workDir("proj-title2"),
    })) as { sessionId: string };

    await expect(
      client!.call("session.rename", { workspaceId: "ws-1", sessionId: created.sessionId }),
    ).rejects.toThrow(/bad-params/);
  });
});

/**
 * 工作区是一等对象：有名字、id 冻结、可重定位。
 *
 * 这一组用例都在回答同一个问题：**用户把项目目录 `mv` 走之后，那些会话还在不在**。
 * 它们必须用真目录（`mkdtemp`）与真 `rename` —— 假件证明不了「盘上那份记录指向哪里」。
 */
describe("工作区：id 冻结 / list / rename / remove / relocate（真 socket）", () => {
  /** 认一个工作区（客户端启动第一句就是它） */
  const resolveOf = async (path: string) =>
    (await client!.call("workspace.resolve", { path })) as {
      workspaceId: string;
      path: string;
    };
  const createIn = async (workspaceId: string) =>
    (await client!.call("session.create", { workspaceId })) as { sessionId: string };

  it("目录改名后历史不丢：mv → relocate → 会话还在 → 新路径 resolve 回到同一个 id", async () => {
    await startDaemon();
    const before = workDir("proj-old");
    const workspace = await resolveOf(before);
    const created = await createIn(workspace.workspaceId);
    await client!.call("session.save", { sessionId: created.sessionId });

    // ① 用户在自己终端里 `mv ~/proj-old ~/proj-new`（服务端当然不知道）
    const after = join(dir, "proj-new");
    renameSync(before, after);

    // ② 侧栏看得见「这个工作区的目录不在了」：记录与历史都还在，只是路径失效
    const listed = (await client!.call("workspace.list")) as { workspaces: any[] };
    expect(listed.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: workspace.workspaceId,
        path: before,
        pathExists: false,
      }),
    ]);

    // ③ 开会话被明确拒绝（message 里带 path），绝不替用户 mkdir 出一个空目录
    await expect(
      client!.call("session.create", { workspaceId: workspace.workspaceId }),
    ).rejects.toThrow(new RegExp(`workspace-path-missing.*${before}`));
    expect(existsSync(before)).toBe(false);

    // ④ 修复：客户端拿旧 id 把记录指到新路径
    expect(
      await client!.call("workspace.relocate", {
        workspaceId: workspace.workspaceId,
        path: after,
      }),
    ).toEqual({ workspaceId: workspace.workspaceId, path: after });

    // ⑤ 历史还在：会话列表照旧（这就是「挪个目录，历史就没了」不再发生）
    const sessions = (await client!.call("session.list", {
      workspaceId: workspace.workspaceId,
    })) as { sessions: any[] };
    expect(sessions.sessions.map((item) => item.sessionId)).toEqual([created.sessionId]);

    // ⑥ 用户在新目录里重启客户端：resolve(新路径) 还是同一个 id（快路径不命中 → 慢路径）
    expect((await resolveOf(after)).workspaceId).toBe(workspace.workspaceId);

    // ⑦ 那段会话能接回来（「历史没丢」的最终证明）
    const resumed = (await client!.call("session.attach", {
      workspaceId: workspace.workspaceId,
      sessionId: created.sessionId,
    })) as { sessionId: string };
    expect(resumed.sessionId).toBe(created.sessionId);
  });

  it("workspace.list：顺序确定（同一份盘两次调用一致），pathExists 跟着目录生死", async () => {
    await startDaemon();
    const keep = workDir("keep");
    const doomed = workDir("doomed");
    const kept = await resolveOf(keep);
    const lost = await resolveOf(doomed);
    // 改个名字让顺序与创建顺序不同（顺序按显示名，不按创建先后）
    await client!.call("workspace.rename", {
      workspaceId: lost.workspaceId,
      title: "0-最先",
    });

    const first = (await client!.call("workspace.list")) as { workspaces: any[] };
    expect(first.workspaces.map((item) => item.workspaceId)).toEqual([
      lost.workspaceId,
      kept.workspaceId,
    ]);
    expect(first.workspaces.every((item) => item.pathExists)).toBe(true);

    rmSync(doomed, { recursive: true });

    const second = (await client!.call("workspace.list")) as { workspaces: any[] };
    expect(second.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: lost.workspaceId,
        title: "0-最先",
        pathExists: false,
      }),
      expect.objectContaining({ workspaceId: kept.workspaceId, pathExists: true }),
    ]);
    // 顺序不抖：只有 `pathExists` 变了
    expect(second.workspaces.map((item) => item.workspaceId)).toEqual(
      first.workspaces.map((item) => item.workspaceId),
    );
  });

  it("workspace.rename：只改 title（id / path 不动）；空标题与缺字段都是 bad-params", async () => {
    await startDaemon();
    const path = workDir("proj-title");
    const workspace = await resolveOf(path);

    expect(
      await client!.call("workspace.rename", {
        workspaceId: workspace.workspaceId,
        title: "重构现场",
      }),
    ).toEqual({ workspaceId: workspace.workspaceId, title: "重构现场" });

    // id 与 path 一个字都没动：同一个路径拿回来的还是同一个 id
    expect((await resolveOf(path)).workspaceId).toBe(workspace.workspaceId);
    const listed = (await client!.call("workspace.list")) as { workspaces: any[] };
    expect(
      listed.workspaces.find((item) => item.workspaceId === workspace.workspaceId),
    ).toMatchObject({
      title: "重构现场",
      path,
    });

    await expect(
      client!.call("workspace.rename", {
        workspaceId: workspace.workspaceId,
        title: "",
      }),
    ).rejects.toThrow(/bad-params/);
    await expect(
      client!.call("workspace.rename", { workspaceId: workspace.workspaceId }),
    ).rejects.toThrow(/bad-params/);
    // 未知工作区不是 bad-params（参数是对的，东西不在）
    await expect(
      client!.call("workspace.rename", { workspaceId: "nope-00000000", title: "x" }),
    ).rejects.toThrow(/unknown-workspace/);
  });

  it("workspace.remove：整个目录（含 sessions）被删、活会话跟着退场、幂等 removed:false", async () => {
    await startDaemon();
    const workspace = await resolveOf(workDir("proj-rm"));
    const created = await createIn(workspace.workspaceId);
    await client!.call("session.save", { sessionId: created.sessionId });

    const rootDir = join(dir, "workspaces", workspace.workspaceId);
    expect(existsSync(join(rootDir, "sessions", `${created.sessionId}.json`))).toBe(true);

    expect(await client!.call("workspace.remove", { workspaceId: workspace.workspaceId })).toEqual({
      removed: true,
    });
    expect(existsSync(rootDir)).toBe(false);

    // 活会话也得退场：不然它下一轮收尾会把存档写回来（`FileSessionStore.write` 自己 mkdir），
    // 刚删掉的工作区就部分复活了
    const live = (await client!.call("session.list", {
      workspaceId: workspace.workspaceId,
      includeSaved: false,
    })) as { sessions: any[] };
    expect(live.sessions).toEqual([]);

    // 幂等：本来就不在了
    expect(await client!.call("workspace.remove", { workspaceId: workspace.workspaceId })).toEqual({
      removed: false,
    });
  });

  it("workspace.relocate：新路径不存在 → workspace-path-missing 且没被创建；被别人占着 → workspace-exists", async () => {
    await startDaemon();
    const workspace = await resolveOf(workDir("owner"));

    const missing = join(dir, "not-there");
    await expect(
      client!.call("workspace.relocate", {
        workspaceId: workspace.workspaceId,
        path: missing,
      }),
    ).rejects.toThrow(/workspace-path-missing/);
    expect(existsSync(missing)).toBe(false); // 服务端不替用户 mkdir

    // 同一个目录不能有两份记录：会话会在两个 id 下各长一份
    const taken = workDir("taken");
    const occupant = await resolveOf(taken);
    await expect(
      client!.call("workspace.relocate", { workspaceId: workspace.workspaceId, path: taken }),
    ).rejects.toThrow(/workspace-exists/);
    // 记录一个都没动
    const listed = (await client!.call("workspace.list")) as { workspaces: any[] };
    expect(
      listed.workspaces.find((item) => item.workspaceId === workspace.workspaceId),
    ).toMatchObject({ path: join(dir, "owner") });
    expect(
      listed.workspaces.find((item) => item.workspaceId === occupant.workspaceId),
    ).toMatchObject({
      path: taken,
    });
  });

  it("session.create 的路径缺失 → workspace-path-missing（那条路带 path 也一样），且不 mkdir", async () => {
    await startDaemon();
    const missing = join(dir, "never-existed");
    await expect(
      client!.call("session.create", { workspaceId: "ws-x", path: missing }),
    ).rejects.toThrow(new RegExp(`workspace-path-missing.*${missing}`));
    expect(existsSync(missing)).toBe(false);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("路径缺失只挡开会话：attach / last / list 照旧（历史在存档里，与目录在不在无关）", async () => {
    await startDaemon();
    const path = workDir("proj-vanish");
    const workspace = await resolveOf(path);
    const created = await createIn(workspace.workspaceId);
    await client!.call("session.save", { sessionId: created.sessionId });
    // 收掉活会话，逼 attach 走「从存档装回来」那条路
    expect(await client!.call("session.close", { sessionId: created.sessionId })).toEqual({
      closed: true,
    });

    // 用户把项目目录整个删了
    rmSync(path, { recursive: true });

    expect(await client!.call("session.last", { workspaceId: workspace.workspaceId })).toEqual({
      sessionId: created.sessionId,
    });
    const listed = (await client!.call("session.list", {
      workspaceId: workspace.workspaceId,
    })) as { sessions: any[] };
    expect(listed.sessions.map((item) => item.sessionId)).toEqual([created.sessionId]);
    expect(
      (
        (await client!.call("session.attach", {
          workspaceId: workspace.workspaceId,
          sessionId: created.sessionId,
        })) as { sessionId: string }
      ).sessionId,
    ).toBe(created.sessionId);

    // 但开会话仍然拒绝 —— 同一个前提的两种待遇，差别只在「会不会真的动那个目录」
    await expect(
      client!.call("session.create", { workspaceId: workspace.workspaceId }),
    ).rejects.toThrow(/workspace-path-missing/);
  });
});
