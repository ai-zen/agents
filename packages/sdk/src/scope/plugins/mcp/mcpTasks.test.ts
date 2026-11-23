import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { McpConnectionManager } from "./McpConnectionManager.js";
import {
  createCallMcpTool,
  createCancelMcpTaskTool,
  createGetMcpTaskResultTool,
} from "./mcpTools.js";
import { CANCEL_MCP_TASK_TOOL, GET_MCP_TASK_RESULT_TOOL } from "./mcpTaskNotice.js";
import type { McpTaskNotice, McpTaskNoticePort } from "./mcpTaskNotice.js";
import type { AppConfig, McpServerDefinition, ToolEnv } from "../../../types/index.js";

/**
 * MCP 的任务（Tasks），按 2026-07-28 那一版扩展（`io.modelcontextprotocol/tasks`）的语义。
 *
 * 与 2025 那一版最大的不同：用不用任务由**服务器**在应答里决定，客户端只表达一个偏好。所以这里
 * 的假服务器是手搓的 —— 它照 1.x 服务器的行为在 `tools/call` 上回一个句柄，而我们这一侧走的是
 * `@modelcontextprotocol/ext-tasks` 的 session，验的是「句柄 → 拉结果 / 取消 / 终态通知」这条链。
 */

const SERVER = "fake";
const SERVER_CONFIG: McpServerDefinition = { id: SERVER, transport: "stdio", command: "fake-mcp" };
const SESSION_ID = "session-1";

type TestTool = { function: any; callback: (args: any, ctx?: any) => Promise<any> };
const asTestTool = (tool: unknown): TestTool => tool as TestTool;

interface FakeTask {
  status: "working" | "completed" | "cancelled";
  result?: unknown;
}

/** `tasks/get` 与 `tasks/cancel` 都回这个形状：任务此刻那一格 */
function taskViewOf(taskId: string, entry: FakeTask): Record<string, unknown> {
  return {
    taskId,
    status: entry.status,
    ttl: 60_000,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    pollInterval: 5,
    ...(entry.status === "cancelled" ? { statusMessage: "the server gave up" } : {}),
  };
}

/**
 * 手搓一台「会交句柄」的服务器。
 *
 * 为什么不用 SDK 自己的 `Server`：v2 的服务端会校验 `tools/call` 的结果形状，`{ task }` 这种
 * 属于另一个结果族，出门前就被拒了。真实世界里会交句柄的是钉在 2025-11-25 上的服务器（别的语言
 * 的 SDK、或者 v1 的 TS 实现），这里照它们的行为说话。
 */
function fakeServer(
  transport: { onmessage?: (message: any) => void; send: (message: any) => Promise<void> },
  options: { taskSupport?: "optional" | "required"; outcome?: "completed" | "cancelled" },
) {
  const tasks = new Map<string, FakeTask>();
  let seq = 0;

  const reply = (id: unknown, result: unknown) => transport.send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) =>
    transport.send({ jsonrpc: "2.0", id, error: { code, message } });

  transport.onmessage = (message: any) => {
    const { id, method, params } = message;
    if (method === undefined) return; // 通知，不回

    if (method === "initialize") {
      return reply(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, tasks: { cancel: {}, requests: { tools: { call: {} } } } },
        serverInfo: { name: "fake-mcp", version: "0.0.0" },
      });
    }

    if (method === "tools/list") {
      const tools: any[] = [
        { name: "plain", description: "answers right away", inputSchema: { type: "object" } },
      ];
      if (options.taskSupport !== undefined) {
        tools.push({
          name: "report",
          description: "a long job",
          inputSchema: { type: "object" },
          execution: { taskSupport: options.taskSupport },
        });
      }
      return reply(id, { tools });
    }

    if (method === "tools/call") {
      if (params?.name === "plain" || params?.task === undefined) {
        return reply(id, { content: [{ type: "text", text: "ran inline" }] });
      }

      const taskId = `task-${++seq}`;
      const entry: FakeTask = { status: "working" };
      tasks.set(taskId, entry);
      if (options.outcome === "completed") {
        // 服务器自己推进：调用方下一次问 `tasks/get` 时它已经跑完了
        setTimeout(() => {
          entry.status = "completed";
          entry.result = { content: [{ type: "text", text: "report body" }] };
        }, 5);
      }
      const now = new Date().toISOString();
      return reply(id, {
        task: {
          taskId,
          status: "working",
          ttl: 60_000,
          createdAt: now,
          lastUpdatedAt: now,
          pollInterval: 5,
        },
      });
    }

    if (method === "tasks/get") {
      const entry = tasks.get(params?.taskId);
      if (entry === undefined) return fail(id, -32602, "no such task");
      return reply(id, taskViewOf(params.taskId, entry));
    }

    if (method === "tasks/result") {
      const entry = tasks.get(params?.taskId);
      if (entry === undefined) return fail(id, -32602, "no such task");
      if (entry.result === undefined) return fail(id, -32602, "the task has no result");
      return reply(id, entry.result);
    }

    if (method === "tasks/cancel") {
      const entry = tasks.get(params?.taskId);
      if (entry === undefined) return fail(id, -32602, "no such task");
      entry.status = "cancelled";
      return reply(id, taskViewOf(params.taskId, entry));
    }

    return fail(id, -32601, `no such method: ${method}`);
  };
}

