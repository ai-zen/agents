import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Agent, AgentNS, Message, ToolCallContext } from "@ai-zen/agents-core";
import { AsyncExecTool } from "./AsyncExecTool.js";
import { makeEnv } from "../../../test-support/test-helpers.js";
import { until, stopAgent } from "../../../test-support/agent-round.js";
import { cleanupDumpDir } from "../../../test-support/tool-output.js";
import { recordingLog, messagesAt } from "../../../test-support/log.js";
import type { AppConfig, ToolEnv } from "../../../types/index.js";

/** Windows 上没有 `sleep`，用 ping 顶一条长时间运行的无害命令 */
const LONG_COMMAND = process.platform === "win32" ? "ping -n 20 127.0.0.1" : "sleep 20";

/**
 * 收件人：一个真实 Agent。
 *
 * `onInnerLoopStart` 拒掉每一次请求：本文件关心的是「结果有没有投回来」，不需要真的发请求，
 * 而这一句拒绝让写进 messages 之后不再往下走（投进来的 InboxEntry 照样落成消息）。
 */
function makeAgent(): Agent {
  const agent = new Agent({ client: {} as never, model: "test-model", tools: [] });
  agent.use({ onInnerLoopStart: () => "denied by test" });
  return agent;
}

function callContext(agent: Agent, name: string, args: Record<string, unknown>): ToolCallContext {
  return new ToolCallContext({
    agent,
    tool_call: { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } },
    resultMessage: Message.Tool({ id: "r1", type: "function", function: { name } }),
  });
}

/** 投回来的那条消息正文：core 在最前面加了一行来源注释，去掉它才是正文 */
function deliveredBody(message: AgentNS.Message): string {
  const text = message.content as string;
  const cut = text.indexOf("\n\n");
  return cut === -1 ? text : text.slice(cut + 2);
}

/** 等下一条结果落成消息，并把它交出来 */
async function waitForDelivered(agent: Agent, count = 1): Promise<AgentNS.Message[]> {
  void agent.start();
  await until(() => agent.messages.length >= count, 10_000);
  return agent.messages;
}

