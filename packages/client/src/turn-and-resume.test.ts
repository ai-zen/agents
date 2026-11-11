/**
 * 一轮真跑，以及「接着上次」—— 真 SDK + 真 HTTP 流 + 真落盘。
 *
 * 单测里到处都是假 Agent（`agent.fire("chunk-parsed", …)`），那是**对**的：会话层不该为了
 * 测试去理解 SDK。但它留下一条缝 —— 「`openai` SDK 发流式请求 → 逐片解析 → 拼正文 →
 * 流末用量 → 服务端翻译成事件 → 收尾前落盘」这一整段没人走过。真模型能走，但要 key、要网、
 * 答复还不确定（断言只能写「非空」）。
 *
 * 于是这里用 {@link startFakeLlm} 顶替模型：它就是一个 OpenAI 兼容的 SSE 端点，答复与分片
 * 数由用例指定。于是一条完整链路可以**确定地**断言：
 *
 *   1. 正文是**流式**拼出来的（多片 delta 拼起来等于答复）；
 *   2. 每轮 `session-turn-end` 之前把会话写进 `workspaces/<id>/sessions/` 并把指针挪过去 ——
 *      这就是「聊完退出、再 `ai` 接着上次」的全部机制；
 *   3. 把服务端整个换掉（模拟守护进程重启）之后，`attach` 能从存档把这段会话装回来。
 *
 * 第 3 条是这一组用例存在的理由：`attach` 走的是「盘上有就装回来」，而「盘上真的有」由第
 * 1 条（真 SDK 跑完收尾）保证 —— 两边都是真的，中间没有假件。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  FileSessionStore,
  SessionAgentFactory,
  SessionManager,
  AGENT_EVENTS,
  EVENT_METHODS,
  SESSION_EVENTS,
  type ServerEvent,
} from "@ai-zen/agents-server";
import type { ClientInfo } from "./types.js";
import { SocketServerClient } from "./socket-server-client.js";
import { RemoteSessions } from "./facade/sessions.js";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { AgentNS, applyChunk } from "@ai-zen/agents-core";

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };
const REPLY = "这是一段流式答复，用来验证拼接。";

let dir: string;
let workspaceDir: string;
let llm: FakeLlm;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let client: SocketServerClient | null = null;
let sessions: RemoteSessions;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aiz-turn-"));
  workspaceDir = join(dir, "proj");
  mkdirSync(workspaceDir, { recursive: true });
  llm = await startFakeLlm({ reply: REPLY, chunks: 4 });
  seedAiZenDir(dir, llm.baseUrl);
});

afterEach(async () => {
  client?.close();
  client = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  await llm.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 起一套完整的服务端（真的装配方 + 真 SDK Agent + 真存档），并接上一个客户端。
 *
 * 抽成函数是因为「重启」那条用例要**再来一遍**：同一个 `dir`、同一个存档目录，只是
 * 内存里的东西全换掉。
 */
async function boot(): Promise<void> {
  const factory = new SessionAgentFactory({ aiZenDir: dir, homeDir: dir });
  manager = new SessionManager({
    createAgent: (input) => factory.create(input),
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
  });
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({
        manager,
        workspacesRoot: join(dir, "workspaces"),
        defaultWorkspacePath: workspaceDir,
      }),
    },
  });
  await daemon.start();
  client = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
  sessions = new RemoteSessions(client);
  // `events.watch` 是**连接级**的（归 `ServerConnection`）：这里直接发那一帧
  await client.call(EVENT_METHODS.watch);
}

/** 关掉这一套（模拟守护进程重启：内存全丢，只剩盘上的东西） */
async function shutdown(): Promise<void> {
  client?.close();
  client = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("restart");
    daemon = null;
  }
}

/** 跑一轮并等它收尾，返回这一轮收到的事件 */
async function runTurn(sessionId: string, prompt: string): Promise<ServerEvent[]> {
  const seen: ServerEvent[] = [];
  const offs = [
    client!.on(AGENT_EVENTS.chunk, (event) => seen.push(event)),
    client!.on(SESSION_EVENTS.turnEnd, (event) => seen.push(event)),
  ];
  try {
    const { turnId } = await sessions.send(sessionId, prompt);
    await waitFor(() =>
      seen.some((event) => event.event === "session-turn-end" && event.turnId === turnId),
    );
    return seen;
  } finally {
    for (const off of offs) off();
  }
}

