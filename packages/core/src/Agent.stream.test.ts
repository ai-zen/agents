/**
 * 一条**真**的流式请求：真 `openai` SDK → 真 HTTP → 真 SSE 解析。
 *
 * 本包其余用例都用 `createMockClient([[chunk({ content: "…" }), stopChunk()]])`（手捏
 * chunk 数组），那是对的：它们要隔离的正是传输。但那条隔离有一个代价 —— `Agent` 把每片
 * 广播成 `events.emit("chunk-parsed", receiver, chunk)`，而这个**两参**契约在 core 里
 * 没有任何测试看着（大家只断言 `agent.messages` 的内容）。于是服务端按单参去读也照样
 * 过编译、照样绿，直到用假端点跑端到端才发现正文增量一条都推不出去。
 *
 * 所以这一条专门钉住那个出口：断言监听器**收到了什么**，而不是最终消息长什么样。
 */

import { afterEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";

const REPLY = "这是假模型分片发出来的答复。";

let llm: FakeLlm | null = null;

afterEach(async () => {
  await llm?.close();
  llm = null;
});

/** 造一个真的 `openai` 客户端，指向假端点（key 是假的，请求根本到不了真厂商） */
async function startAgent(): Promise<{ agent: Agent; llm: FakeLlm }> {
  const fake = await startFakeLlm({ reply: REPLY, chunks: 3, usage: { prompt: 12, completion: 5 } });
  llm = fake;
  const client = new OpenAI({ apiKey: "sk-fake", baseURL: fake.baseUrl });
  const agent = new Agent({
    client,
    model: "fake-model",
    messages: [Message.System("你是一个助手")],
  });
  return { agent, llm: fake };
}

describe("Agent：真流式（真 SDK + 假端点）", () => {
  it("`chunk-parsed` 是**两参**：第一个是正在拼的 assistant 消息，第二个才是原始 chunk", async () => {
    const { agent, llm: fake } = await startAgent();

    const seen: Array<{ receiver: any; chunk: any }> = [];
    agent.events.on("chunk-parsed", (receiver: any, chunk: any) => {
      seen.push({ receiver, chunk });
    });

    agent.append(Message.User("你好"));
    await agent.run();

    // 每片一次广播：首片带 role、中间 3 片带正文、末片带 finish_reason/usage
    expect(seen.length).toBeGreaterThan(1);
    for (const { receiver, chunk } of seen) {
      // 第一参：那条正在拼的消息（消费方要它才知道「拼到哪条上」）
      expect(receiver.role).toBe(AgentNS.Role.Assistant);
      // 第二参：**原始 chunk**（`choices[0].delta` 就在这一层）
      expect(chunk.choices?.[0]?.delta).toBeTypeOf("object");
    }
    // 正文确实是一片片来的，而不是收尾时一次性给的
    const pieces = seen.filter(({ chunk }) => chunk.choices?.[0]?.delta?.content);
    expect(pieces.length).toBe(3);
    expect(pieces.map(({ chunk }) => chunk.choices[0].delta.content).join("")).toBe(REPLY);

    // 收尾那片带着 `stream_options.include_usage` 要来的真实用量
    const last = seen.at(-1)!.chunk;
    expect(last.choices?.[0]?.finish_reason).toBe("stop");
    expect(last.usage?.completion_tokens).toBe(5);

    // 最后消息：正文拼齐、标记完成、用量落在消息上（状态栏与计费都读它）
    const assistant = agent.messages.at(-1)!;
    expect(assistant.content).toBe(REPLY);
    expect(assistant.status).toBe(AgentNS.MessageStatus.Completed);
    expect(assistant.usage?.completion_tokens).toBe(5);
    expect(agent.lastUsage?.prompt_tokens).toBe(12);
  });

  it("请求体确实是流式的：`stream: true` + `stream_options.include_usage`（框架自己保证的那两项）", async () => {
    const { agent, llm: fake } = await startAgent();

    agent.append(Message.User("你好"));
    await agent.run();

    const body = fake.requests.at(-1)!.body;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("fake-model");
  });
});
