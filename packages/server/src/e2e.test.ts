/**
 * 端到端冒烟：真起 `ServerApp`（端口 `0`）+ 真 `ws` 客户端，走完一条会话的完整链路。
 *
 * 这一轮验收的是「零件接起来真的能跑」，所以除了 agent 那一层（用假 agent 工厂，不连模型），
 * 其余每一环都是真的：真的 SQLite 文件、真的 WebSocket、真的 Scope 装配、真的流式事件。
 *
 * 七步（与交付报告一一对应）：
 *   1. 本地凭证从 `<数据根>/run/token` 拿到 → `hello` 成功；不带凭证 / 凭证不对被拒；
 *   2. `workspace.create` → `conversation.create`；
 *   3. `conversation.send` 一轮：收 `message.delta`、收 `run.state` 的六态推进、收最终结算；
 *   4. `message.list` 拉回这一轮的消息（用户 + 助手 + 工具结果）；
 *   5. `conversation.state` 返回现场（跑完是空闲）；
 *   6. 关掉服务器 → 用**同一个数据根**再起一个 → `message.list` 仍拿回同一批消息；
 *   7. 断开所有连接 + 等 Scope 回收 → `onAllRecycled` 触发退出判据（`reason: idle`）。
 *
 * 退出判据不靠轮询：触发源只有「Scope 全部回收」与「一轮结算」两处（裁定 R53）。所以第 7 步
 * 的顺序是「连接先断、Scope 后回收」：回收那一刻判据才看到「没有连接」。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { AgentNS as AgentNSValue } from "@ai-zen/agents-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app.js";
import type { ExitFacts, ServerApp } from "./app.js";
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
  ConversationCreateResult,
  ConversationSendResult,
  ConversationStateResult,
  MessageDeltaPayload,
  MessageListResult,
  RunStatePayload,
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

/** 假 agent 工厂：每次装配都给一个新的 `FakeAgent`（agent 用完即弃，PRD D28） */
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
let app: ServerApp | null = null;
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
async function startServer(): Promise<ServerApp> {
  const created = await createServer({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    createAgent,
    // 空闲回收调到 150ms：用例不能真等十分钟，又要在「连接断开之后」才回收（第 7 步）
    scopeIdleTimeoutMs: 150,
    exit: (facts) => {
      exits.push(facts);
    },
    logger: { warn: () => undefined, error: () => undefined },
  });
  await created.start();
  return created;
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
 * 从帧队列里读到这一轮推送结束为止，顺手把增量与六态收集起来。
 *
 * 结算时服务端连推三条（`run.state` → `usage` → `conversation.changed`），所以等到最后那条
 * 才算这一轮的事说完 —— 提前返回会把剩下的帧留给下一次调用，那属于用例自己的时序错误。
 */
async function collectRun(timeoutMs = 5000): Promise<{
  deltas: MessageDeltaPayload[];
  phases: string[];
  settled: RunStatePayload;
}> {
  const connection = client;
  if (!connection) throw new Error("客户端不在");
  const deltas: MessageDeltaPayload[] = [];
  const phases: string[] = [];
  let settled: RunStatePayload | null = null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame: ReceivedFrame = await connection.queue.next(timeoutMs);
    if (!isNotification(frame)) continue;
    if (frame.method === "message.delta") {
      deltas.push(frame.params as MessageDeltaPayload);
      continue;
    }
    if (frame.method === "run.state") {
      const payload = frame.params as RunStatePayload;
      const phase = payload.run.generation?.phase;
      if (phase !== undefined && phases[phases.length - 1] !== phase) phases.push(phase);
      if (payload.run.status === "settled") settled = payload;
      continue;
    }
    if (frame.method === "conversation.changed" && settled !== null) {
      return { deltas, phases, settled };
    }
  }
  throw new Error("没等到这一轮的推送收尾");
}

// ---------------------------------------------------------------------------
// 七步
// ---------------------------------------------------------------------------

