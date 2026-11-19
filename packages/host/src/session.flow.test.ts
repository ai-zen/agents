/**
 * 端到端冒烟：真起 `HostApp`（端口 `0`）+ 真 `ws` 客户端，走完一条会话的完整链路。
 *
 * 这一轮验收的是「零件接起来真的能跑」，所以除了 agent 那一层（用假 agent 工厂，不连模型），
 * 其余每一环都是真的：真的 SQLite 文件、真的 WebSocket、真的 Scope 装配、真的流式事件。
 *
 * 七步（与交付报告一一对应）：
 *   1. 本地凭证从 `<数据根>/run/token` 拿到 → `hello` 成功；不带凭证 / 凭证不对被拒；
 *   2. `workspace.create` → `session.create`；
 *   3. `session.send` 一句：收 `message.delta` 与忙闲（忙 → 闲）；
 *   4. `message.list` 拉回这段会话的消息（用户 + 助手 + 工具结果）；
 *   5. `session.state` 返回读数（闲着、队里空着）；
 *   6. 客户端断开 → 宿主**不**收尾（关宿主是显式动作，PRD 4.12）；再连回来消息还在；
 *   7. `host.shutdown` → 进程收尾一次（`ExitFacts` 里 `scopes: 1`：收尾那一刻还持有 Scope，
 *      随后连同 MCP 连接一起销毁）→ 用**同一个数据根**再起一个，消息仍拿得回来。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { AgentNS as AgentNSValue } from "@ai-zen/agents-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHost } from "./app.js";
import type { ExitFacts, HostApp } from "./app.js";
import { readLocalToken } from "./net/discovery.js";
import {
  isError,
  isNotification,
  isSuccess,
  makeTempDir,
  TestClient,
  wait,
  type ReceivedFrame,
  type TempDir,
} from "./net/TestSupport.js";
import type { AgentFactory } from "./runtime/index.js";
import { FakeAgent } from "./runtime/TestSupport.js";
import type {
  SessionCreateResult,
  SessionSendResult,
  SessionStateResult,
  MessageDeltaPayload,
  MessageListResult,
  StatePayload,
  WorkspaceCreateResult,
} from "./wire/index.js";

// ---------------------------------------------------------------------------
// 夹具：临时数据根 + 假 agent 工厂
// ---------------------------------------------------------------------------

/** 假端点的密钥：本轮不连模型，写一份假 key 就够（不把真 key 写进仓库） */
const FAKE_CONFIG = JSON.stringify(
  {
    endpoints: [
      {
        id: "fake",
        name: "Fake Endpoint",
        baseUrl: "https://example.invalid/v1",
        apiKey: "sk-fake-for-tests",
        description: "端到端冒烟用的假端点",
      },
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 1000, guard: 2000 },
        vision: true,
        custom: true,
      },
    ],
  },
  null,
  2,
);

/** 临时数据根里的默认助手：绑定 `test-model`，`custom: true` 让 SDK 初始化不覆盖它 */
const FAKE_AGENT = JSON.stringify(
  {
    id: "default",
    name: "Test Assistant",
    description: "端到端冒烟用的助手",
    modelId: "test-model",
    messages: [{ id: "sys-1", role: "system", status: "completed", content: "你是测试助手。" }],
    custom: true,
  },
  null,
  2,
);

/** 第一轮吐的增量：思考 → 正文两片 → 一片工具调用（覆盖「拼工具调用」这一态） */
const ROUND_ONE_DELTAS: AgentNS.Delta[] = [
  { reasoning_content: "先想一下。" },
  { content: "你" },
  { content: "好。" },
  {
    tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } },
    ],
  },
];

