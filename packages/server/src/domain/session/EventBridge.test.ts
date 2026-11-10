/**
 * `EventBridge` 的用例：SDK 事件怎么翻成协议事件。
 *
 * 这一组盯的是「服务端搬的是**哪一份**真相」与「什么时候搬」：正文增量必须是第二个
 * 参数（不是消息本身）、工具调用给的是组装态（不是增片）、工具结果在定型那一刻推
 * （不等轮末）、子 Agent 的事件绝不碰主阶段。
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

  it("正文与推理增量分别上报；只带 usage 的收尾 chunk 只带用量、不带正文", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ reasoning_content: "想…" }));
    fireChunk(agent, chunk({ content: "答案" }));
    // 只有 total_tokens、没有 completion_tokens：没有可校准的东西，不上报（免得一串空增量）
    fireChunk(agent, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { total_tokens: 9 },
    });
    // 带 completion_tokens 的收尾 chunk：正文为空也要出去，状态栏的 tok/s 靠它校准
    fireChunk(agent, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 42, total_tokens: 51 },
    });

    expect(pick("chunk-parsed").map((e) => [e.text, e.reasoning])).toEqual([
      ["", "想…"],
      ["答案", ""],
      ["", ""],
    ]);
    expect(pick("chunk-parsed").at(-1)!.usage).toEqual({ completionTokens: 42 });
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
   * 三条时机约束是协议的一部分（客户端按它们排事实）：同一片 `chunk` 先于 `chunk-parsed`；
   * `error` 先于 `finally`；`finally` 先于 `session-turn-end`（后者要等落盘）。
   */
  it("时机顺序：chunk → chunk-parsed；error → finally → session-turn-end", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ content: "答" }));
    const names = events.map((event) => event.event);
    expect(names.indexOf("chunk")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("chunk")).toBeLessThan(names.indexOf("chunk-parsed"));

    agent.fire("error", Object.assign(new Error("超时"), { code: "timeout" }));
    agent.fire("finally");
    await settled();

    const tail = events
      .map((event) => event.event)
      .filter((name) => name === "error" || name === "finally" || name === "session-turn-end");
    expect(tail).toEqual(["error", "finally", "session-turn-end"]);
    // Error 实例不能上线：摊成 `{ code, message }` 两个字段
    expect(pick("error")).toEqual([
      { event: "error", sessionId, turnId: 1, error: { code: "timeout", message: "超时" } },
    ]);
  });
});
/**
 * 工具调用的组装态（`session-tool-calls`）—— 客户端在流式期间画工具卡片的唯一依据。
 *
 * 这一组盯的是「服务端搬的是**哪一份**真相」：core 已经把工具调用拼进了那条正在拼的
 * assistant 消息（`chunk-parsed` 的第一个参数），服务端只该把它转出去。所以每条用例都按
 * 真件形状两参 fire，并且让同一个 receiver 逐片长大（见 `fireToolCall`）。
 */