describe("端到端冒烟：本地凭证 → 项目 → 对话 → 一轮 → 消息 → 现场 → 重启 → 退出", () => {
  it("跑完整条链路", async () => {
    // ---- 步骤 1：本地凭证与握手 ----
    app = await startServer();
    const target = app.address;
    expect(target).not.toBeNull();
    const url = `ws://127.0.0.1:${target?.port ?? 0}/`;

    const token = await readLocalToken(app.paths);
    expect(token).not.toBeNull();
    const localToken = token ?? "";

    client = await TestClient.connect(url);

    // 不带凭证：握手被拒（未授权的连接连方法名都不判断）
    client.request("server.hello", { clientInfo: { name: "e2e", version: "0.0.0" } });
    const missing = await client.queue.next();
    expect(isError(missing)).toBe(true);
    if (isError(missing)) expect(missing.error.data.code).toBe("invalid_params");

    // 凭证不对：同样是拒（`unauthorized`）
    client.request("server.hello", {
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

    // ---- 步骤 2：项目与对话 ----
    const created = await client.call("workspace.create", {
      cwd: workspaceDir.path,
      name: "冒烟项目",
    });
    const workspace = (created.result as WorkspaceCreateResult).workspace;
    expect(workspace.folder.exists).toBe(true);

    const conversationCreated = await client.call("conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
      modelId: "test-model",
    });
    const conversationId = (conversationCreated.result as ConversationCreateResult).conversation.id;
    expect(conversationId.length).toBeGreaterThan(0);

    // ---- 步骤 3：一轮对话（受理即返回两个 id，事件随后到） ----
    client.request("conversation.send", {
      conversationId,
      input: { content: "你好" },
    });
    const accepted = await client.queue.next();
    if (!isSuccess(accepted)) throw new Error(`受理没成功：${JSON.stringify(accepted)}`);
    const acceptedResult = accepted.result as ConversationSendResult;
    expect(acceptedResult.assistantMessageId.length).toBeGreaterThan(0);

    const run = await collectRun();
    // 六态推进：连上 → 等首字 → 在想 → 在输出 → 拼工具调用 → 等工具
    expect(run.phases).toEqual(
      expect.arrayContaining([
        "connected",
        "awaiting_first_token",
        "thinking",
        "generating",
        "assembling_tool_calls",
        "awaiting_tools",
      ]),
    );
    // 增量都挂在助手消息上，最终结算说「跑完了」
    expect(run.deltas.length).toBeGreaterThan(0);
    expect(run.deltas[0]?.messageId).toBe(acceptedResult.assistantMessageId);
    expect(run.settled.run.outcome).toBe("completed");
    expect(run.settled.run.usage.turn.total_tokens).toBe(42);

    // ---- 步骤 4：消息拉回来是 core 的形状 ----
    const listed = await client.call("message.list", { conversationId });
    const page = listed.result as MessageListResult;
    expect(page.anchor).toBeNull();
    expect(page.messages.map((message) => message.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.Tool,
      AgentNSValue.Role.Assistant,
    ]);
    expect(page.messages[0]?.id).toBe(acceptedResult.userMessageId);
    expect(page.messages[1]?.id).toBe(acceptedResult.assistantMessageId);
    expect(page.messages[0]?.content).toBe("你好");
    expect(page.messages[1]?.content).toBe("你好。");
    expect(page.messages[1]?.reasoning_content).toBe("先想一下。");
    expect(page.messages[2]?.content).toBe("ok:ls");
    expect(page.messages[3]?.content).toBe("完事。");
    for (const message of page.messages) {
      expect(message.status).toBe(AgentNSValue.MessageStatus.Completed);
    }

    // ---- 步骤 5：现场快照（跑完就是空闲） ----
    const stateFrame = await client.call("conversation.state", { conversationId });
    const snapshot = (stateFrame.result as ConversationStateResult).state;
    expect(snapshot.run.status).toBe("idle");
    expect(snapshot.usage.total.total_tokens).toBe(42);
    expect(snapshot.context.guardThreshold).toBe(2000);
    expect(snapshot.conversationId).toBe(conversationId);

    // ---- 步骤 6：关掉服务器，用同一个数据根再起一个 ----
    await client.close();
    client = null;
    const firstFacts = await app.shutdown("requested");
    expect(firstFacts.reason).toBe("requested");
    app = null;

    // 发现文件在收尾时被摘掉了（客户端不再指向一个已经不存在的进程）
    const runDir = await fs.readdir(join(dataRoot.path, "run"));
    expect(runDir).not.toContain("server.json");

    app = await startServer();
    const secondTarget = app.address;
    const secondToken = await readLocalToken(app.paths);
    // 交付文件里那串仍然有效，重启不会每次都换凭证
    expect(secondToken).toBe(localToken);

    client = await TestClient.connect(`ws://127.0.0.1:${secondTarget?.port ?? 0}/`);
    await client.hello(secondToken ?? "");

    const relisted = await client.call("message.list", { conversationId });
    const restored = relisted.result as MessageListResult;
    expect(restored.messages.map((message) => message.id)).toEqual(
      page.messages.map((message) => message.id),
    );
    expect(restored.messages[1]?.content).toBe("你好。");
    expect(restored.messages[3]?.content).toBe("完事。");

    // ---- 步骤 7：连接断开 + Scope 回收 → 进程退出判据成立 ----
    let recycled = 0;
    app.scopeRegistry.onAllRecycled(() => {
      recycled += 1;
    });

    // 再跑一轮，让这个进程手里真的有一个 Scope 要回收
    client.request("conversation.send", { conversationId, input: { content: "第二句" } });
    const secondAccepted = await client.queue.next();
    expect(isSuccess(secondAccepted)).toBe(true);
    // 受理即借了 Scope（这一轮跑到结算才还）
    expect(app.scopeRegistry.size()).toBe(1);
    await collectRun();

    // 连接还在：即便 Scope 空闲到点被回收，也不该判「该退出了」
    await app.checkExit();
    expect(exits.length).toBe(1);

    // 连接断开之后：没有连接、没有在跑的轮次、Scope 全部回收 → 退出
    await client.close();
    client = null;
    await waitFor(() => recycled > 0);
    expect(app.scopeRegistry.size()).toBe(0);
    await waitFor(() => exits.length > 1);
    expect(exits[exits.length - 1]).toEqual({ reason: "idle", connections: 0, runs: 0, scopes: 0 });
    expect(app.running).toBe(false);
    app = null;
  }, 30000);
});
