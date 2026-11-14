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

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

describe("Agent.inbox", () => {
  describe("pushInbox / clearInbox", () => {
    it("缺 id 与时间时就地补齐，入队并返回完整条目", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });

      const entry = agent.pushInbox({ source: "user", priority: "high", content: "插一句" });

      expect(entry.messageId).toBeTruthy();
      expect(typeof entry.createdAt).toBe("string");
      // ISO 8601：能被 Date 解回一个有限时刻
      expect(Number.isFinite(Date.parse(entry.createdAt))).toBe(true);
      expect(agent.inbox).toHaveLength(1);
      expect(agent.inbox[0]).toBe(entry);
    });

    it("传了 messageId 就用传的那个", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });

      const entry = agent.pushInbox({
        source: "tool",
        priority: "low",
        content: "工具结果",
        messageId: "host-msg-1",
      });

      expect(entry.messageId).toBe("host-msg-1");
    });

    it("推完广播 inbox 事件，载荷带 agent 与 entry", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });

      const seen: InboxContext[] = [];
      agent.events.on("inbox", (ctx: InboxContext) => seen.push(ctx));

      const entry = agent.pushInbox({ source: "user", priority: "low", content: "排队" });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.agent).toBe(agent);
      expect(seen[0]!.entry).toBe(entry);
    });

    it("clearInbox 清空并返回被丢掉的条目", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      const a = agent.pushInbox({ source: "user", priority: "high", content: "A" });
      const b = agent.pushInbox({ source: "tool", priority: "low", content: "B" });

      const dropped = agent.clearInbox();

      expect(dropped).toEqual([a, b]);
      expect(agent.inbox).toHaveLength(0);
    });

    it("清空后 inbox 仍是同一个数组实例（外部快照不会指向一份死队列）", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      const snapshot = agent.inbox;
      agent.pushInbox({ source: "user", priority: "high", content: "A" });

      agent.clearInbox();

      expect(agent.inbox).toBe(snapshot);
      expect(snapshot).toHaveLength(0);
    });
  });

  describe("run - 高优先级插入点（内循环末尾）", () => {
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

      agent.append(Message.User("现在几点"));
      const entry = agent.pushInbox({ source: "user", priority: "high", content: "顺便看下时区" });

      await agent.run();

      // 第一轮 tool_calls → 工具结果 → 插入 User → 第二轮
      expect(create).toHaveBeenCalledTimes(2);

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
      expect(landed[1]!.id).toBe(entry.messageId);
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

      agent.append(Message.User("开始"));
      agent.pushInbox({ source: "user", priority: "high", content: "插一句" });

      await agent.run();

      expect(create).toHaveBeenCalledTimes(3);
      // 第一次请求里没有它，第二次请求（工具跑完那一圈之后）里就有了
      expect(messagesOfRole(bodies[0], AgentNS.Role.User)).toHaveLength(1);
      expect(messagesOfRole(bodies[1], AgentNS.Role.User)).toHaveLength(2);
      expect(lastMessage(bodies[1]).content).toBe("插一句");
    });
  });

  describe("run - 低优先级插入点（外循环末尾）", () => {
    it("agent 停下之后插入，并再跑一轮", async () => {
      const { client, create, bodies } = createRecordingClient([
        textRound("第一轮说完了"),
        textRound("第二轮说完了"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.append(Message.User("你好"));
      agent.pushInbox({ source: "user", priority: "low", content: "还有一件事" });

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

    it("工具轮停下之后 low 也会插入（插入点在 reconcile* 之后）", async () => {
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

      agent.append(Message.User("开始"));
      agent.pushInbox({ source: "tool", priority: "low", content: "异步工具结果" });

      await agent.run();

      // ①②工具轮 + ③被 low 续起来的最后一轮
      expect(create).toHaveBeenCalledTimes(3);
      expect(lastMessage(bodies[2]).content).toBe("// 这条消息来自 tool 自动推送\n\n异步工具结果");
    });
  });

  describe("收尾钩子之后的取件点（整组的最后一个取件点）", () => {
    it("onInnerLoopsEnd 里入队的条目照样落地，并进下一次请求", async () => {
      // 真实形态：插件在整组收尾钩子里问用户（SDK 的 `AutoMigratePlugin` 就干这个），
      // 用户在那一段时间里说的话通过 `pushInbox` 进来 —— 它属于**这一轮**。
      //
      // 这一条故意走 `run()`（不是 `send()`）：`run()` 末尾那个取件点是它唯一的救命人，
      // 去掉那个取件点它就红 —— 于是两道防线各有一条用例自己盯着。
      const { client, create, bodies } = createRecordingClient([
        textRound("第一轮说完了"),
        textRound("钩子里那两条也回了"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const onInnerLoopsStart = vi.fn();
      const onInnerLoopsEnd = vi.fn();
      let low: AgentNS.InboxEntry | undefined;
      let high: AgentNS.InboxEntry | undefined;
      agent.use({
        onInnerLoopsStart,
        onInnerLoopsEnd: (ctx) => {
          onInnerLoopsEnd();
          low = ctx.agent.pushInbox({ source: "user", priority: "low", content: "钩子里来的（低）" });
          high = ctx.agent.pushInbox({ source: "tool", priority: "high", content: "钩子里来的（高）" });
        },
      });

      // `run()` 的收尾同样只把整组首尾两个钩子各发一次（不是每圈一次）
      agent.append(Message.User("你好"));
      await agent.run();

      // 取件点挪到钩子之后，但钩子本身仍是一次 send 各一次（不是每圈一次）
      expect(onInnerLoopsStart).toHaveBeenCalledTimes(1);
      expect(onInnerLoopsEnd).toHaveBeenCalledTimes(1);

      // ① 两条都落成了 User 消息：不是留在 inbox 里等一个不会再来的取件者
      expect(agent.inbox).toHaveLength(0);
      const landedIds = agent.messages.map((m) => m.id);
      expect(landedIds).toContain(low!.messageId);
      expect(landedIds).toContain(high!.messageId);
      const landedUser = agent.messages
        .filter((m) => m.role === AgentNS.Role.User)
        .map((m) => m.content);
      expect(landedUser.slice(1)).toEqual([
        "钩子里来的（低）",
        "// 这条消息来自 tool 自动推送\n\n钩子里来的（高）",
      ]);

      // ② 真的多跑了一轮请求，且第二请求里两条都在（按入队顺序，先低后高）
      expect(create).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(bodies[0].messages)).not.toContain("钩子里来的");
      expect(
        messagesOfRole(bodies[1], AgentNS.Role.User).map((m: any) => m.content),
      ).toEqual([
        "你好",
        "钩子里来的（低）",
        "// 这条消息来自 tool 自动推送\n\n钩子里来的（高）",
      ]);
    });

    it("onAfterSend 里入队的条目也落地：send() 返回时这一轮真的结束了", async () => {
      const { client, create, bodies } = createRecordingClient([
        textRound("这一轮说完了"),
        textRound("收尾钩子里那条也回了"),
      ]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      const onInnerLoopsEnd = vi.fn();
      const onAfterSend = vi.fn();
      let entry: AgentNS.InboxEntry | undefined;
      agent.use({
        onInnerLoopsEnd,
        onAfterSend: (ctx) => {
          onAfterSend();
          entry = ctx.agent.pushInbox({
            source: "user",
            priority: "low",
            content: "收尾钩子里来的",
            messageId: "host-queued-1",
          });
        },
      });

      const messages = await agent.send("你好");

      // `onAfterSend` 一次 send 一次；整组收尾钩子也没有因为续圈被重发
      expect(onAfterSend).toHaveBeenCalledTimes(1);
      expect(onInnerLoopsEnd).toHaveBeenCalledTimes(1);

      // 落地：id 就是入队时定的那个（宿主已经把它回过客户端了），inbox 取空
      expect(agent.inbox).toHaveLength(0);
      expect(entry!.messageId).toBe("host-queued-1");
      const landed = messages.find((m) => m.id === "host-queued-1")!;
      expect(landed).toBeDefined();
      expect(landed.role).toBe(AgentNS.Role.User);
      expect(landed.content).toBe("收尾钩子里来的");

      // 并且真的为它跑了一轮：第二次请求里最后一条用户消息就是它，回来的是第二轮那句话
      expect(create).toHaveBeenCalledTimes(2);
      expect(lastMessage(bodies[1]).role).toBe(AgentNS.Role.User);
      expect(lastMessage(bodies[1]).content).toBe("收尾钩子里来的");
      expect(messages.at(-1)!.content).toBe("收尾钩子里那条也回了");
      expect(messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Completed);
    });
  });

  describe("条目落地成消息", () => {
    it("source 为 tool 时正文首行是来源注释", () => {
      const content = inboxEntryContent({
        messageId: "m1",
        source: "tool",
        priority: "low",
        content: "后台任务跑完了",
        createdAt: new Date().toISOString(),
      });

      expect(typeof content).toBe("string");
      expect((content as string).split("\n")[0]).toBe("// 这条消息来自 tool 自动推送");
      // 注释行之后空一行再接正文
      expect(content).toBe("// 这条消息来自 tool 自动推送\n\n后台任务跑完了");
    });

    it("source 为 user 时原样，没有注释行", () => {
      const content = inboxEntryContent({
        messageId: "m2",
        source: "user",
        priority: "high",
        content: "用户原话",
        createdAt: new Date().toISOString(),
      });

      expect(content).toBe("用户原话");
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
        createdAt: new Date().toISOString(),
      });

      expect(Array.isArray(content)).toBe(true);
      const sections = content as AgentNS.MessageContentSection[];
      expect(sections).toHaveLength(3);
      expect(sections[0]).toEqual({
        type: "text",
        text: "// 这条消息来自 tool 自动推送\n\n",
      });
      expect(sections[1]).toEqual({ type: "text", text: "截图见附件" });
      expect(sections[2]).toBe(image);
    });

    it("从 tool 来源落地的消息：正文带注释、id 是入队时那个", async () => {
      const { client } = createRecordingClient([textRound("一"), textRound("二")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.append(Message.User("你好"));
      agent.pushInbox({
        source: "tool",
        priority: "low",
        content: "异步结果",
        messageId: "host-msg-42",
      });

      await agent.run();

      const landed = agent.messages.find((m) => m.id === "host-msg-42")!;
      expect(landed.role).toBe(AgentNS.Role.User);
      expect((landed.content as string).split("\n")[0]).toBe("// 这条消息来自 tool 自动推送");
    });
  });

  describe("中止", () => {
    it("一轮中途 abort：inbox 清空、不再插入、不再开外循环", async () => {
      const bodies: any[] = [];
      const create = vi.fn(async (body: any, options: any) => {
        bodies.push(body);
        return makeHangingStream(options.signal);
      });
      const client = { chat: { completions: { create } } } as any;

      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });
      agent.append(Message.User("你好"));
      agent.pushInbox({ source: "user", priority: "high", content: "高优先那条" });
      agent.pushInbox({ source: "tool", priority: "low", content: "低优先那条" });

      const runPromise = agent.run();
      await new Promise((r) => setTimeout(r, 30));
      agent.abort();
      await runPromise;

      // 一条都没发出去，排队的东西全被丢掉
      expect(agent.inbox).toHaveLength(0);
      // 没有开新的一圈：只发了一次请求
      expect(create).toHaveBeenCalledTimes(1);
      // 也没有任何 inbox 条目落地（正文里不会出现注释行或排队内容）
      expect(agent.messages.filter((m) => m.role === AgentNS.Role.User)).toHaveLength(1);
      expect(agent.messages.some((m) => JSON.stringify(m.content ?? "").includes("自动推送"))).toBe(
        false,
      );
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Aborted);
    });

    it("轮末被叫停后推来的条目：本轮不再插，也不开外循环", async () => {
      // 真实形态：用户按停的那一刻，恰好有异步工具把结果推进来 —— abort 已经清过一轮，
      // 这条是清完之后才到的，所以「不再插」只能靠这一轮自己的判据挡住。
      const { client, create } = createRecordingClient([textRound("一"), textRound("二")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      // 只推一次：反复推会让「本该收工」的一轮被无限续起来（那是另一个问题，
      // 这里要盯的是「叫停之后还插不插」）
      let pushed = false;
      agent.use({
        onInnerLoopEnd: (ctx) => {
          if (pushed) return;
          pushed = true;
          ctx.agent.abort();
          ctx.agent.pushInbox({ source: "user", priority: "high", content: "叫停之后来的（高）" });
          ctx.agent.pushInbox({ source: "tool", priority: "low", content: "叫停之后来的（低）" });
        },
      });

      agent.append(Message.User("你好"));
      await agent.run();

      // 只在第一轮发过一次请求：两条都没被这一轮插进去
      expect(create).toHaveBeenCalledTimes(1);
      expect(agent.messages.filter((m) => m.role === AgentNS.Role.User)).toHaveLength(1);
      // 条目本身不丢，留在 inbox 里等下一轮（本轮只是不发）
      expect(agent.inbox).toHaveLength(2);
    });

    it("run 结束阶段的 abort 不会带到下一轮：下一次 run 照常干完活", async () => {
      const { client, create } = createRecordingClient([textRound("一次")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.append(Message.User("你好"));
      // 没在跑的时候按停：只清 inbox，不给下一轮留情绪
      agent.abort();

      agent.pushInbox({ source: "user", priority: "low", content: "下一轮再发" });
      await agent.run();

      expect(create).toHaveBeenCalledTimes(2);
      expect(agent.inbox).toHaveLength(0);
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

      agent.append(Message.User("开始"));
      agent.pushInbox({ source: "user", priority: "high", content: "高-1" });
      agent.pushInbox({ source: "user", priority: "high", content: "高-2" });
      agent.pushInbox({ source: "user", priority: "low", content: "低-1" });
      agent.pushInbox({ source: "user", priority: "high", content: "高-3" });

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
    it("落地那条消息的 id 等于入队时给的那个", async () => {
      const { client } = createRecordingClient([textRound("一"), textRound("二")]);
      const agent = new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });

      agent.append(Message.User("你好"));
      const entry = agent.pushInbox({
        source: "user",
        priority: "high",
        content: "客户端已经在画这一条了",
        messageId: "client-side-uuid",
      });

      await agent.run();

      const landed = agent.messages.find((m) => m.content === entry.content)!;
      expect(landed).toBeDefined();
      expect(landed.id).toBe("client-side-uuid");
    });
  });
});
