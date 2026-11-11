/**
 * `EventBridge` 的用例：SDK 事件怎么翻成协议事件。
 *
 * 这一组盯的是「服务端搬的是**哪一份**真相」与「什么时候搬」：原始片原样上线（增量由
 * 客户端自己折）、工具结果在定型那一刻推（不等轮末）、子 Agent 的事件绝不碰主阶段。
 * 反过来，凡是「摘出来的一份派生值」（正文增量、工具调用组装态、整条消息转述）都不该
 * 出现在线上 —— 那几条各有专门的一条用例盯着「一条都没有」。
 *
 * 全部用假 Agent 驱动（时序在测试里是可编程的），共用脚手架见 `SessionTestSupport.ts`。
 */

import { describe, expect, it } from "vitest";
import { SessionManager } from "./SessionManager.js";
import type { Message } from "@ai-zen/agents-protocol";
import {
  settled,
  FakeSubAgent,
  fireChunk,
  pick,
  chunk,
  fireToolCall,
  assembling,
  toolResult,
  fireToolCallEnd,
  create,
  agent,
  manager,
  events,
  useSessionKit,
} from "./SessionTestSupport.js";

useSessionKit();

describe("SessionManager：SDK 事件 → 协议事件", () => {
  it("六态按 SDK 时序推进：open → queued，正文 delta → streaming，parsed 收尾", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    expect((await manager.list("ws-1"))[0]!.phase).toEqual({ kind: "connecting" }); // send 当下就报出去了

    agent.fire("open");
    expect((await manager.list("ws-1"))[0]!.phase).toEqual({ kind: "queued" });

    fireChunk(agent, chunk({ content: "你" }));
    expect((await manager.list("ws-1"))[0]!.phase).toEqual({ kind: "streaming" });

    agent.fire("parsed", { message: { role: "assistant", content: "你好" } });
    // 不带工具调用：状态机不改阶段，由 finally 归零
    agent.fire("finally");
    await settled();
    expect((await manager.list("ws-1"))[0]!.phase).toBeNull();
    expect(pick("session-turn-end").at(-1)!.ok).toBe(true);
  });

  it("增量不上线：客户端自己折原始片（服务端只发 `chunk` 与阶段）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ reasoning_content: "想…" }));
    fireChunk(agent, chunk({ content: "答案" }));
    fireChunk(agent, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 42, total_tokens: 51 },
    });

    // 三片原样上线：客户端拿 core 的 `applyChunk` 折它们，就能得到正文 / 推理 / 用量
    const pieces = pick("chunk");
    expect(pieces).toHaveLength(3);
    expect(pieces.at(-1)!.chunk).toMatchObject({ usage: { completion_tokens: 42 } });
    // 没有任何「摘出来的一份增量」：那条事件已从协议里删掉
    expect(events.map((event) => event.event) as string[]).not.toContain("chunk-parsed");
  });

  it("本轮带工具调用：streamEnded 之后进 tool-waiting，并报出全部工具名", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ tool_calls: [{ index: 0, function: { name: "exec" } }] }));
    expect((await manager.list("ws-1"))[0]!.phase).toEqual({ kind: "tool-calling", tool: "exec" });

    agent.fire("parsed", {
      message: {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "exec" } },
          { id: "b", function: { name: "edit" } },
        ],
      },
    });
    expect((await manager.list("ws-1"))[0]!.phase).toMatchObject({
      kind: "tool-waiting",
      tools: ["exec", "edit"],
    });
  });

  it("工具跑完一个就从等待里消失（并行时不会一直念着已完成的那个）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    agent.fire("parsed", {
      message: {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "exec" } },
          { id: "b", function: { name: "edit" } },
        ],
      },
    });

    // SDK 在工具执行**前**就以 pending 追加结果消息，跑完翻成终态
    const done = toolResult("a", "exec", "已跑完");
    agent.messages.push(done);
    agent.messages.push(toolResult("b", "edit"));
    // 按真件形状 fire（`{ agent, toolCall, result }`）：这一带曾经发的是自造的 `{ id }`，
    // 载荷错了也没人发现，因为当时的处理函数不读它 —— 见 `fireToolCallEnd`
    fireToolCallEnd(agent, done);

    expect((await manager.list("ws-1"))[0]!.phase).toMatchObject({
      kind: "tool-waiting",
      tools: ["edit"],
    });
  });

  it("error 与 finally 都会到：session-turn-end 只发一次，且带上错误", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("error", Object.assign(new Error("超时"), { code: "timeout" }));
    agent.fire("finally");
    await settled();

    const ends = pick("session-turn-end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ ok: false, error: { code: "timeout", message: "超时" } });
    expect((await manager.list("ws-1"))[0]!.phase).toBeNull();
  });

  /**
   * core 原名的那几条里，客户端**今天用不到**的也要真的发出去。
   *
   * 这条盯的是「协议面写了的就得真发」：`open` / `parsed` / `finally` 在客户端没有任何
   * 处理函数，很容易在服务端被“嫌多余”而漏掉——而它们一旦不发，协议里那几条就成了谎话
   * （其余客户端拿它们做别的事时，永远收不到）。
   */
  it("core 原名的事件一条不少：open / chunk / parsed / finally（名字与载荷就是 core 那一份）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    const piece = chunk({ content: "你" });
    agent.fire("open");
    fireChunk(agent, piece);
    agent.fire("parsed", { message: { role: "assistant", content: "你好" } });
    agent.fire("finally");
    await settled();

    expect(pick("open")).toEqual([{ event: "open", sessionId, turnId: 1 }]);
    // `chunk` 带的是 core 给的那一片**原样**（厂商形状，协议不解释）
    expect(pick("chunk")).toEqual([{ event: "chunk", sessionId, turnId: 1, chunk: piece }]);
    expect(pick("parsed")).toEqual([{ event: "parsed", sessionId, turnId: 1 }]);
    expect(pick("finally")).toEqual([{ event: "finally", sessionId, turnId: 1 }]);
    // 这一轮没出错：`error` 一条都不该有（别把“没出错”也发成一条）
    expect(pick("error")).toHaveLength(0);
  });

  /**
   * 时机约束是协议的一部分（客户端按它们排事实）：`error` 先于 `finally`，
   * `finally` 先于 `session-turn-end`（后者要等落盘）。
   */
  it("时机顺序：error → finally → session-turn-end", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ content: "答" }));
    expect(pick("chunk")).toHaveLength(1);

    agent.fire("error", Object.assign(new Error("超时"), { code: "timeout" }));
    agent.fire("finally");
    await settled();

    const ends = pick("session-turn-end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ ok: false, error: { code: "timeout", message: "超时" } });
    expect((await manager.list("ws-1"))[0]!.phase).toBeNull();
  });

});
/**
 * 工具结果定型（`tool-call-end`）—— 客户端在流式期间把工具卡片补上的唯一出口。
 *
 * core 的 `message` 事件在这里只当一个**触发条件**（`role === "tool"` 且已定型）：消息本身
 * 不上线，因为这条事件已经把那条消息带上了；用户消息与占位 assistant 更是各有来源（前者
 * 客户端自己造、后者由轮末快照给）。曾经它们也各发一条 `message` 事件，而那条事件没有
 * 任何订阅方 —— 摘一份既有事实另立事件，就是给它立第二个定义。
 */
