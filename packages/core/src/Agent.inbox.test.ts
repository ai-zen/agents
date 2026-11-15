import { describe, it, expect, vi } from "vitest";
import { Agent } from "./Agent.js";
import type { InboxContext } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { inboxEntryContent } from "./Inbox.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Helper：Mock OpenAI client（手法与 Agent.test.ts 一致，另外把每次请求体记下来）
// ---------------------------------------------------------------------------

type AnyChunk = any;

/** 构造一个流式 chunk */
function chunk(delta: any, finish_reason: any = null): AnyChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

/** 结束 chunk（finish_reason = stop） */
function stopChunk(): AnyChunk {
  return chunk({}, "stop");
}

/** 将 chunk 数组包装为 async iterable stream */
function makeStream(chunks: AnyChunk[]): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c as ChatCompletionChunk;
      }
    },
  };
}

/** 挂起流：signal abort 时结束（已 aborted 则立即结束） */
function makeHangingStream(signal: AbortSignal): AsyncIterable<AnyChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    },
  };
}

/**
 * 创建 Mock OpenAI client，并记录**每一次请求体**。
 *
 * 断言「模型下一轮看得见那条 inbox 消息」只能看请求体里的 messages —— 那是模型真正收到
 * 的东西，比翻 agent.messages 更接近事实。
 */
function createRecordingClient(rounds: AnyChunk[][]) {
  const bodies: any[] = [];
  const create = vi.fn(async (body: any, _options: any) => {
    bodies.push(body);
    const data = rounds[bodies.length - 1] ?? [stopChunk()];
    return makeStream(data);
  });
  const client = { chat: { completions: { create } } } as any;
  return { client, create, bodies };
}