/** 假 agent 工厂：每次装配都给一个新的 `FakeAgent`（agent 常驻：一段会话只装配一次，跨轮复用） */
const createAgent: AgentFactory = async () =>
  new FakeAgent([
    {
      deltas: ROUND_ONE_DELTAS,
      toolCalls: [{ id: "call_1", name: "ls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      deltas: [{ content: "完事。" }],
      usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
    },
  ]);

let dataRoot: TempDir;
let workspaceDir: TempDir;
let app: HostApp | null = null;
let client: TestClient | null = null;
const exits: ExitFacts[] = [];

beforeAll(async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ai-zen-e2e-"));
  dataRoot = {
    path: base,
    remove: () => fs.rm(base, { recursive: true, force: true }),
  };
  workspaceDir = await makeTempDir("ai-zen-e2e-cwd-");
  await fs.mkdir(join(base, "agents"), { recursive: true });
  await fs.writeFile(join(base, "config.json"), FAKE_CONFIG, "utf8");
  await fs.writeFile(join(base, "agents", "default.json"), FAKE_AGENT, "utf8");
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.shutdown("requested").catch(() => undefined);
  await workspaceDir.remove();
  await dataRoot.remove();
});

/** 起一个服务（都用同一个数据根；`port: 0` 让系统分配） */
async function startHost(): Promise<HostApp> {
  const created = await createHost({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    createAgent,
    exit: (facts) => {
      exits.push(facts);
    },
    logger: { warn: () => undefined, error: () => undefined },
  });
  await created.start();
  return created;
}

/**
 * 等下一个**响应**帧（中间插进来的推送先跳过）。
 *
 * 事件与回包会交错到达：`client.queue.next()` 只看「下一帧」，在这一条链路上不够用。
 */
async function nextResponse(): Promise<ReceivedFrame> {
  const connection = client;
  if (!connection) throw new Error("客户端不在");
  for (;;) {
    const frame = await connection.queue.next();
    if (!isNotification(frame)) return frame;
  }
}

/** 等一个条件成立（轮询；超时算用例失败） */
async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await wait(10);
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

/**
 * 读到这段会话重新闲下来为止，顺手把增量与忙闲收集起来。
 *
 * 投递之后只剩「消息自己的事件」（`message.added` / `message.delta` / `message.changed`）与
 * 「忙闲」（`state`）两类推送：前者是过程，后者说明它是不是还在干。读到 `status: idle`
 * 就算这一段的事说完了。
 */
async function collectRun(timeoutMs = 5000): Promise<{
  deltas: MessageDeltaPayload[];
  statuses: string[];
}> {
  const connection = client;
  if (!connection) throw new Error("客户端不在");
  const deltas: MessageDeltaPayload[] = [];
  const statuses: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame: ReceivedFrame = await connection.queue.next(timeoutMs);
    if (!isNotification(frame)) continue;
    if (frame.method === "message.delta") {
      deltas.push(frame.params as MessageDeltaPayload);
      continue;
    }
    if (frame.method === "state") {
      const payload = frame.params as StatePayload;
      if (statuses[statuses.length - 1] !== payload.status) statuses.push(payload.status);
      if (payload.status === "idle") return { deltas, statuses };
    }
  }
  throw new Error("没等到这段会话闲下来");
}

// ---------------------------------------------------------------------------
// 七步
// ---------------------------------------------------------------------------