describe("SessionManager：工具结果定型（tool-call-end）", () => {
  it("执行前那条 pending 消息不转；定型那一刻才转，且推的就是那一条", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    const message = toolResult("call_1", "exec");
    agent.messages.push(message);
    // core `append`：工具**执行前**就追加，此刻 pending、正文空
    agent.fire("message", message);

    // 还没定型：这一刻不该出现 `tool-call-end`（用户该看到的是「在跑」）
    expect(pick("tool-call-end")).toHaveLength(0);

    message.content = "总用量 12";
    fireToolCallEnd(agent, message);

    const ends = pick("tool-call-end");
    expect(ends).toHaveLength(1);
    // 服务端只搬运，不重新包装：推的就是 core 手里那一条
    expect(ends[0]!.message).toBe(message);
    expect(ends[0]!.message).toMatchObject({ content: "总用量 12", status: "completed" });
    // 此刻这一轮还没收尾 —— 这正是这条事件存在的理由（快照要等 session-turn-end 之后）
    expect(pick("session-turn-end")).toHaveLength(0);
  });

  it("用户消息与占位 assistant：不转 `tool-call-end`，也不上线任何 `message` 事件", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("message", { id: "m-user", role: "user", content: "hi", status: "completed" });
    agent.fire("message", { id: "m-assistant", role: "assistant", content: "", status: "pending" });

    expect(pick("tool-call-end")).toHaveLength(0);
    expect(events.map((event) => event.event) as string[]).not.toContain("message");
  });

  it("并行：先跑完的先转，还没定型的那条一次都不转", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    // 真件的顺序：两个结果消息在**执行前**就都追加好了（`Promise.all` 的 map 里同步
    // append），所以「先完成的那条」往往排在**后面**，前面那条还是 pending、正文空
    const slow = toolResult("call_1", "exec");
    const fast = toolResult("call_2", "read_file");
    agent.messages.push(slow, fast);
    agent.fire("message", slow);
    agent.fire("message", fast);
    expect(pick("tool-call-end")).toHaveLength(0); // 两条都还在跑

    fast.content = "快结果";
    fireToolCallEnd(agent, fast, "completed");
    expect(pick("tool-call-end").map((event) => event.message.tool_call_id)).toEqual(["call_2"]);
    expect(pick("tool-call-end")[0]!.message.content).toBe("快结果");

    slow.content = "慢结果";
    fireToolCallEnd(agent, slow, "completed");
    expect(pick("tool-call-end").map((event) => event.message.tool_call_id)).toEqual([
      "call_2",
      "call_1",
    ]);
  });

  it("按当前轮编号转发：第二轮的工具结果带 turnId 2", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "第一轮");
    const first = toolResult("call_1", "exec", "第一轮结果");
    agent.messages.push(first);
    agent.fire("message", first); // pending：不转
    fireToolCallEnd(agent, first);
    expect(pick("tool-call-end").map((event) => event.turnId)).toEqual([1]);

    agent.fire("finally");
    await settled();

    expect(manager.send(sessionId, "第二轮").turnId).toBe(2);
    const second = toolResult("call_2", "read_file", "第二轮结果");
    agent.messages.push(second);
    agent.fire("message", second);
    fireToolCallEnd(agent, second);

    expect(pick("tool-call-end").map((event) => event.turnId)).toEqual([1, 2]);
  });
});