describe("SessionManager：工具调用的组装态（session-tool-calls）", () => {
  it("流式期间就把工具调用推上线：名字与参数都是组装后的内容", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const receiver = assembling();

    fireToolCall(agent, receiver, 0, { id: "call_1", name: "exec", arguments: '{"command":"ls' });
    fireToolCall(agent, receiver, 0, { arguments: ' -la"}' });

    const calls = pick("session-tool-calls");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)!.turnId).toBe(1);
    expect(calls.at(-1)!.toolCalls).toEqual([
      { index: 0, id: "call_1", name: "exec", arguments: '{"command":"ls -la"}' },
    ]);
  });

  it("给的是组装态而不是增片：第二片到达后参数是完整的，不是只有新的一段", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const receiver = assembling();

    fireToolCall(agent, receiver, 0, { id: "call_1", name: "read_file", arguments: '{"path":' });
    const first = pick("session-tool-calls").at(-1)!.toolCalls[0]!.arguments;

    fireToolCall(agent, receiver, 0, { arguments: '"a.txt"}' });
    const second = pick("session-tool-calls").at(-1)!.toolCalls[0]!.arguments;

    expect(first).toBe('{"path":');
    // 不是 '"a.txt"}'（只有新的那一段），而是两片拼起来的那一份
    expect(second).toBe('{"path":"a.txt"}');
  });

  it("参数没变的重复 chunk 不再发（否则客户端每帧重渲染）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const receiver = assembling();

    fireToolCall(agent, receiver, 0, { id: "call_1", name: "read_file", arguments: '{"path":"a"' });
    const before = pick("session-tool-calls").length;

    // 同一下标再来一遍、参数片段为空：组装结果一个字没变
    fireToolCall(agent, receiver, 0, { id: "call_1", arguments: "" });
    // 只带 usage 的收尾片：连 tool_calls 都没有
    fireChunk(agent, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 3 },
    });

    expect(pick("session-tool-calls")).toHaveLength(before);
  });

  it("一轮收尾后状态清零：上一轮的调用既不挡住、也不混进新一轮", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "第一轮");
    fireToolCall(agent, assembling(), 0, {
      id: "call_1",
      name: "exec",
      arguments: '{"command":"ls"}',
    });
    expect(pick("session-tool-calls").at(-1)!.turnId).toBe(1);

    agent.fire("finally");
    await settled();

    // 第二轮拼出来的 id、名字、参数与第一轮**逐字相同**（同一句话重试、同一个脚本再跑一次
    // 就会这样）：影子没清的话这一片会被当成「没变化」，整轮连一张工具卡片都发不出去
    expect(manager.send(sessionId, "第二轮").turnId).toBe(2);
    fireToolCall(agent, assembling(), 0, {
      id: "call_1",
      name: "exec",
      arguments: '{"command":"ls"}',
    });
    expect(pick("session-tool-calls").map((event) => event.turnId)).toEqual([1, 2]);
    // 只有本轮组装出来的那一个：上一轮那份没有被叠进来（载荷是组装态，不是累计账本）
    expect(pick("session-tool-calls").at(-1)!.toolCalls).toEqual([
      { index: 0, id: "call_1", name: "exec", arguments: '{"command":"ls"}' },
    ]);

    // 第三轮换个工具：载荷整份换掉，上一轮的 exec 不会跟着留下来
    agent.fire("finally");
    await settled();
    expect(manager.send(sessionId, "第三轮").turnId).toBe(3);
    fireToolCall(agent, assembling(), 0, {
      id: "call_9",
      name: "read_file",
      arguments: '{"path":"b"}',
    });
    expect(pick("session-tool-calls").at(-1)!.toolCalls).toEqual([
      { index: 0, id: "call_9", name: "read_file", arguments: '{"path":"b"}' },
    ]);
  });
});
/**
 * 工具结果消息（`tool-call-end`）—— 工具跑完一个就推一条，不等一轮结束。
 *
 * 这一组盯的是**时机与身份**：推的是哪一条消息（刚定型的工具结果）、什么时候推（`tool-call-end`
 * 那一刻，不是 `session-turn-end` 之后）、以及推第几次（同一条只推一次，跨轮不串）。每条用例都按真件
 * 的形状摆布 `agent.messages`：结果消息在执行**前**就以 `pending` 追加、跑完才翻终态。
 */