describe("AsyncExecTool", () => {
  it("工具名、描述与参数", () => {
    const tool = new AsyncExecTool(makeEnv());
    expect(tool.function.name).toBe("async_exec");
    expect(tool.function.description).toContain("return immediately");
    expect(tool.function.description).toContain("do not poll");
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("cwd");
    expect(params.properties).toHaveProperty("timeout");
    // 严格模式下「可选」是「必填但可为 null」：三个都在 required 里，cwd / timeout 的类型带上 null
    expect(params.required).toEqual(["command", "cwd", "timeout"]);
    expect((params.properties as any).cwd.type).toEqual(["string", "null"]);
    expect((params.properties as any).timeout.type).toEqual(["number", "null"]);
  });

  it("立刻返回：调用点不等人，只给一句话与一个任务 id", async () => {
    const tool = new AsyncExecTool(makeEnv());
    const agent = makeAgent();

    const start = Date.now();
    const raw = await tool.call({ command: LONG_COMMAND }, callContext(agent, "async_exec", {}));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    const parsed = JSON.parse(raw as string);
    expect(parsed.started).toBe(true);
    expect(parsed.taskId).toEqual(expect.any(String));
    expect(parsed.note).toContain("do not poll");

    // 收掉这条后台命令，别把它留在进程里
    agent.kill();
  });

  it("命令结束后结果进了那段会话的队列，并成了一条系统来源的 user 消息", async () => {
    const tool = new AsyncExecTool(makeEnv());
    const agent = makeAgent();

    await tool.call({ command: "echo hello" }, callContext(agent, "async_exec", {}));

    // 先确认它确实是从队列进来的（不是工具直接写消息）
    await until(() => agent.inboxPending.length === 1, 10_000);
    // 高优先级：结果要在**下一个工具边界**就被看见。取低的话，等它的那一方只要还在调工具
    //（`sleep` 轮询是最常见的那种），那一批就永远不结束，结果永远递不进去
    expect(agent.inboxPending[0]?.priority).toBe("high");
    const messages = await waitForDelivered(agent);

    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.role).toBe(AgentNS.Role.User);
    expect(message.source).toEqual({ kind: "system", label: "async_exec" });

    const body = JSON.parse(deliveredBody(message));
    expect(body.task).toBe("async_exec");
    expect(body.command).toBe("echo hello");
    expect(body.stdout.trim()).toBe("hello");
    expect(body.exitCode).toBe(0);
    expect(body.message).toContain("finished with exit code 0");

    await stopAgent(agent);
  });

  it("超时被杀时，推回来的那条说清是超时", async () => {
    const tool = new AsyncExecTool(makeEnv());
    const agent = makeAgent();

    await tool.call({ command: LONG_COMMAND, timeout: 200 }, callContext(agent, "async_exec", {}));
    const messages = await waitForDelivered(agent);

    const body = JSON.parse(deliveredBody(messages[0]!));
    expect(body.killed).toBe(true);
    expect(body.terminated).toBe("timeout");
    expect(body.message).toContain("killed by its 200ms timeout");

    await stopAgent(agent);
  });

  it("输出超限时走落盘加头尾预览那一条路", async () => {
    const tool = new AsyncExecTool(makeEnv(process.cwd(), { maxToolOutput: 1000 } as AppConfig));
    const agent = makeAgent();

    await tool.call(
      { command: `node -e "process.stdout.write('a'.repeat(3000))"` },
      callContext(agent, "async_exec", {}),
    );
    const messages = await waitForDelivered(agent);

    const body = JSON.parse(deliveredBody(messages[0]!));
    expect(body.outputTooLarge).toBe(true);
    expect(body.warning).toContain("exceeds the limit of 1000 characters");

    // 全文落盘，正文只给头尾预览与统计（与 exec 同一份实现）
    const stdoutPath = body.files["stdout.log"];
    expect(readFileSync(stdoutPath, "utf-8")).toHaveLength(3000);
    expect(body.stdout.chars).toBe(3000);
    expect(body.stdout.head).toBe("a".repeat(1000));
    expect(body.stdout.tail).toBe("a".repeat(1000));
    expect(body.stdout.omitted).toBe(1000);

    cleanupDumpDir(dirname(stdoutPath));
    await stopAgent(agent);
  });

  it.skipIf(process.platform === "win32")(
    "会话被杀时，它名下还在跑的后台命令按进程组一起收掉",
    async () => {
      const tool = new AsyncExecTool(makeEnv());
      const agent = makeAgent();

      const pidFile = join(tmpdir(), `async-exec-grandchild-${randomBytes(6).toString("hex")}.pid`);
      // sleep 是孙进程：只杀 shell 会把它留成孤儿
      const command = `sh -c 'sleep 30 & echo $! > ${pidFile}; wait'`;

      try {
        await tool.call({ command }, callContext(agent, "async_exec", {}));
        await until(() => existsSync(pidFile), 10_000);
        const grandchildPid = Number(readFileSync(pidFile, "utf-8").trim());
        expect(grandchildPid).toBeGreaterThan(0);

        agent.kill();
        // 给内核一点时间完成回收
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      } finally {
        try {
          unlinkSync(pidFile);
        } catch {
          // 没写出来就不用删
        }
      }
    },
  );

  it("那段会话已经关门时，结果被丢掉并记一行日志", async () => {
    const { logger, records } = recordingLog();
    const env: ToolEnv = { cwd: process.cwd(), config: {} as AppConfig, log: logger };
    const tool = new AsyncExecTool(env);
    const agent = makeAgent();

    await tool.call(
      { command: `node -e "setTimeout(() => {}, 300)"` },
      callContext(agent, "async_exec", {}),
    );
    // 命令还在跑的时候把会话关掉：结果回来时已经没有收件人
    await stopAgent(agent);

    await until(() => messagesAt(records, "warn").length === 1, 10_000);
    expect(messagesAt(records, "warn")[0]).toContain("dropped");
    expect(agent.messages).toHaveLength(0);
  });

  it("没有Agent可投（工具不是被 agent 调用的）时直接报错", async () => {
    const tool = new AsyncExecTool(makeEnv());
    await expect(tool.call({ command: "echo hello" })).rejects.toThrow(
      "must be called by an agent",
    );
  });

  it("timeout 给非正数时被拒", async () => {
    const tool = new AsyncExecTool(makeEnv());
    const agent = makeAgent();
    await expect(
      tool.call({ command: "echo hi", timeout: 0 }, callContext(agent, "async_exec", {})),
    ).rejects.toThrow(/timeout/);
  });

  it("timeout 是 null（严格模式下「不传」的形状）时不报错，当没给", async () => {
    const tool = new AsyncExecTool(makeEnv());
    const agent = makeAgent();
    // 模型按 schema 传 null 时不能落进「非正数」那条判空
    const result = await tool.call(
      { command: "echo hi", timeout: null as unknown as number },
      callContext(agent, "async_exec", {}),
    );
    const body = JSON.parse(result as string);
    expect(body.started).toBe(true);
    // null 当没给：结果里不出现 timeout 这一格
    expect(body.timeout).toBeUndefined();
  });
});
