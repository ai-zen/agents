import { describe, it, expect, vi, afterEach } from "vitest";
import { Agent, AgentNS, Message, ToolCallContext } from "@ai-zen/agents-core";
import { AsyncTimeoutTool } from "./AsyncTimeoutTool.js";
import { makeEnv } from "../../../test-support/test-helpers.js";
import { until, stopAgent } from "../../../test-support/agent-round.js";

/** 收件人：一个真实执行体；`onInnerLoopStart` 拒掉每一次请求（本文件不跑真实请求） */
function makeAgent(): Agent {
  const agent = new Agent({ client: {} as never, model: "test-model", tools: [] });
  agent.use({ onInnerLoopStart: () => "denied by test" });
  return agent;
}

function callContext(agent: Agent): ToolCallContext {
  return new ToolCallContext({
    agent,
    tool_call: {
      id: "c1",
      type: "function",
      function: { name: "async_timeout", arguments: JSON.stringify({}) },
    },
    resultMessage: Message.Tool({
      id: "r1",
      type: "function",
      function: { name: "async_timeout" },
    }),
  });
}

/** 投回来的那条消息正文：core 在最前面加了一行来源注释，去掉它才是正文 */
function deliveredBody(message: AgentNS.Message): Record<string, unknown> {
  const text = message.content as string;
  const cut = text.indexOf("\n\n");
  return JSON.parse(cut === -1 ? text : text.slice(cut + 2));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AsyncTimeoutTool", () => {
  it("工具名、描述与参数", () => {
    const tool = new AsyncTimeoutTool(makeEnv());
    expect(tool.function.name).toBe("async_timeout");
    expect(tool.function.description).toContain("return immediately");
    expect(tool.function.description).toContain("do not poll");
    // 不设上限：参数说明里不能写出一个上限值
    expect(tool.function.description).toContain("no upper limit");
  });

  it("立刻返回，到点再投一条回来", async () => {
    const tool = new AsyncTimeoutTool(makeEnv());
    const agent = makeAgent();

    const start = Date.now();
    const raw = await tool.call({ ms: 100 }, callContext(agent));
    expect(Date.now() - start).toBeLessThan(100);
    const started = JSON.parse(raw as string);
    expect(started.started).toBe(true);
    expect(started.ms).toBe(100);
    expect(started.taskId).toEqual(expect.any(String));

    // 到点之前什么都没投回来
    expect(agent.inboxPending).toHaveLength(0);
    await until(() => agent.inboxPending.length === 1, 5000);

    void agent.start();
    await until(() => agent.messages.length === 1, 5000);
    const message = agent.messages[0]!;
    expect(message.role).toBe(AgentNS.Role.User);
    expect(message.source).toEqual({ kind: "system", label: "async_timeout" });

    const body = deliveredBody(message);
    expect(body.task).toBe("async_timeout");
    expect(body.taskId).toBe(started.taskId);
    expect(body.ms).toBe(100);
    expect(body.message).toContain("Time is up");
    expect(body.message).toContain(started.taskId as string);
    expect(body.message).toContain("100ms");

    await stopAgent(agent);
  });

  it("ms 非法时被拒：0、负数、非数、没给", async () => {
    const tool = new AsyncTimeoutTool(makeEnv());
    const agent = makeAgent();

    for (const input of [{ ms: 0 }, { ms: -1 }, { ms: Number.NaN }, { ms: "100" }, {}]) {
      await expect(tool.call(input as never, callContext(agent))).rejects.toThrow(/ms/);
    }
    // 一个都没排上：队列里没有待办
    expect(agent.inboxPending).toHaveLength(0);
  });

  it("会话被杀时，名下还没到点的定时器一起清掉，不再投递", async () => {
    vi.useFakeTimers();
    const tool = new AsyncTimeoutTool(makeEnv());
    const agent = makeAgent();

    await tool.call({ ms: 60_000 }, callContext(agent));
    expect(vi.getTimerCount()).toBe(1);

    agent.kill();
    expect(vi.getTimerCount()).toBe(0);

    // 时间推过去也不会有人被叫起来：那个定时器已经没了
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.inboxPending).toHaveLength(0);
  });

  it("会话关门（stop）时同样清掉定时器", async () => {
    vi.useFakeTimers();
    const tool = new AsyncTimeoutTool(makeEnv());
    const agent = makeAgent();

    await tool.call({ ms: 60_000 }, callContext(agent));
    expect(vi.getTimerCount()).toBe(1);

    // stop 会等存量跑完才死，这里没有存量，所以当场就走完
    agent.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超过 setTimeout 上限的等待分段排，到点才投", async () => {
    vi.useFakeTimers();
    const tool = new AsyncTimeoutTool(makeEnv());
    const agent = makeAgent();

    await tool.call({ ms: 2_147_483_647 + 5000 }, callContext(agent));
    expect(vi.getTimerCount()).toBe(1);

    // 第一段走完只排下一段，还不算到点
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(vi.getTimerCount()).toBe(1);
    expect(agent.inboxPending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(agent.inboxPending).toHaveLength(1);

    agent.kill();
  });

  it("两个执行体各数各的定时器：一段被收掉不影响另一段", async () => {
    vi.useFakeTimers();
    const tool = new AsyncTimeoutTool(makeEnv());
    const first = makeAgent();
    const second = makeAgent();

    await tool.call({ ms: 60_000 }, callContext(first));
    await tool.call({ ms: 60_000 }, callContext(second));
    expect(vi.getTimerCount()).toBe(2);

    first.kill();
    expect(vi.getTimerCount()).toBe(1);

    second.kill();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("没有执行体可投（工具不是被 agent 调用的）时直接报错", async () => {
    const tool = new AsyncTimeoutTool(makeEnv());
    await expect(tool.call({ ms: 100 })).rejects.toThrow("must be called by an agent");
  });
});