describe("一轮真跑（真 SDK + 流式 HTTP）", () => {
  it("正文是流式拼出来的：多片 delta 拼起来等于答复，收尾 ok", async () => {
    await boot();
    const { sessionId } = await sessions.open({ path: workspaceDir, agentId: "default" });

    const events = await runTurn(sessionId, "你好");

    // 线上只有原始片：用 core 的 `applyChunk` 折一遍（客户端就是这么做的），
    // 折出来的正文必须与答复逐字相同 —— 「流式」这件事才算走通。
    const pieces = events.filter((event) => event.event === "chunk");
    const receiver = { role: AgentNS.Role.Assistant, content: "" } as AgentNS.Message;
    for (const event of pieces) applyChunk(receiver, event.chunk as never);
    // 4 片 + 收尾那一片只带 usage（正文为空）—— 至少得有 2 片正文才算「流式」
    expect(pieces.length).toBeGreaterThan(1);
    expect(receiver.content).toBe(REPLY);
    // 流末 chunk 的真实产物用量被折进消息（状态栏速率按它校准）
    expect(receiver.usage?.completion_tokens).toBe(7);
    expect(events.at(-1)).toMatchObject({ event: "session-turn-end", ok: true });

    // 服务端那份快照才是真相：最后一条是已完成的 assistant，正文就是答复
    const snapshot = await sessions.snapshot(sessionId);
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", content: REPLY });
    expect(llm.requests.at(-1)!.body.stream).toBe(true);
  });

  it("每轮 session-turn-end 之前落盘：存档写进工作区，指针指向它", async () => {
    await boot();
    const workspace = await sessions.resolveWorkspace(workspaceDir);
    const { sessionId } = await sessions.open({ path: workspaceDir, agentId: "default" });

    await runTurn(sessionId, "留档");

    const root = join(dir, "workspaces", workspace.workspaceId);
    expect(existsSync(join(root, "sessions", `${sessionId}.json`))).toBe(true);
    // 指针 = 「本工作区上一轮会话」：下次 `ai` / TUI 续接靠的就是它
    const pointer = JSON.parse(readFileSync(join(root, "last-session.json"), "utf-8"));
    expect(pointer.id).toBe(sessionId);
    expect(await sessions.last(workspace.workspaceId)).toEqual({ sessionId });
  });
});

describe("接着上次：重启之后从存档装回来", () => {
  it("换一套服务端（内存全丢）后 attach：历史仍然在，能接着聊", async () => {
    await boot();
    const workspace = await sessions.resolveWorkspace(workspaceDir);
    const { sessionId } = await sessions.open({ path: workspaceDir, agentId: "default" });
    await runTurn(sessionId, "第一句");

    // 守护进程重启：会话、Agent、Scope 全没了，只剩盘上那份存档
    await shutdown();
    await boot();

    expect((await sessions.last(workspace.workspaceId)).sessionId).toBe(sessionId);
    const reopened = await sessions.attach({
      workspaceId: workspace.workspaceId,
      sessionId,
      path: workspaceDir,
    });
    expect(reopened.sessionId).toBe(sessionId);

    // 系统提示来自 SDK 的出厂 Agent 模板（与本次改造无关）：只看对话那几条
    const chat = (await sessions.snapshot(sessionId)).messages.filter(
      (message) => (message as { role?: string }).role !== "system",
    );
    expect(chat).toHaveLength(2);
    expect(chat[0]).toMatchObject({ role: "user", content: "第一句" });
    expect(chat[1]).toMatchObject({ role: "assistant", content: REPLY });

    // 接着聊：新的一轮把**上一轮的上下文**一起发给模型（这就是「续接」的意义）
    llm.requests.length = 0;
    await runTurn(sessionId, "第二句");
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("第一句");
    expect(sent).toContain(REPLY);
    expect(sent).toContain("第二句");
  });
});

/** 造一份最小配置（端点指向假模型）+ 一个绑了模型的 Agent 定义 */
function seedAiZenDir(root: string, baseUrl: string): void {
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "sub-agents"), { recursive: true });
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "fake", name: "Fake", baseUrl, apiKey: "sk-fake", description: "" }],
      models: [
        { id: "fake-model", name: "Fake", endpointId: "fake", modelName: MODEL_NAME, custom: true },
      ],
      defaultModel: "fake-model",
      defaultAgent: "default",
      version: 4,
    }),
  );
  writeFileSync(
    join(root, "agents", "default.json"),
    JSON.stringify({
      id: "default",
      name: "默认",
      modelId: "fake-model",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

const MODEL_NAME = "fake-model";

/** 轮询到条件成立（不固定 sleep） */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 超时");
}