interface DeliveredNotice {
  sessionId: string;
  notice: McpTaskNotice;
}

interface Harness {
  manager: McpConnectionManager;
  delivered: DeliveredNotice[];
  ctx: { agent: unknown };
  call: TestTool;
  getResult: TestTool;
  cancel: TestTool;
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(options: {
  taskSupport?: "optional" | "required";
  outcome?: "completed" | "cancelled";
  inSession?: boolean;
}): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  fakeServer(serverTransport as any, options);

  const caller = { model: "test-model" };
  const sessions = new Map<unknown, string>(
    options.inSession === false ? [] : [[caller, SESSION_ID]],
  );
  const delivered: DeliveredNotice[] = [];
  const port: McpTaskNoticePort = {
    sessionOf: (agent) => sessions.get(agent),
    deliver: async (sessionId, notice) => {
      delivered.push({ sessionId, notice });
      return true;
    },
  };

  const manager = new McpConnectionManager(
    () => clientTransport as any,
    undefined,
    undefined,
    port,
  );
  closers.push(async () => {
    await manager.disconnectAll();
  });
  await manager.connect(SERVER, SERVER_CONFIG, { idleTimeoutMs: 0 });

  const env: ToolEnv = { cwd: "/tmp", config: {} as AppConfig, deps: {} };
  const ctx = { agent: caller };

  return {
    manager,
    delivered,
    ctx,
    call: asTestTool(createCallMcpTool(manager, env, [SERVER])),
    getResult: asTestTool(createGetMcpTaskResultTool(manager, env, [SERVER])),
    cancel: asTestTool(createCancelMcpTaskTool(manager, [SERVER])),
    close: async () => {
      await manager.disconnectAll();
    },
  };
}

/** 等一件事发生：终态是服务器那边推进的，用例只在有限步内等它 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("call_mcp_tool：任务分岔", () => {
  it("optional 档：服务器交了句柄，回给模型的是任务 id 与取结果的工具名", async () => {
    const h = await start({ taskSupport: "optional", outcome: "completed" });

    const parsed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    expect(parsed.task).toBe(true);
    expect(typeof parsed.taskId).toBe("string");
    expect(parsed.hint).toContain(GET_MCP_TASK_RESULT_TOOL);
    expect(parsed.hint).toContain(CANCEL_MCP_TASK_TOOL);
    expect(parsed.hint).toContain(parsed.taskId);
  });

  it("forbidden 档（没声明这一格）：照旧同步调，没有句柄", async () => {
    const h = await start({ taskSupport: "optional", outcome: "completed" });

    const answer = await h.call.callback({ server: SERVER, tool: "plain", arguments: {} }, h.ctx);

    expect(answer).toBe("ran inline");
    expect(h.delivered).toEqual([]);
  });
});

describe("任务终态通知", () => {
  it("跑完了投进发起那次调用所在会话，带服务器名与任务 id", async () => {
    const h = await start({ taskSupport: "required", outcome: "completed" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    await waitFor(() => h.delivered.length > 0, "the terminal notice");
    expect(h.delivered[0]!.sessionId).toBe(SESSION_ID);
    expect(h.delivered[0]!.notice).toMatchObject({
      server: SERVER,
      taskId: handed.taskId,
      status: "completed",
    });
  });

  it("发起方不属于任何会话时，终态到了也没有人可投", async () => {
    const h = await start({ taskSupport: "required", outcome: "completed", inSession: false });

    await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.delivered).toEqual([]);
  });
});

describe("两条任务工具", () => {
  it("拿结果：按任务 id 取回原样结果", async () => {
    const h = await start({ taskSupport: "required", outcome: "completed" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    const answer = await h.getResult.callback({ server: SERVER, task_id: handed.taskId }, h.ctx);
    expect(answer).toBe("report body");
  });

  it("取消：发到服务器，终态按 cancelled 投回来", async () => {
    const h = await start({ taskSupport: "required", outcome: "cancelled" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    const answer = JSON.parse(
      (await h.cancel.callback({ server: SERVER, task_id: handed.taskId }, h.ctx)) as string,
    );
    expect(answer.taskId).toBe(handed.taskId);

    await waitFor(() => h.delivered.length > 0, "the cancelled notice");
    // 服务器给的那句说明能不能过到通知上，取决于扩展在取消这条路上有没有带上任务视图；
    // 这里只钉住事实本身：谁的任务、到了哪一格
    expect(h.delivered[0]!.notice).toMatchObject({
      taskId: handed.taskId,
      status: "cancelled",
    });
  });

  it("没连上的服务器：两条工具都说先 load_mcp", async () => {
    const h = await start({ taskSupport: "required" });
    await h.close();

    expect(await h.getResult.callback({ server: SERVER, task_id: "x" }, h.ctx)).toContain(
      "load_mcp",
    );
    expect(await h.cancel.callback({ server: SERVER, task_id: "x" }, h.ctx)).toContain("load_mcp");
  });
});
