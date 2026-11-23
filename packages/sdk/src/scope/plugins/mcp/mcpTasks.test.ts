import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { CallToolResult, Task } from "@modelcontextprotocol/sdk/types.js";
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
 * MCP 的任务（Tasks）：推状态 + 拉结果。
 *
 * 不起真服务器进程：用 SDK 自带的内存传输把「我们的 client」与「一台假服务器」接起来，
 * 服务器那一侧用 SDK 自己的 `registerToolTask` 注册任务工具、用它的内存任务库推进状态。
 * 这样走到的是真形状（`tools/call` 带不带任务参数、`tasks/result` 的载荷、状态通知的时序），
 * 而不是照着我们自己的假设造出来的替身。
 */

const SERVER = "fake";
const SERVER_CONFIG: McpServerDefinition = { id: SERVER, transport: "stdio", command: "fake-mcp" };
const SESSION_ID = "session-1";

type TestTool = { function: any; callback: (args: any, ctx?: any) => Promise<any> };
const asTestTool = (tool: unknown): TestTool => tool as TestTool;

/** 假服务器：普通工具一条，任务工具一条（档位由用例给） */
function makeServer(options: {
  taskSupport?: "optional" | "required";
  /** 任务建出来后服务器自己把它推到哪一格；不给就让它一直挂着 */
  outcome?: "completed" | "cancelled";
}) {
  const store = new InMemoryTaskStore();
  const server = new McpServer(
    { name: "fake-mcp", version: "0.0.0" },
    {
      // 服务器也要声明自己支持把 tools/call 当任务跑（客户端按这一格判断给不给任务参数）
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
      taskStore: store,
    },
  );

  // 没有任务这一档的工具（规范里的缺省 `forbidden`）
  server.registerTool("plain", { description: "answers right away" }, async () => ({
    content: [{ type: "text", text: "plain answer" }],
  }));

  if (options.taskSupport !== undefined) {
    server.experimental.tasks.registerToolTask(
      "report",
      { description: "a long job", execution: { taskSupport: options.taskSupport } },
      {
        createTask: async (extra) => {
          const task = await extra.taskStore.createTask({ ttl: 60_000, pollInterval: 5 });
          // 中间态与终态都由服务器这一侧推进（走的是会发通知的那个口）：用例据此分辨
          // 「哪些状态投了、哪些没投」
          void (async () => {
            await extra.taskStore.updateTaskStatus(task.taskId, "working");
            if (options.outcome === "completed") {
              await extra.taskStore.storeTaskResult(task.taskId, "completed", {
                content: [{ type: "text", text: "report body" }],
              });
            }
            if (options.outcome === "cancelled") {
              await extra.taskStore.updateTaskStatus(
                task.taskId,
                "cancelled",
                "the server gave up",
              );
            }
          })();
          return { task };
        },
        getTask: async (extra) => {
          const task: Task | null = await extra.taskStore.getTask(extra.taskId);
          if (task === null) throw new Error("task is gone");
          return task;
        },
        getTaskResult: async (extra) =>
          (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
      },
    );
  }

  return { server, store };
}

/** 投递口收到的每一条：这是「那段会话的 inbox」在用例里的样子 */
interface DeliveredNotice {
  sessionId: string;
  notice: McpTaskNotice;
}

interface Harness {
  manager: McpConnectionManager;
  delivered: DeliveredNotice[];
  /** 工具运行上下文：调用方是这一个 Agent（`sessionOf` 认它） */
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
  /** 发起调用的是不是一个属于某段会话的 Agent */
  inSession?: boolean;
}): Promise<Harness> {
  const { server, store } = makeServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

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

  const manager = new McpConnectionManager(() => clientTransport, undefined, undefined, port);
  closers.push(async () => {
    await manager.disconnectAll();
    await server.close();
    store.cleanup();
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

/** 等一件事发生：状态是服务器那一侧异步推过来的，用例只在有限步内等它 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("call_mcp_tool 的任务参数", () => {
  it("required 档自动带上任务参数：回给模型的话里有任务 id 与取结果的工具名", async () => {
    const h = await start({ taskSupport: "required" });

    // 调用方一个字都没说「当成任务」—— 这一档必须自己带上
    const answer = await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx);

    const parsed = JSON.parse(answer as string);
    expect(parsed.task).toBe(true);
    expect(typeof parsed.taskId).toBe("string");
    expect(parsed.taskId.length).toBeGreaterThan(0);
    expect(parsed.hint).toContain(GET_MCP_TASK_RESULT_TOOL);
    expect(parsed.hint).toContain(CANCEL_MCP_TASK_TOOL);
    expect(parsed.hint).toContain(parsed.taskId);
    expect(parsed.hint).toContain(SERVER);
  });

  it("optional 档按入参：给了任务参数就是句柄，没给就是当场的结果", async () => {
    const withTask = await start({ taskSupport: "optional", outcome: "completed" });
    const handed = await withTask.call.callback(
      { server: SERVER, tool: "report", arguments: {}, task: true },
      withTask.ctx,
    );
    expect(JSON.parse(handed as string).taskId).toBeTypeOf("string");

    const withoutTask = await start({ taskSupport: "optional", outcome: "completed" });
    const answer = await withoutTask.call.callback(
      { server: SERVER, tool: "report", arguments: {} },
      withoutTask.ctx,
    );
    expect(answer).toBe("report body");
  });

  it("forbidden 档忽略任务参数：照旧同步调，拿回的是结果", async () => {
    const h = await start({ taskSupport: "required" });

    const answer = await h.call.callback(
      { server: SERVER, tool: "plain", arguments: {}, task: true },
      h.ctx,
    );

    expect(answer).toBe("plain answer");
    // 没记下任何任务：这条调用没有句柄
    expect(h.delivered).toEqual([]);
  });
});

describe("任务状态通知", () => {
  it("终态投进发起那次调用的那段会话，中间态不投", async () => {
    const h = await start({ taskSupport: "required", outcome: "completed" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    await waitFor(() => h.delivered.length > 0, "the terminal status to be delivered");
    // 服务器先推 working 再推 completed：中间态那一条不该进来
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.sessionId).toBe(SESSION_ID);
    expect(h.delivered[0]!.notice).toMatchObject({
      server: SERVER,
      taskId: handed.taskId,
      status: "completed",
    });
  });

  it("取消也是一种终态：那一条同样投过来", async () => {
    const h = await start({ taskSupport: "required", outcome: "cancelled" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    await waitFor(() => h.delivered.length > 0, "the cancelled status to be delivered");
    expect(h.delivered[0]!.notice).toMatchObject({
      taskId: handed.taskId,
      status: "cancelled",
      statusMessage: "the server gave up",
    });
  });

  it("一直没到终态就一条都不投", async () => {
    const h = await start({ taskSupport: "required" });

    await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(h.delivered).toEqual([]);
  });

  it("发起方不属于任何一段会话时，状态到了也没有人可投", async () => {
    const h = await start({ taskSupport: "required", outcome: "completed", inSession: false });

    await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(h.delivered).toEqual([]);
  });
});

describe("两条任务工具", () => {
  it("拿结果：按任务 id 去 tasks/result 取回原样结果", async () => {
    const h = await start({ taskSupport: "required", outcome: "completed" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    const answer = await h.getResult.callback({ server: SERVER, task_id: handed.taskId }, h.ctx);
    expect(answer).toBe("report body");
  });

  it("取消：任务到 cancelled", async () => {
    const h = await start({ taskSupport: "required" });

    const handed = JSON.parse(
      (await h.call.callback({ server: SERVER, tool: "report", arguments: {} }, h.ctx)) as string,
    );

    const answer = JSON.parse(
      (await h.cancel.callback({ server: SERVER, task_id: handed.taskId }, h.ctx)) as string,
    );
    expect(answer.taskId).toBe(handed.taskId);
    expect(answer.status).toBe("cancelled");
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
