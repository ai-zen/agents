/**
 * 宿主级验收：`async_exec` 的结果回来时那段会话已经没了，那一行「丢掉并记日志」真的落在宿主的
 * 日志文件里。
 *
 * 为什么要这一条：sdk 那两把后台工具（`async_exec` / `async_timeout`）投递失败时写的是
 * `ToolEnv.log` 这一格可选注入位，缺省是库的沉默实现。宿主此前从来没传过它 —— sdk 侧那条用例
 * 拿一份录日志的替身，照样是绿的；而生产里那一行一个字都不会出现。判据必须是「日志文件里真有
 * 这一句」，不是「参数传下去了」。
 *
 * 这条路径只有真宿主造得出来：能力容器由 `HostApp` 的装配根造（日志口在那一处接上），执行体手上
 * 的工具是那个容器装出来的，日志落到 `<数据根>/logs/host.log` 这一份文件里。文件路径本身就是
 * 断言的一部分：那一份只有装配根造的 `FileLogger` 在写，所以「这一行出现在这儿」同时说明工具拿到
 * 的正是装配根那一个对象，不是另造的第二份。
 *
 * 模型不出网：本地起一个 OpenAI 兼容的端点回一句话，会话因此真的醒着、真的跑过一趟。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { Message, ToolCallContext } from "@ai-zen/agents-core";
import type { Agent, Tool } from "@ai-zen/agents-core";
import { ASYNC_EXEC_TOOL } from "@ai-zen/agents-sdk";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { HostApp } from "./app.js";
import { openDatabase } from "./infra/db.js";
import { hostPaths } from "./infra/paths.js";
import { workspaceTable } from "./modules/workspace/table.js";

/** 本地端点回的这句话：会话要真的跑过一趟，执行体才算装配完了 */
const REPLY = "收到。";

/** 后台命令的正文：判据不看它，只要求这条命令真的起得来、立刻结束 */
const COMMAND = "echo background-result";

/** tRPC over WebSocket 的一帧。协议只有这么几格，`@trpc/client` 不在依赖里 */
interface Envelope {
  readonly id: number | null;
  readonly result?: { readonly type?: string; readonly data?: unknown };
  readonly error?: { readonly message?: string };
}