describe("端到端冒烟：本地凭证 → 项目 → 会话 → 一轮 → 消息 → 现场 → 重启 → 退出", () => {
  it("跑完整条链路", async () => {
    // ---- 步骤 1：本地凭证与握手 ----
    app = await startHost();
    const target = app.address;
    expect(target).not.toBeNull();
    const url = `ws://127.0.0.1:${target?.port ?? 0}/`;

    const token = await readLocalToken(app.paths);
    expect(token).not.toBeNull();
    const localToken = token ?? "";

    client = await TestClient.connect(url);

    // 不带凭证：握手被拒（未授权的连接连方法名都不判断）
    client.request("host.hello", { clientInfo: { name: "e2e", version: "0.0.0" } });
    const missing = await client.queue.next();
    expect(isError(missing)).toBe(true);
    if (isError(missing)) expect(missing.error.data.code).toBe("invalid_params");

    // 凭证不对：同样是拒（`unauthorized`）
    client.request("host.hello", {
      token: "not-the-token",
      clientInfo: { name: "e2e", version: "0.0.0" },
    });
    const rejected = await client.queue.next();
    expect(isError(rejected)).toBe(true);
    if (isError(rejected)) expect(rejected.error.data.code).toBe("unauthorized");

    // 交付文件里的那串：握手成功，语言挂在连接上
    const hello = await client.hello(localToken, { language: "zh" });
    const helloResult = hello.result as { language: string; protocolVersion: string };
    expect(helloResult.language).toBe("zh");
    expect(typeof helloResult.protocolVersion).toBe("string");

    // ---- 步骤 2：项目与会话 ----
    const created = await client.call("workspace.create", {
      cwd: workspaceDir.path,
      name: "冒烟项目",
    });
    const workspace = (created.result as WorkspaceCreateResult).workspace;
    expect(workspace.folder.exists).toBe(true);

    const sessionCreated = await client.call("session.create", {
      workspaceId: workspace.id,
      agentId: "default",
      modelId: "test-model",
    });
    const createdSession = (sessionCreated.result as SessionCreateResult).session;
    if (!createdSession) throw new Error("session.create 没有建出会话");
    const sessionId = createdSession.id;
    expect(sessionId.length).toBeGreaterThan(0);

    // ---- 步骤 3：投一句（回执只有那条用户消息的 id，其余靠事件） ----
    client.request("session.send", {
      sessionId,
      input: { content: "你好" },
    });
    const accepted = await nextResponse();
    if (!isSuccess(accepted)) throw new Error(`受理没成功：${JSON.stringify(accepted)}`);
    const acceptedResult = accepted.result as SessionSendResult;
    // 回执只有用户消息 id 与附件结局：没有状态、没有「叫醒了没有」、没有结果
    expect(Object.keys(acceptedResult).sort()).toEqual(["attachments", "userMessageId"]);
    expect(acceptedResult.userMessageId.length).toBeGreaterThan(0);

    const run = await collectRun();
    // 忙闲：这一段结束时报「闲」（更细的阶段由客户端按消息与增量自己推，宿主不报）
    expect(run.statuses).toContain("idle");
    // 增量都挂在同一条助手消息上
    expect(run.deltas.length).toBeGreaterThan(0);
    const assistantMessageId = run.deltas[0]?.messageId ?? "";
    expect(assistantMessageId.length).toBeGreaterThan(0);

    // ---- 步骤 4：消息拉回来是 core 的形状 ----
    const listed = await client.call("message.list", { sessionId });
    const page = listed.result as MessageListResult;
    expect(page.anchor).toBeNull();
    expect(page.messages.map((message) => message.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.Tool,
      AgentNSValue.Role.Assistant,
    ]);
    expect(page.messages[0]?.id).toBe(acceptedResult.userMessageId);
    expect(page.messages[1]?.id).toBe(assistantMessageId);
    // 用户那条就是用户打的那一句（cwd 不再按轮拼进来，F-D9）
    expect(page.messages[0]?.content).toBe("你好");
    expect(page.messages[0]?.hidden).toBeUndefined();
    // 而库里最先写的那条是隐藏的 cwd 消息：`seq` 在用户消息之前，默认不出网
    const withHidden = await client.call("message.list", { sessionId, includeHidden: true });
    const cwdMessage = (withHidden.result as MessageListResult).messages[0];
    expect(cwdMessage?.role).toBe(AgentNSValue.Role.User);
    expect(cwdMessage?.hidden).toBe(true);
    expect(cwdMessage?.id).not.toBe(acceptedResult.userMessageId);
    const cwdText = typeof cwdMessage?.content === "string" ? cwdMessage.content : "";
    // 正文就是那个路径（不是一句渲染过的话）：与交接换完记忆时 SDK 生成的那一条同形同文
    expect(cwdText).toBe(workspaceDir.path);
    expect((withHidden.result as MessageListResult).messages[1]?.id).toBe(
      acceptedResult.userMessageId,
    );
    expect(page.messages[1]?.content).toBe("你好。");
    expect(page.messages[1]?.reasoning_content).toBe("先想一下。");
    expect(page.messages[2]?.content).toBe("ok:ls");
    expect(page.messages[3]?.content).toBe("完事。");
    for (const message of page.messages) {
      expect(message.status).toBe(AgentNSValue.MessageStatus.Completed);
    }

    // ---- 步骤 5：读数（四件事 + inbox + subagent 名册 + 交接态 + 时刻，没有用量也没有阶段） ----
    client.request("session.state", { sessionId });
    const stateFrame = await nextResponse();
    if (!isSuccess(stateFrame)) throw new Error(`读数没拿到：${JSON.stringify(stateFrame)}`);
    const snapshot = (stateFrame.result as SessionStateResult).state;
    expect(Object.keys(snapshot).sort()).toEqual([
      "alive",
      "at",
      "handoff",
      "inbox",
      "inputPaused",
      "outputPaused",
      "sessionId",
      "status",
      "subAgents",
    ]);
    // 四件事各占一格：这一段还在（有 agent）、手上没活、两道闸都开着
    expect(snapshot.alive).toBe(true);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.inputPaused).toBe(false);
    expect(snapshot.outputPaused).toBe(false);
    expect(snapshot.inbox).toEqual([]);
    // 这一段没派过 subagent、也不在交接态：两格都是现读，没有就是空的
    expect(snapshot.subAgents).toEqual([]);
    expect(snapshot.handoff).toBeNull();
    expect(snapshot.sessionId).toBe(sessionId);

    // ---- 步骤 6：最后一个客户端断开，宿主**不**收尾（关宿主是显式动作，PRD 4.12） ----
    await client.close();
    client = null;
    await wait(80);
    expect(exits).toEqual([]);
    expect(app.running).toBe(true);

    // 再连回来：还是同一个进程，消息一条不少
    client = await TestClient.connect(url);
    await client.hello(localToken);
    const relisted = await client.call("message.list", { sessionId });
    const restored = relisted.result as MessageListResult;
    expect(restored.messages.map((message) => message.id)).toEqual(
      page.messages.map((message) => message.id),
    );

    // ---- 步骤 7：显式关宿主 → 收尾一次（Scope 与 MCP 连接一起拆）→ 同一个数据根再起一个 ----
    // 先让这个进程手里真的有一个 Scope：跑过一段会话之后它就拿着（它不会自己消失）
    client.request("session.send", { sessionId, input: { content: "第二句" } });
    const secondAccepted = await nextResponse();
    expect(isSuccess(secondAccepted)).toBe(true);
    expect(app.scopeRegistry.workspaceIds()).toEqual([workspace.id]);
    await collectRun();

    // 连发两轮之后库里的 cwd 消息仍然只有一条（每段不再注入，F-D9）
    const afterSecond = await client.call("message.list", {
      sessionId,
      includeHidden: true,
    });
    const hiddenMessages = (afterSecond.result as MessageListResult).messages.filter(
      (message) => message.hidden === true,
    );
    expect(hiddenMessages).toHaveLength(1);
    expect(hiddenMessages[0]?.id).toBe(cwdMessage?.id);

    client.request("host.shutdown", {});
    expect(isSuccess(await nextResponse())).toBe(true);
    await waitFor(() => exits.length === 1);
    const facts = exits[0]!;
    // 收尾那一刻还持有 1 个 Scope（随后被 `disposeAll` 拆掉）
    expect(facts).toMatchObject({ reason: "requested", scopes: 1 });
    expect(app.scopeRegistry.workspaceIds()).toEqual([]);
    expect(app.running).toBe(false);
    await client.close();
    client = null;
    app = null;

    // 发现文件在收尾时被摘掉了（客户端不再指向一个已经不存在的进程）
    const runDir = await fs.readdir(join(dataRoot.path, "run"));
    expect(runDir).not.toContain("host.json");

    // 同一个数据根再起一个：消息还在库里，交付文件里那串凭证仍然有效
    app = await startHost();
    const secondTarget = app.address;
    const secondToken = await readLocalToken(app.paths);
    expect(secondToken).toBe(localToken);

    client = await TestClient.connect(`ws://127.0.0.1:${secondTarget?.port ?? 0}/`);
    await client.hello(secondToken ?? "");

    const afterRestart = await client.call("message.list", { sessionId });
    const reloaded = afterRestart.result as MessageListResult;
    expect(reloaded.messages.slice(0, 4).map((message) => message.content)).toContain("你好。");
    expect(reloaded.messages.map((message) => message.id)).toContain(acceptedResult.userMessageId);
  }, 30000);
});