/** 一个会吐出一轮 tool_calls 的 chunk 序列（工具名 getTime） */
function toolCallRound(name = "getTime"): AnyChunk[] {
  return [
    chunk({
      tool_calls: [
        { index: 0, id: "call-1", type: "function", function: { name, arguments: "{}" } },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
}

/** 只输出一段正文就停（不调工具） */
function textRound(text: string): AnyChunk[] {
  return [chunk({ content: text }), stopChunk()];
}

/**
 * 每次请求都先停在**手动闸门**上的假 client：`releases[n]()` 才放行第 n+1 次请求。
 *
 * 用它是为了把「段正在跑」做成一个可以停住看的一刻：「这一刻投递进去的东西到底落没落成消息」
 * 必须能在请求体上验证，而不是只能事后看 `messages`。
 */
function gatedClient(rounds: AnyChunk[][]) {
  const bodies: any[] = [];
  const releases: Array<() => void> = [];
  const create = vi.fn(async (body: any) => {
    bodies.push(body);
    await new Promise<void>((resolve) => releases.push(resolve));
    return makeStream(rounds[bodies.length - 1] ?? [stopChunk()]);
  });
  const client = { chat: { completions: { create } } } as any;
  return { client, create, bodies, releases };
}

/** 一个返回固定结果的工具 */
function makeTool(name = "getTime", result = "12:00:00") {
  return new CallbackTool({
    function: {
      name,
      description: "获取当前时间",
      parameters: { type: "object", properties: {} },
    },
    callback: () => result,
  });
}

/** 请求体里最后一条消息（模型下一轮最先看的就是消息列表的末尾） */
function lastMessage(body: any): any {
  return body.messages.at(-1);
}

/** 按 role 取请求体里的消息 */
function messagesOfRole(body: any, role: AgentNS.Role): any[] {
  return body.messages.filter((m: any) => m.role === role);
}

/**
 * 非 user 来源落地后的正文：注释行（来源 + ISO 时间）+ 空行 + 原文。
 *
 * 时间取条目自己的 `createdAt`（投递那一刻才生成），所以断言这里只校验 ISO 形状。
 */
function withSourceNote(source: string, body: string): RegExp {
  return new RegExp(`^// 这条消息来自 ${source} 自动推送（[\\dT:.Z-]+）\\n\\n${body}$`);
}

/**
 * 一个只在**第一次**触发时干活的钩子体（用来把「投递发生在跑的过程中」做成确定性的一刻）。
 *
 * 为什么投递要放在钩子里：`deliver()` 在静止态会立刻把段叫起来，于是「跑中投递」这条路径
 * 就只能从段内部触发（真机形态就是另一个会话 / 异步工具 / 收尾钩子里的那一句）。用
 * `vi.fn()` 的 `mock.calls.length` 判断第一次，别再造一个布尔量。
 */
function once(fn: () => void) {
  const spy = vi.fn(() => {
    if (spy.mock.calls.length === 1) fn();
  });
  return spy;
}

/** 等段结束（`deliver` 叫醒的段没人 await，测试靠状态回落来等它） */
async function settled(agent: Agent): Promise<void> {
  await vi.waitFor(() => expect(["idle", "terminated"]).toContain(agent.runStatus));
}

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

describe("Agent.inbox", () => {
  describe("deliver / clearInbox", () => {
    it("缺 id 与时间时就地补齐，条目进队列，回执带回那个 id", async () => {
      const { client } = createRecordingClient([textRound("收到")]);
      const agent = new Agent({ client, model: "gpt-4" });

      // 静止态投递会立刻落地（先 `flushInbox` 再叫醒），所以条目本身从入队事件上取
      const entries: AgentNS.InboxEntry[] = [];
      agent.events.on("inbox", (ctx: InboxContext) => entries.push(ctx.entry));

      const receipt = agent.deliver({ source: "user", priority: "high", content: "插一句" });

      // 回执：id 就是落地那条消息要用的那个，accepted 恒 true（队列只进不出）
      expect(receipt.messageId).toBeTruthy();
      expect(receipt.accepted).toBe(true);
      // 条目本身：id / createdAt 都在入队时补好
      expect(entries).toHaveLength(1);
      expect(entries[0]!.messageId).toBe(receipt.messageId);
      expect(Number.isFinite(Date.parse(entries[0]!.createdAt))).toBe(true);
      // 落地那条就是它
      expect(agent.messages.at(-1)!.id).toBe(receipt.messageId);

      await settled(agent);
    });

    it("传了 messageId 就用传的那个", async () => {
      const { client } = createRecordingClient([textRound("收到")]);
      const agent = new Agent({ client, model: "gpt-4" });

      const receipt = agent.deliver({
        source: "tool",
        priority: "low",
        content: "工具结果",
        messageId: "host-msg-1",
      });

      expect(receipt.messageId).toBe("host-msg-1");
      // 落地那条用的也是这个 id（宿主先把它回过客户端）
      expect(agent.messages.at(-1)!.id).toBe("host-msg-1");

      await settled(agent);
    });

    it("投递完广播 inbox 事件，载荷带 agent 与 entry", async () => {
      const { client } = createRecordingClient([textRound("收到")]);
      const agent = new Agent({ client, model: "gpt-4" });

      const seen: InboxContext[] = [];
      agent.events.on("inbox", (ctx: InboxContext) => seen.push(ctx));

      const receipt = agent.deliver({ source: "user", priority: "low", content: "排队" });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.agent).toBe(agent);
      expect(seen[0]!.entry.messageId).toBe(receipt.messageId);

      await settled(agent);
    });

    it("一条消息都没有的 agent：投递照样把它叫起来，落地之后就是这一段", async () => {
      // 口径改了：旧版在这里拦一手（怕撞上 `run()` 的空消息校验）；现在「唤醒前先 `flushInbox`」
      // 会先 append 一条 `Message.User`，那条校验自然过 —— 一条投递就是一段对话的起点。
      const { client, create, bodies } = createRecordingClient([textRound("那就从这儿开始")]);
      const agent = new Agent({ client, model: "gpt-4" });

      const receipt = agent.deliver({ source: "user", priority: "high", content: "先排着" });

      expect(receipt.accepted).toBe(true);
      expect(receipt.woke).toBe(true);
      // 同步就已经落地：队列空了，消息进了 messages
      expect(agent.inbox).toHaveLength(0);
      expect(agent.messages.at(-1)!.content).toBe("先排着");

      await settled(agent);
      expect(create).toHaveBeenCalledTimes(1);
      expect(lastMessage(bodies[0]).content).toBe("先排着");
      expect(agent.messages.at(-1)!.content).toBe("那就从这儿开始");
    });

    it("clearInbox 清空并返回被丢掉的条目（core 自己不再调它：按停不碰 inbox）", async () => {
      // 投递要在**段正在跑**时发生：静止态投递会立刻落地，队列里留不下东西
      const ctx = gatedClient([textRound("一")]);
      const agent = new Agent({ client: ctx.client, model: "gpt-4" });
      agent.append(Message.User("你好"));
      const running = agent.run();
      await vi.waitFor(() => expect(ctx.create).toHaveBeenCalledTimes(1));

      agent.deliver({ source: "user", priority: "high", content: "A" });
      agent.deliver({ source: "tool", priority: "low", content: "B" });

      const dropped = agent.clearInbox();

      expect(dropped.map((entry) => entry.content)).toEqual(["A", "B"]);
      expect(agent.inbox).toHaveLength(0);

      ctx.releases[0]!();
      await running;
    });

    it("清空后 inbox 仍是同一个数组实例（外部快照不会指向一份死队列）", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      const snapshot = agent.inbox;
      agent.deliver({ source: "user", priority: "high", content: "A" });

      agent.clearInbox();

      expect(agent.inbox).toBe(snapshot);
      expect(snapshot).toHaveLength(0);
    });
  });

  describe("deliver（整批形态）", () => {
    it("静止态整批投递：N 条一次落地成 N 条 User 消息、只起一段、只一次请求", async () => {
      const { client, create, bodies } = createRecordingClient([textRound("三条都收到了")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const receipts = agent.deliver([
        { source: "user", priority: "high", content: "甲", messageId: "batch-1" },
        { source: "会话「补测试」", priority: "high", content: "乙" },
        { source: "会话「复查」", priority: "low", content: "丙" },
      ]);

      // 回执与入参一一对应；`woke` 是**整批一次**行为，于是每条都是 true
      expect(receipts).toHaveLength(3);
      expect(receipts[0]!.messageId).toBe("batch-1");
      expect(receipts.map((receipt) => receipt.accepted)).toEqual([true, true, true]);
      expect(receipts.map((receipt) => receipt.woke)).toEqual([true, true, true]);

      // 同步就已经全部落地（`flushInbox` 不看优先级：静止态每一条都是这一段存在的理由）
      expect(agent.inbox).toHaveLength(0);
      const users = agent.messages.filter((message) => message.role === AgentNS.Role.User);
      expect(users.map((message) => message.id)).toEqual(
        receipts.map((receipt) => receipt.messageId),
      );
      // 第一条（source 为 user）原样，后两条各自带来源注释
      expect(users[0]!.content).toBe("甲");
      expect(users[1]!.content as string).toMatch(withSourceNote("会话「补测试」", "乙"));
      expect(users[2]!.content as string).toMatch(withSourceNote("会话「复查」", "丙"));

      await settled(agent);

      // 只起了一段、只有一次请求：那一次请求里三条都在（没有「先落一条起段、其余下个边界」）
      expect(create).toHaveBeenCalledTimes(1);
      expect(
        messagesOfRole(bodies[0], AgentNS.Role.User).map((message: any) => message.content),
      ).toHaveLength(3);
      // assistant 只有一条（多起一段就会多一条回答）
      const assistants = agent.messages.filter(
        (message) => message.role === AgentNS.Role.Assistant,
      );
      expect(assistants).toHaveLength(1);
      expect(assistants[0]!.content).toBe("三条都收到了");
      expect(agent.runStatus).toBe("idle");
    });

    it("静止态整批投递：`status(running)` 仍先于本段第一条 `message`", async () => {
      const { client } = createRecordingClient([textRound("收到")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const seen: string[] = [];
      agent.events.on("status", (ctx: { to: AgentNS.RunStatus }) => seen.push(`status:${ctx.to}`));
      agent.events.on("message", (message: AgentNS.Message) =>
        seen.push(`message:${message.role}`),
      );

      agent.deliver([
        { source: "user", priority: "high", content: "一" },
        { source: "user", priority: "high", content: "二" },
      ]);
      await settled(agent);

      // 第一拍必须是「这一段开始了」，紧接着才是那两条 User 消息
      expect(seen[0]).toBe("status:running");
      expect(seen.slice(1, 3)).toEqual(["message:user", "message:user"]);
    });

    it("跑中的整批投递：三条在同一次内循环边界落地，只多一次请求", async () => {
      const { client, create, bodies } = createRecordingClient([
        textRound("先回一句"),
        textRound("三条一起收到了"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      let receipts: AgentNS.DeliveryReceipt[] | undefined;
      agent.use({
        onInnerLoopEnd: once(() => {
          receipts = agent.deliver([
            { source: "user", priority: "high", content: "甲" },
            { source: "user", priority: "high", content: "乙" },
            { source: "user", priority: "high", content: "丙" },
          ]);
        }),
      });

      agent.append(Message.User("开始"));
      await agent.run();

      // 跑中投递不算叫醒（段本来就在跑），整批一个值
      expect(receipts!.map((receipt) => receipt.woke)).toEqual([false, false, false]);

      // 第一圈收尾 → 三条 high 被**同一个**取件点一次取走 → 第二圈
      expect(create).toHaveBeenCalledTimes(2);
      expect(
        messagesOfRole(bodies[1], AgentNS.Role.User).map((message: any) => message.content),
      ).toEqual(["开始", "甲", "乙", "丙"]);
      expect(
        agent.messages
          .filter((message) => message.role === AgentNS.Role.User)
          .map((message) => message.content),
      ).toEqual(["开始", "甲", "乙", "丙"]);
      expect(agent.inbox).toHaveLength(0);
    });

    it("空白批：不起段、不叫醒、不落地任何消息", async () => {
      const { client, create } = createRecordingClient([textRound("不该被请求到")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const receipts = agent.deliver([]);

      expect(receipts).toEqual([]);
      expect(agent.runStatus).toBe("idle");
      expect(agent.inbox).toHaveLength(0);
      expect(agent.messages).toHaveLength(1); // 只有那条 System
      expect(create).not.toHaveBeenCalled();
    });

    it("单条 `deliver(entry)` 与整批 `deliver([entry])` 同形（一个方法、两种入参）", async () => {
      const one = createRecordingClient([textRound("一")]);
      const singleAgent = new Agent({
        client: one.client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });
      const two = createRecordingClient([textRound("一")]);
      const batchAgent = new Agent({
        client: two.client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });

      const single = singleAgent.deliver({
        source: "user",
        priority: "high",
        content: "一条",
        messageId: "same-1",
      });
      const batch = batchAgent.deliver([
        { source: "user", priority: "high", content: "一条", messageId: "same-1" },
      ]);
      await settled(singleAgent);
      await settled(batchAgent);

      expect(single).toEqual({ messageId: "same-1", accepted: true, woke: true });
      expect(batch).toEqual([single]);
      // 两条路落出来的段同形（同样的消息序列）
      expect(batchAgent.messages.map((message) => message.role)).toEqual(
        singleAgent.messages.map((message) => message.role),
      );
    });
  });

  describe("取件点（内循环末）：high", () => {
    it("工具跑完之后立即插入：下一次请求里出现这条 User，且排在工具结果之后", async () => {
      const { client, create, bodies } = createRecordingClient([
        toolCallRound(),
        textRound("看完了"),
      ]);
      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [makeTool()],
      });

      // 投递发生在段内部（工具轮刚收尾那一刻）：`deliver` 看到 running，只入队不叫醒
      let receipt: AgentNS.DeliveryReceipt | undefined;
      agent.use({
        onInnerLoopEnd: once(() => {
          receipt = agent.deliver({ source: "user", priority: "high", content: "顺便看下时区" });
        }),
      });

      agent.append(Message.User("现在几点"));
      await agent.run();

      // 第一轮 tool_calls → 工具结果 → 插入 User → 第二轮
      expect(create).toHaveBeenCalledTimes(2);
      // 跑中投递不算「叫醒」：段本来就在跑
      expect(receipt!.woke).toBe(false);

      const second = bodies[1];
      const last = lastMessage(second);
      expect(last.role).toBe(AgentNS.Role.User);
      expect(last.content).toBe("顺便看下时区");

      // 位置：工具结果之后（否则模型会把这条用户消息读成工具调用之前的问题）
      const toolIndex = second.messages.findIndex((m: any) => m.role === AgentNS.Role.Tool);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(second.messages.length - 1).toBeGreaterThan(toolIndex);

      // 落地的那条消息确实进了 messages，且就是 inbox 里那条（同一个 id）
      const landed = agent.messages.filter((m) => m.role === AgentNS.Role.User);
      expect(landed).toHaveLength(2);
      expect(landed[1]!.content).toBe("顺便看下时区");
      expect(landed[1]!.id).toBe(receipt!.messageId);
      // 取走之后 inbox 空了
      expect(agent.inbox).toHaveLength(0);
    });

    it("模型仍在调工具（needContinue 已是 true）时，high 条目同样在轮末落地", async () => {
      const { client, create, bodies } = createRecordingClient([
        toolCallRound(),
        toolCallRound(),
        textRound("两轮工具都跑完了"),
      ]);
      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [makeTool()],
      });

      agent.use({
        onInnerLoopEnd: once(() => {
          agent.deliver({ source: "user", priority: "high", content: "插一句" });
        }),
      });

      agent.append(Message.User("开始"));
      await agent.run();

      expect(create).toHaveBeenCalledTimes(3);
      // 第一次请求里没有它，第二次请求（工具跑完那一圈之后）里就有了
      expect(messagesOfRole(bodies[0], AgentNS.Role.User)).toHaveLength(1);
      expect(messagesOfRole(bodies[1], AgentNS.Role.User)).toHaveLength(2);
      expect(lastMessage(bodies[1]).content).toBe("插一句");
    });
  });

  describe("取件点（内循环末）：low 在这一组要停时进", () => {
    it("agent 停下之后插入，并再跑一轮", async () => {
      // 模型这一次不调工具 = 这一圈末 `needContinue` 是 false = low 该进的时刻（取件点在这一圈末）。
      const { client, create, bodies } = createRecordingClient([
        textRound("第一轮说完了"),
        textRound("第二轮说完了"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.use({
        onInnerLoopEnd: once(() => {
          agent.deliver({ source: "user", priority: "low", content: "还有一件事" });
        }),
      });

      agent.append(Message.User("你好"));
      await agent.run();

      // 停下 → 插入 → 又跑了一轮
      expect(create).toHaveBeenCalledTimes(2);
      expect(messagesOfRole(bodies[0], AgentNS.Role.User)).toHaveLength(1);

      const last = lastMessage(bodies[1]);
      expect(last.role).toBe(AgentNS.Role.User);
      expect(last.content).toBe("还有一件事");

      // 第二轮里，被插进来的那条排在上一轮 assistant 之后
      const assistantIndex = bodies[1].messages.findIndex(
        (m: any) => m.role === AgentNS.Role.Assistant,
      );
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(bodies[1].messages.length - 1).toBeGreaterThan(assistantIndex);
    });

    it("工具轮停下之后 low 也会插入：在那一圈末，不必等 reconcile*", async () => {
      // 取件点与 high 是同一处（内循环末），low 只多一个判据：`!needContinue`。所以它落在
      // 「这一组要停」的那一圈末，而不是「整组内循环全部收尾（reconcile* 之后）」——后者是
      // 改动前 `run()` 取件循环的位置，现在那里不再取件。两者不可交换：reconcile* 改的是已经
      // 发出去的 assistant / tool 消息，与末尾再插一条 User 不打架。
      const { client, create, bodies } = createRecordingClient([
        toolCallRound(),
        textRound("工具跑完了，停"),
        textRound("低优先那条也处理完了"),
      ]);
      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [makeTool()],
      });

      agent.use({
        onInnerLoopEnd: once(() => {
          agent.deliver({ source: "tool", priority: "low", content: "异步工具结果" });
        }),
      });

      agent.append(Message.User("开始"));
      await agent.run();

      // ①②工具轮 + ③被 low 续起来的最后一轮
      expect(create).toHaveBeenCalledTimes(3);
      expect(lastMessage(bodies[2]).content).toMatch(withSourceNote("tool", "异步工具结果"));
    });

    it("队列里同时有 high 与 low：这一圈只插 high，low 留到下一次", async () => {
      const { client, create, bodies } = createRecordingClient([
        textRound("一"),
        textRound("二"),
        textRound("三"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.use({
        onInnerLoopEnd: once(() => {
          agent.deliver({ source: "user", priority: "high", content: "高" });
          agent.deliver({ source: "user", priority: "low", content: "低" });
        }),
      });

      agent.append(Message.User("开始"));
      await agent.run();

      // 第一圈停下：`insertInbox("high")` 进了东西 → 续一圈，**low 那一档连问都不问**
      expect(create).toHaveBeenCalledTimes(3);
      expect(messagesOfRole(bodies[1], AgentNS.Role.User).map((m: any) => m.content)).toEqual([
        "开始",
        "高",
      ]);
      // 第二圈也停了、队列里没有 high 了 → 这才是 low 的时刻（第三轮请求的末条）
      expect(lastMessage(bodies[2]).content).toBe("低");
      // 落地顺序：high 在前、low 在后（同一档按入队顺序，这里各一条）
      expect(
        agent.messages.filter((m) => m.role === AgentNS.Role.User).map((m) => m.content),
      ).toEqual(["开始", "高", "低"]);
    });

    it("有工具调用的那一圈不插 low：needContinue 已为 true，low 等这一组停下", async () => {
      const { client, create, bodies } = createRecordingClient([
        toolCallRound(),
        textRound("工具跑完了"),
        textRound("整组停下之后才轮到 low"),
      ]);
      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [makeTool()],
      });

      agent.use({
        onInnerLoopEnd: once(() => {
          agent.deliver({ source: "tool", priority: "low", content: "异步工具结果" });
        }),
      });

      agent.append(Message.User("开始"));
      await agent.run();

      expect(create).toHaveBeenCalledTimes(3);
      // 工具轮后的下一次请求（第二圈）里没有它：那一圈 `needContinue` 为 true，这一组还要接着调工具
      expect(JSON.stringify(bodies[1].messages)).not.toContain("异步工具结果");
      // 整组停下之后的那一轮（第三圈）末条才是它
      expect(lastMessage(bodies[2]).content).toMatch(withSourceNote("tool", "异步工具结果"));
    });

    it("段正在跑时投递的 low：woke === false，且这一组的请求里都没有它", async () => {
      // 「运行中投递」的真实形态：另一个会话 / 异步工具把结果推进来，此刻段正在跑。
      // 它不得进这一组已经发出去的请求（那是对旧历史的回答），也不得另起一段。
      const { client, create, bodies, releases } = gatedClient([
        toolCallRound(),
        textRound("工具跑完了"),
        textRound("low 那一轮"),
      ]);
      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [makeTool()],
      });

      agent.append(Message.User("你好"));
      const runPromise = agent.run();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

      const receipt = agent.deliver({ source: "tool", priority: "low", content: "后台任务跑完了" });
      // 段在跑：不叫醒、不另起一段（请求次数仍为 1）
      expect(receipt.woke).toBe(false);
      expect(agent.runStatus).toBe("running");
      expect(create).toHaveBeenCalledTimes(1);
      // 已经在飞的那一圈请求里当然没有它
      expect(JSON.stringify(bodies[0].messages)).not.toContain("后台任务跑完了");

      // 放行第一圈（tool_calls）：这一圈 `needContinue` 为 true，low 依旧不插
      releases[0]!();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(JSON.stringify(bodies[1].messages)).not.toContain("后台任务跑完了");

      // 第二圈停下 → 这一圈末才轮到 low，并且真的为它又跑了一圈
      releases[1]!();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
      expect(lastMessage(bodies[2]).content).toMatch(withSourceNote("tool", "后台任务跑完了"));

      releases[2]!();
      await runPromise;
      expect(agent.inbox).toHaveLength(0);
    });
  });

  describe("唤醒前落地（deliver）与收尾钩子里的投递", () => {
    it("onInnerLoopsEnd 里投递的条目：这一段不取（取件点在钩子之前），等下一次驱动", async () => {
      // 口径变了两次，记在这里：
      // - 改前①：`run()` 末尾还有一次取件循环排在本钩子**之后**，钩子里那条当场被取走；
      // - 改前②：收敛成「钩子之后不再取」，但 `run()` 段首仍会取一次 —— 下一次 `run()` 的
      //   第一圈请求里就能看到它；
      // - 改后：`run()` 既不在段首取件、也不在段末取件（取件点只剩内循环末那一处），所以这一段
      //   不再取、下一次直呼 `run()` 也不会先把队列落地 —— 它由那一次驱动第一圈末的 low 取件点
      //   带走，因此多绕一圈（代价写在下面，外部驱动走 `deliver` / `send` 时不会有这一圈）。
      const { client, create, bodies } = createRecordingClient([
        textRound("第一轮说完了"),
        textRound("第二段的第一圈（还没看到它）"),
        textRound("第二段的第二圈（这次看到了）"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      let receipt: AgentNS.DeliveryReceipt | undefined;
      agent.use({
        onInnerLoopsEnd: once(() => {
          receipt = agent.deliver({ source: "user", priority: "low", content: "钩子里来的" });
        }),
      });

      agent.append(Message.User("你好"));
      await agent.run();

      // 这一段只跑了一圈：钩子里那条没有落成消息（取件点排在钩子之前）
      expect(create).toHaveBeenCalledTimes(1);
      expect(receipt!.woke).toBe(false);
      expect(agent.inbox.map((entry) => entry.messageId)).toEqual([receipt!.messageId]);
      expect(agent.messages.some((m) => m.content === "钩子里来的")).toBe(false);

      // 下一次驱动（直呼 `run()`，它不落地）把它带走：多绕一圈，落成 User 消息
      await agent.run();
      expect(create).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(bodies[1].messages)).not.toContain("钩子里来的");
      expect(agent.inbox).toHaveLength(0);
      const landed = agent.messages.find((m) => m.id === receipt!.messageId)!;
      expect(landed.role).toBe(AgentNS.Role.User);
      expect(landed.content).toBe("钩子里来的");
      expect(lastMessage(bodies[2]).content).toBe("钩子里来的");
    });

    it("deliver 唤醒的段：唤醒前就落地，第一圈请求里就有它（不空跑）", async () => {
      // 这是「唤醒」与「模型看得见这条」必须同一拍的那一条：`deliver()` 在 `run()` **之前**
      // `flushInbox()`。不先落地，`run()` 的第一圈请求里根本没有这条 —— 它会对着旧历史先回一句
      // （白花一次请求，界面上还多一句无意义回答），然后这条才被轮末取件点带走、再问一遍。
      const { client, create, bodies } = createRecordingClient([textRound("这就是回你的那句")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const receipt = agent.deliver({
        source: "user",
        priority: "low",
        content: "叫醒它的话",
        messageId: "wake-1",
      });

      // 同步就可以看到：叫醒了，且队列已经空掉（落地没等任何一跳）
      expect(receipt.woke).toBe(true);
      expect(agent.inbox).toHaveLength(0);
      expect(agent.messages.at(-1)!.id).toBe("wake-1");

      await settled(agent);

      // 一次请求就够（没有空跑那一圈），而那一圈里末条就是它
      expect(create).toHaveBeenCalledTimes(1);
      expect(bodies).toHaveLength(1);
      const last = lastMessage(bodies[0]);
      expect(last.role).toBe(AgentNS.Role.User);
      expect(last.content).toBe("叫醒它的话");
      // 末条 assistant 就是对它的回答
      expect(agent.messages.at(-1)!.role).toBe(AgentNS.Role.Assistant);
      expect(agent.messages.at(-1)!.content).toBe("这就是回你的那句");
    });

    it("onAfterSend 里投递的条目：由下一次外部驱动落地，这一次 send 不带它", async () => {
      // 口径改了：旧版 `send()` 的 `finally` 会把钩子里投进来的条目顺手带走（再跑一段、并且等
      // 它）；现在 `finally` 只置 `sendStatus`，钩子里的投递归下一轮 —— `send()` 少一次 await，
      // 代价是这次返回时队列里还排着一条。
      const { client, create, bodies } = createRecordingClient([
        textRound("这一轮说完了"),
        textRound("收尾钩子里那条也回了"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      let receipt: AgentNS.DeliveryReceipt | undefined;
      agent.use({
        onAfterSend: () => {
          receipt = agent.deliver({
            source: "user",
            priority: "low",
            content: "收尾钩子里来的",
            messageId: "host-queued-1",
          });
        },
      });

      await agent.send("你好");

      // 受理期间（`sendStatus === "sending"`）投递不起段：回执说没叫醒
      expect(receipt!.woke).toBe(false);
      expect(agent.runStatus).toBe("idle");
      // 这一次 send 没有带走它：条目还在队列里，也没落成消息、没多跑一轮
      expect(agent.inbox.map((entry) => entry.messageId)).toEqual(["host-queued-1"]);
      expect(agent.messages.some((m) => m.id === "host-queued-1")).toBe(false);
      expect(create).toHaveBeenCalledTimes(1);

      // 下一次外部驱动（`deliver` 在静止态先 `flushInbox` 再叫醒）才把它落地并跑一轮
      agent.deliver({ source: "user", priority: "low", content: "下一段的话" });
      await settled(agent);

      expect(agent.inbox).toHaveLength(0);
      const landed = agent.messages.find((m) => m.id === "host-queued-1")!;
      expect(landed.role).toBe(AgentNS.Role.User);
      expect(landed.content).toBe("收尾钩子里来的");
      expect(create).toHaveBeenCalledTimes(2);
      expect(lastMessage(bodies[1]).content).toBe("下一段的话");
      // 落地顺序按入队顺序：钩子里那条在「下一段的话」之前
      const users = agent.messages.filter((m) => m.role === AgentNS.Role.User).map((m) => m.id);
      expect(users.indexOf("host-queued-1")).toBeLessThan(users.length - 1);
      expect(agent.messages.at(-1)!.content).toBe("收尾钩子里那条也回了");
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Completed);
    });
  });

  describe("条目落地成消息", () => {
    it("source 为 tool 时正文首行是「来源 + 创建时间」的注释", () => {
      const createdAt = "2026-11-15T10:23:04.000Z";
      const content = inboxEntryContent({
        messageId: "m1",
        source: "tool",
        priority: "low",
        content: "后台任务跑完了",
        createdAt,
      });

      expect(typeof content).toBe("string");
      // 首行既有来源也有 ISO 时间（外部通知可能是很久以前发生的，模型得能判时效）
      const firstLine = (content as string).split("\n")[0]!;
      expect(firstLine).toBe("// 这条消息来自 tool 自动推送（2026-11-15T10:23:04.000Z）");
      expect(firstLine).toContain(createdAt);
      // 注释行之后空一行再接正文
      expect(content).toBe(
        "// 这条消息来自 tool 自动推送（2026-11-15T10:23:04.000Z）\n\n后台任务跑完了",
      );
    });

    it("source 为 user 时原样，没有注释行", () => {
      const content = inboxEntryContent({
        messageId: "m2",
        source: "user",
        priority: "high",
        content: "用户原话",
        createdAt: "2026-11-15T10:23:04.000Z",
      });

      expect(content).toBe("用户原话");
      // 用户自己说的话不该被加批注（哪怕只是来源与时间）
      expect(content as string).not.toContain("//");
    });

    it("分段内容：注释作为第一段 text 段插进去，图片段原封不动留着", () => {
      const image: AgentNS.ImageUrlContentSection = {
        type: "image_url",
        image_url: { url: "https://example.com/a.png" },
      };
      const content = inboxEntryContent({
        messageId: "m3",
        source: "tool",
        priority: "high",
        content: [{ type: "text", text: "截图见附件" }, image],
        createdAt: "2026-11-15T10:23:04.000Z",
      });

      expect(Array.isArray(content)).toBe(true);
      const sections = content as AgentNS.MessageContentSection[];
      expect(sections).toHaveLength(3);
      expect(sections[0]).toEqual({
        type: "text",
        text: "// 这条消息来自 tool 自动推送（2026-11-15T10:23:04.000Z）\n\n",
      });
      expect(sections[1]).toEqual({ type: "text", text: "截图见附件" });
      expect(sections[2]).toBe(image);
    });

    it("从 tool 来源落地的消息：正文带注释、id 是投递时那个", async () => {
      const { client } = createRecordingClient([textRound("一")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      // 静止态投递 = 自起一段（段的第一件事就是把队列落成 User 消息）
      const receipt = agent.deliver({
        source: "tool",
        priority: "low",
        content: "异步结果",
        messageId: "host-msg-42",
      });
      expect(receipt.woke).toBe(true);
      await settled(agent);

      const landed = agent.messages.find((m) => m.id === "host-msg-42")!;
      expect(landed.role).toBe(AgentNS.Role.User);
      expect((landed.content as string).split("\n")[0]).toMatch(
        /^\/\/ 这条消息来自 tool 自动推送（[\dT:.Z-]+）$/,
      );
    });
  });

  describe("中止", () => {
    it("一轮中途 abort：不再取件、不再开新圈，inbox 原样保留", async () => {
      const bodies: any[] = [];
      const create = vi.fn(async (body: any, options: any) => {
        bodies.push(body);
        return makeHangingStream(options.signal);
      });
      const client = { chat: { completions: { create } } } as any;

      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });
      agent.append(Message.User("你好"));

      const runPromise = agent.run();
      await new Promise((r) => setTimeout(r, 10));

      // 跑着的时候投两条（真机形态：别的会话投递 / 异步工具结果）
      agent.deliver({ source: "user", priority: "high", content: "高优先那条" });
      agent.deliver({ source: "tool", priority: "low", content: "低优先那条" });
      expect(agent.inbox).toHaveLength(2);

      agent.abort();
      await runPromise;

      // 条目一条都没被取走，也**没有被丢掉**（abort 不再碰 inbox）
      expect(agent.inbox).toHaveLength(2);
      expect(agent.inbox.map((entry) => entry.content)).toEqual(["高优先那条", "低优先那条"]);
      // 没有开新的一圈：只发了一次请求
      expect(create).toHaveBeenCalledTimes(1);
      // 也没有任何 inbox 条目落地（正文里不会出现注释行或排队内容）
      expect(agent.messages.filter((m) => m.role === AgentNS.Role.User)).toHaveLength(1);
      expect(agent.messages.some((m) => JSON.stringify(m.content ?? "").includes("自动推送"))).toBe(
        false,
      );
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Aborted);
      // 收尾走完 = terminated（不是 idle）
      expect(agent.runStatus).toBe("terminated");
    });

    it("轮末被叫停后投来的条目：本轮不再插，也不开外循环", async () => {
      // 真实形态：用户按停的那一刻，恰好有异步工具把结果推进来 —— 那两条属于**下一段**。
      const { client, create } = createRecordingClient([textRound("一"), textRound("二")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      // 只推一次：反复推会让「本该收工」的一轮被无限续起来（那是另一个问题，
      // 这里要盯的是「叫停之后还插不插」）
      agent.use({
        onInnerLoopEnd: once(() => {
          agent.abort();
          agent.deliver({ source: "user", priority: "high", content: "叫停之后来的（高）" });
          agent.deliver({ source: "tool", priority: "low", content: "叫停之后来的（低）" });
        }),
      });

      agent.append(Message.User("你好"));
      await agent.run();

      // 只在第一轮发过一次请求：两条都没被这一轮插进去
      expect(create).toHaveBeenCalledTimes(1);
      expect(agent.messages.filter((m) => m.role === AgentNS.Role.User)).toHaveLength(1);
      // 条目本身不丢，留在 inbox 里等下一次驱动（本轮只是不发）
      expect(agent.inbox).toHaveLength(2);
      expect(agent.runStatus).toBe("terminated");
    });

    it("按停只停段，不删数据：队列原样留着，段落到 terminated", async () => {
      const ctx = gatedClient([textRound("一")]);
      const agent = new Agent({ client: ctx.client, model: "gpt-4" });
      agent.append(Message.User("你好"));
      const running = agent.run();
      await vi.waitFor(() => expect(ctx.create).toHaveBeenCalledTimes(1));

      agent.deliver({ source: "tool", priority: "low", content: "排队的那条" });
      expect(agent.inbox).toHaveLength(1);

      agent.abort();
      expect(agent.runStatus).toBe("stopping");
      // 按停只停段，不删数据
      expect(agent.inbox.map((entry) => entry.content)).toEqual(["排队的那条"]);

      ctx.releases[0]!();
      await running;
      expect(agent.inbox).toHaveLength(1);
      expect(agent.runStatus).toBe("terminated");
    });
  });

  describe("空 inbox", () => {
    it("一轮的行为与改动前一致（请求次数 / 消息条数 / 钩子调用次数）", async () => {
      const { client, create } = createRecordingClient([textRound("你好")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const onInnerLoopsStart = vi.fn();
      const onInnerLoopStart = vi.fn();
      const onInnerLoopEnd = vi.fn();
      const onInnerLoopsEnd = vi.fn();
      agent.use({ onInnerLoopsStart, onInnerLoopStart, onInnerLoopEnd, onInnerLoopsEnd });

      await agent.send("hi");

      expect(create).toHaveBeenCalledTimes(1);
      // system + user + assistant
      expect(agent.messages).toHaveLength(3);
      expect(agent.messages.at(-1)!.content).toBe("你好");
      expect(onInnerLoopsStart).toHaveBeenCalledTimes(1);
      expect(onInnerLoopStart).toHaveBeenCalledTimes(1);
      expect(onInnerLoopEnd).toHaveBeenCalledTimes(1);
      expect(onInnerLoopsEnd).toHaveBeenCalledTimes(1);
      expect(agent.inbox).toHaveLength(0);
    });
  });

  describe("顺序", () => {
    it("多条 high 按入队顺序插入；high 与 low 混排时 high 先落地", async () => {
      const { client, create, bodies } = createRecordingClient([
        textRound("一"),
        textRound("二"),
        textRound("三"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.use({
        onInnerLoopEnd: once(() => {
          agent.deliver({ source: "user", priority: "high", content: "高-1" });
          agent.deliver({ source: "user", priority: "high", content: "高-2" });
          agent.deliver({ source: "user", priority: "low", content: "低-1" });
          agent.deliver({ source: "user", priority: "high", content: "高-3" });
        }),
      });

      agent.append(Message.User("开始"));
      await agent.run();

      // ①第一轮停下 → 插三条 high → ②第二轮停下 → 插一条 low → ③第三轮
      expect(create).toHaveBeenCalledTimes(3);

      const landed = agent.messages
        .filter((m) => m.role === AgentNS.Role.User)
        .map((m) => m.content);
      expect(landed).toEqual(["开始", "高-1", "高-2", "高-3", "低-1"]);

      // 第二次请求里已经有三条 high（入队顺序原样），low 那条还没出现
      expect(
        bodies[1].messages
          .filter((m: any) => m.role === AgentNS.Role.User)
          .map((m: any) => m.content),
      ).toEqual(["开始", "高-1", "高-2", "高-3"]);
      // 第三次请求里才轮到 low
      expect(lastMessage(bodies[2]).content).toBe("低-1");
    });
  });

  describe("messageId", () => {
    it("落地那条消息的 id 等于投递时给的那个", async () => {
      const { client } = createRecordingClient([textRound("一"), textRound("二")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      let receipt: AgentNS.DeliveryReceipt | undefined;
      agent.use({
        onInnerLoopEnd: once(() => {
          receipt = agent.deliver({
            source: "user",
            priority: "high",
            content: "客户端已经在画这一条了",
            messageId: "client-side-uuid",
          });
        }),
      });

      agent.append(Message.User("你好"));
      await agent.run();

      expect(receipt!.messageId).toBe("client-side-uuid");
      const landed = agent.messages.find((m) => m.id === "client-side-uuid")!;
      expect(landed).toBeDefined();
      expect(landed.content).toBe("客户端已经在画这一条了");
    });
  });
});