/**
 * 子 Agent 栏目 —— 行为对齐 CLI 的 `onSubStart` / `onSubEnd`：序号、三态、增量分流、
 * 「只活当前一轮」。每条用例都对着一个会被后人改坏的点。
 */
describe("SessionManager：子 Agent（栏目）", () => {
  it("sub-agent-start → sub-agent-start：index 从 1 起，id 是 sub-1 / sub-2", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("sub-agent-start", { subAgent: new FakeSubAgent() });
    agent.fire("sub-agent-start", { subAgent: new FakeSubAgent() });

    expect(pick("sub-agent-start")).toEqual([
      { event: "sub-agent-start", sessionId, turnId: 1, subAgentId: "sub-1", index: 1 },
      { event: "sub-agent-start", sessionId, turnId: 1, subAgentId: "sub-2", index: 2 },
    ]);
  });

  it("子 Agent 的**原始片**也带 subAgentId 上线（客户端要拿它自己折消息）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    const raw = chunk({ content: "子" });
    fireChunk(sub, raw);

    const pushed = pick("chunk");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ sessionId, turnId: 1, subAgentId: "sub-1" });
    // 原样搬这一片（厂商形状，协议不解释）
    expect(pushed[0]!.chunk).toBe(raw);
  });

  it("子 Agent 的片**一行都不碰主阶段**（它的 delta 只归它自己）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    // 主 Agent 此刻停在「等待委派工具返回」
    agent.fire("parsed", {
      message: {
        role: "assistant",
        tool_calls: [{ id: "a", function: { name: "call_skill_sub_agent" } }],
      },
    });
    const phasesBefore = pick("session-phase").length;

    fireChunk(sub, { choices: [{ delta: { reasoning_content: "想…" } }] });
    fireChunk(sub, { choices: [{ delta: { content: "子" } }] });

    // 子 Agent 的原始片带 `subAgentId` 上线（客户端折它得到正文）；摘出来的增量不上线
    expect(pick("chunk").slice(-2).map((event) => event.subAgentId)).toEqual(["sub-1", "sub-1"]);
    // 回归保护：拿子 Agent 的 delta 去改主阶段，界面会从「等待 xxx 返回」变成「输出中」
    expect(pick("session-phase")).toHaveLength(phasesBefore);
    expect((await manager.list("ws-1"))[0]!.phase).toMatchObject({
      kind: "tool-waiting",
      tools: ["call_skill_sub_agent"],
    });
  });

  it("sub-agent-end → sub-agent-end{done}", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    agent.fire("sub-agent-end", { subAgent: sub });

    expect(pick("sub-agent-end")).toEqual([
      {
        event: "sub-agent-end",
        sessionId,
        turnId: 1,
        subAgentId: "sub-1",
        status: "done",
      },
    ]);
    expect((await manager.subAgentSnapshot(sessionId, "sub-1")).status).toBe("done");
  });

  it("子 Agent 出错：ended{failed} + 一条 notice；随后的 sub-agent-end 不能把它改成 done", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    sub.fire("error", new Error("模型 500"));

    expect(pick("sub-agent-end")).toEqual([
      {
        event: "sub-agent-end",
        sessionId,
        turnId: 1,
        subAgentId: "sub-1",
        status: "failed",
      },
    ]);
    // 错误原文进 params.message：服务端不产文案，客户端查自己的 i18n 表
    expect(pick("session-notice")).toEqual([
      {
        event: "session-notice",
        sessionId,
        level: "error",
        code: "subAgentFailed",
        params: { index: 1, message: "模型 500" },
      },
    ]);

    // 出错优先：SDK 随后还会发 sub-agent-end，这里绝不能把它报成「跑完了」
    agent.fire("sub-agent-end", { subAgent: sub });
    expect(pick("sub-agent-end")).toHaveLength(1);
    expect((await manager.subAgentSnapshot(sessionId, "sub-1")).status).toBe("failed");
  });

  it("一轮结束（finally）就清空：subAgentSnapshot 报 sub-agent-missing", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });
    expect((await manager.subAgentSnapshot(sessionId, "sub-1")).status).toBe("running");

    agent.fire("finally");
    await settled();

    await expect(manager.subAgentSnapshot(sessionId, "sub-1")).rejects.toMatchObject({
      code: "sub-agent-missing",
    });

    // 展示序号归零（下一轮又是「子AGENT1」），但 id 不归零 —— 与 CLI 一致：
    // id 是客户端选中态的锚点，跨轮复用会让上一轮残留的选中态接到新一轮的 sub-1 上
    manager.send(sessionId, "再来一轮");
    agent.fire("sub-agent-start", { subAgent: new FakeSubAgent() });
    expect(pick("sub-agent-start").at(-1)).toMatchObject({
      turnId: 2,
      subAgentId: "sub-2",
      index: 1,
    });
  });

  it("subAgentSnapshot 给的是这个子 Agent 自己的对话（与主会话互不干扰）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    agent.messages = [{ role: "user", content: "主线的事" }];
    const sub = new FakeSubAgent();
    sub.messages = [
      { role: "user", content: "子任务" },
      { role: "assistant", content: "子答复" },
    ];
    agent.fire("sub-agent-start", { subAgent: sub });

    expect(await manager.subAgentSnapshot(sessionId, "sub-1")).toEqual({
      subAgentId: "sub-1",
      index: 1,
      status: "running",
      messages: [
        { role: "user", content: "子任务" },
        { role: "assistant", content: "子答复" },
      ],
    });
    expect((await manager.snapshot(sessionId)).messages).toEqual([
      { role: "user", content: "主线的事" },
    ]);
  });

  it("未知会话 → unknown-session；未知子 Agent → sub-agent-missing", async () => {
    const { sessionId } = await create();

    await expect(manager.subAgentSnapshot("chat_404", "sub-1")).rejects.toThrow(/unknown session/);
    await expect(manager.subAgentSnapshot(sessionId, "sub-9")).rejects.toMatchObject({
      code: "sub-agent-missing",
    });
  });
});