/** 只做 mutation 的连接：这条用例每一步都是「调一次、拿一次答复」 */
class HostClient {
  private id = 0;
  private readonly waiting = new Map<number, (message: Envelope) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Envelope;
      if (message.id === null) return;
      this.waiting.get(message.id)?.(message);
    });
  }

  static connect(port: number, token: string): Promise<HostClient> {
    // 带 `connectionParams=1` 时服务端才等握手帧再建上下文：凭证只在那一帧上
    const socket = new WebSocket(`ws://127.0.0.1:${port}?connectionParams=1`);
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: null,
            jsonrpc: "2.0",
            method: "connectionParams",
            data: { token },
          }),
        );
        resolve(new HostClient(socket));
      });
    });
  }

  mutation<T>(path: string, input: unknown): Promise<T> {
    this.id += 1;
    const id = this.id;
    const answered = new Promise<Envelope>((resolve) => this.waiting.set(id, resolve));
    this.socket.send(
      JSON.stringify({ id, jsonrpc: "2.0", method: "mutation", params: { path, input } }),
    );

    return answered.then((message) => {
      this.waiting.delete(id);
      if (message.error !== undefined) throw new Error(message.error.message ?? "调用被拒");
      return message.result?.data as T;
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** 消息正文可能是多模态段数组，这条用例只等端点回的纯文本 */
function textOf(message: AgentNS.Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  return content.map((section) => (section.type === "text" ? section.text : "")).join("");
}

/** 执行体手上那一个工具；不在就是装配错了，当场说清是哪一个 */
function toolOf(agent: Agent, name: string): Tool {
  const tool = agent.tools.find((item) => item.function.name === name);
  if (tool === undefined) throw new Error(`执行体手上没有 "${name}" 这个工具`);
  return tool;
}

/**
 * 调一次工具：`ctx` 与 core 在模型发起工具调用时造的是同一个形状，`ctx.agent` 就是那个执行体。
 *
 * 注意它是**同步开到 `spawn` 的那一步**的（`AsyncExecTool.call` 在起进程之前没有 await），
 * 这是这条用例能在同一个 tick 里抢先杀掉会话的前提。
 */
async function callTool(tool: Tool, agent: Agent, args: Record<string, unknown>): Promise<any> {
  const toolCall: AgentNS.ToolCall = {
    id: `call-${randomUUID()}`,
    type: "function",
    function: { name: tool.function.name, arguments: JSON.stringify(args) },
  };
  const ctx = new ToolCallContext({
    agent,
    tool_call: toolCall,
    tool,
    resultMessage: Message.Tool(toolCall),
  });
  return JSON.parse(String(await tool.exec(ctx)));
}

describe("后台任务的结果投不回那段会话时，宿主日志里有那一行", () => {
  const workspaceId = randomUUID();
  let dataRoot: string;
  let previousHome: string | undefined;
  let llm: FakeLlm;
  let app: HostApp;
  let client: HostClient;

  /** 宿主日志此刻的内容；文件还没建出来时算空的（日志流是懒开的） */
  const logText = (): string => {
    try {
      return readFileSync(join(hostPaths(dataRoot).logs, "host.log"), "utf8");
    } catch {
      return "";
    }
  };

  /** 那一段执行体（宿主装配出来的，不是替身） */
  const agentOf = (sessionId: string): Agent => {
    const agent = app.runtime.get(sessionId);
    if (agent === undefined) throw new Error(`会话 "${sessionId}" 没有执行体`);
    return agent;
  };

  /** 等到这次探查看得见的东西出现（不固定 sleep，超时就抛） */
  const until = (probe: () => Promise<void> | void, timeout = 20_000): Promise<void> =>
    vi.waitFor(probe, { timeout, interval: 20 });

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-async-log-"));
    llm = await startFakeLlm({ reply: REPLY });

    writeFileSync(
      join(dataRoot, "config.json"),
      JSON.stringify(
        {
          endpoints: [
            { id: "local", name: "Local", baseUrl: llm.baseUrl, apiKey: "local-test-key" },
          ],
          models: [
            {
              id: "local-model",
              name: "Local",
              endpointId: "local",
              modelName: "local-model",
              tokenThresholds: { handoff: 250_000, guard: 375_000 },
              custom: true,
            },
          ],
          defaultModel: "local-model",
          language: "zh",
        },
        null,
        2,
      ),
    );

    mkdirSync(join(dataRoot, "agents"), { recursive: true });
    writeFileSync(
      join(dataRoot, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "Default Assistant",
          modelId: "local-model",
          messages: [Message.System("You are a test assistant.")],
          permissions: {
            tools: { allow: ["*"] },
            skills: { allow: ["*"] },
            mcps: { allow: ["*"] },
            subagents: { allow: ["*"] },
          },
          custom: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // 项目行直接写进表：这条用例不看项目怎么建，只要一段会话有地方干活
    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    const cwd = join(dataRoot, workspaceId);
    mkdirSync(cwd, { recursive: true });
    workspaceTable(db).put({ id: workspaceId, name: "用例项目", cwd, createdAt: Date.now() });
    db.close();

    process.env.AI_ZEN_DIR = dataRoot;
    // 主目录那几层也指到临时目录：否则会去读开发机的 `~/.agents`，结果跟着机器变
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");

    app = await HostApp.open({ port: 0, exit: () => undefined });
    await app.start();
    const token = readFileSync(join(dataRoot, "run", "token"), "utf8").trim();
    client = await HostClient.connect(app.address.port, token);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.stop();
    await llm?.close();
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("会话被杀之后结果才回来：那一行落进宿主日志文件", async () => {
    const sent = await client.mutation<{ sessionId: string }>("agent.send", {
      workspaceId,
      agentId: "default",
      content: "先在这儿说一句话。",
      messageId: randomUUID(),
    });
    const sessionId = sent.sessionId;

    // 等到模型真的答过一句：那一刻执行体已经装好、跑过一趟、回到闲
    await until(() => {
      expect(agentOf(sessionId).messages.some((message) => textOf(message) === REPLY)).toBe(true);
    });

    const agent = agentOf(sessionId);
    const logBefore = logText();

    // 起一条会立刻结束的命令。`callTool` 不 await：起进程是同步走到的那一步，结果要等进程结束
    // 之后才投递
    const started = callTool(toolOf(agent, ASYNC_EXEC_TOOL), agent, { command: COMMAND });
    // 同一个 tick 里杀掉这段会话，走的是客户端那条 `agent.kill` 最后调的那一句
    // （`deps.runtime.kill`）。绕开 ws 那一趟是有意的：这条命令立刻就结束，往返一次就可能让结果
    // 先投成功，那验到的就是「投递成功」而不是「投不回去」
    app.runtime.kill(sessionId);
    // 队列这一刻已经关了 —— 此后每一次投递都被它挡回来
    expect(agent.isInputPaused).toBe(true);

    // 工具调用本身照常给出回执：丢的是将来才回来的那份结果
    expect((await started).started).toBe(true);

    // 那一行真的写出来了，而且是在装配根那一份日志文件里
    await until(() => {
      expect(logText()).toContain(
        `[${ASYNC_EXEC_TOOL}] result could not be delivered to agent ${agent.id}; dropped`,
      );
    });

    const line = logText()
      .split("\n")
      .find((text) => text.includes("result could not be delivered"));
    expect(line).toBeDefined();
    expect(line).toContain(`[${ASYNC_EXEC_TOOL}]`);
    // 记这一句走的是 warn 那一档（丢弃不是正常收场）
    expect(line).toContain("WARN");
    // 这一句是这一趟新长出来的：它在动手之前不在日志里
    expect(logBefore).not.toContain("result could not be delivered");
  }, 60_000);
});