describe("SessionManager：工具结果消息（tool-call-end）", () => {
  /** 事件里推出去的那几条消息（按顺序），只取判定身份要用的字段 */
  const appended = () => pick("tool-call-end").map((event) => event.message as Record<string, any>);

  it("工具一跑完就把结果消息推上线：不必等 session-turn-end，推的就是那一条", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    const message = toolResult("call_1", "exec", "总用量 12");
    agent.messages.push(message);
    fireToolCallEnd(agent, message);

    const events = pick("tool-call-end");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId, turnId: 1 });
    // 推的是**那一条**：tool_call_id 与正文都对得上（服务端只搬运，不重新包装）
    expect(events[0]!.message).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      name: "exec",
      content: "总用量 12",
      status: "completed",
    });
    // 此刻这一轮还没收尾 —— 这正是这条事件存在的理由（快照要等到 session-turn-end 之后）
    expect(pick("session-turn-end")).toHaveLength(0);
  });

  it("同一条结果不会推第二次：没有新消息就不发", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    const message = toolResult("call_1", "exec", "ok");
    agent.messages.push(message);
    fireToolCallEnd(agent, message);
    expect(appended()).toHaveLength(1);

    // 再 fire 一次、消息表一个字没变：没有「新追加的」可推
    fireToolCallEnd(agent, message);
    expect(appended()).toHaveLength(1);
  });

  it("并行/连续多个工具：各推一次，顺序与追加顺序一致", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    const first = toolResult("call_1", "exec", "第一次");
    agent.messages.push(first);
    fireToolCallEnd(agent, first);

    const second = toolResult("call_2", "edit", "第二次");
    agent.messages.push(second);
    fireToolCallEnd(agent, second);

    expect(appended().map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(appended().map((message) => message.content)).toEqual(["第一次", "第二次"]);
  });

  it("只推工具结果：同一批里的 assistant 消息不推（它由 chunk-parsed + 占位消息在画）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    // 一轮里前面那个内层循环已经说完的正文（`status: completed`，不是拼装中）：客户端手上
    // 早就有了这一条。它会出现在 `agent.messages` 里，但绝不该从这条通道再推一遍 ——
    // 否则同一条消息有了两种表示，收尾还得对账「哪一份才是真的」。
    agent.messages.push({ role: "assistant", content: "我来看一下", status: "completed" });
    const message = toolResult("call_1", "exec", "ok");
    agent.messages.push(message);
    fireToolCallEnd(agent, message);

    expect(appended()).toHaveLength(1);
    expect(appended()[0]!.role).toBe("tool");
    expect(appended()[0]!.tool_call_id).toBe("call_1");
  });

  it("不跨轮泄漏：上一轮推过的消息既不再推，也不挡住下一轮的第一条", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "第一轮");
    const first = toolResult("call_1", "exec", "第一轮结果");
    agent.messages.push(first);
    fireToolCallEnd(agent, first);
    expect(appended()).toHaveLength(1);

    agent.fire("finally");
    await settled();

    expect(manager.send(sessionId, "第二轮").turnId).toBe(2);
    const second = toolResult("call_2", "read_file", "第二轮结果");
    agent.messages.push(second);
    fireToolCallEnd(agent, second);

    // 第二轮那条照推（没被上一轮的水位挡掉），上一轮那条也没被重推（清空成空集就会漏成
    // ["call_1","call_1","call_2"]）
    expect(appended().map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(pick("tool-call-end").at(-1)!.turnId).toBe(2);
  });

  it("并行时先跑完的先推；还没定型的那条等它自己跑完，不会被当成结果提前推出去", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    // 真件的顺序：两个工具的结果消息在**执行前**就都追加好了（core 在 `Promise.all` 的
    // map 里同步 append），所以「先完成的那条」往往排在**后面**，前面那条还是 pending、
    // 正文空（这条顺序是实跑 core 确认的，见 `Message.Tool` 与 `handleToolCall`）
    const slow = toolResult("call_1", "exec");
    const fast = toolResult("call_2", "read_file");
    agent.messages.push(slow, fast);

    // 快工具跑完：正文在这一刻才落（core 的 `resultReceiver.content = await tool.exec(ctx)`），
    // 随后 `markResult` 翻状态并 fire
    fast.content = "快结果";
    fireToolCallEnd(agent, fast, "completed");
    // 只推快的那条，且是定型后的正文；慢的那条此刻正文还是空的，不能提前推
    expect(appended().map((message) => message.tool_call_id)).toEqual(["call_2"]);
    expect(appended()[0]!.content).toBe("快结果");

    slow.content = "慢结果";
    fireToolCallEnd(agent, slow, "completed");
    expect(appended().map((message) => message.tool_call_id)).toEqual(["call_2", "call_1"]);
    expect(appended().map((message) => message.content)).toEqual(["快结果", "慢结果"]);
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

  it("子 Agent 的增量带 subAgentId 推给客户端，且**一行都不碰主阶段**", async () => {
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

    expect(pick("chunk-parsed").slice(-2)).toEqual([
      {
        event: "chunk-parsed",
        sessionId,
        turnId: 1,
        subAgentId: "sub-1",
        text: "",
        reasoning: "想…",
      },
      {
        event: "chunk-parsed",
        sessionId,
        turnId: 1,
        subAgentId: "sub-1",
        text: "子",
        reasoning: "",
      },
    ]);
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
