/**
 * `applyChunk` —— 一片 chunk 攒进消息的那些规则。
 *
 * 这些断言以前散在 `Agent` 的端到端用例里（只能通过「最终消息长什么样」间接看），
 * 抽取成独立函数之后直接对着它测：规则一旦漂，先在这里红，而不是等某个客户端攒出来的
 * 对象与服务端那份不一致。
 *
 * 假件照抄真件的形状（`id` / `object` / `created` / `model` / `choices[].index` /
 * `delta` / `finish_reason`）：只喂一个 `{choices:[{delta}]}` 的瘦身对象，测的就是想象。
 */

import { describe, expect, it } from "vitest";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { applyChunk } from "./applyChunk.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";

function chunk(delta: any, finish_reason: any = null, extra: Record<string, unknown> = {}) {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  } as unknown as ChatCompletionChunk;
}

/** 一条正在拼的 assistant 消息（`Agent.run` 内循环开头 append 的那种） */
function receiver() {
  return Message.Assistant();
}

describe("applyChunk：正文", () => {
  it("逐片追加，拼出完整一句", () => {
    const message = receiver();
    for (const text of ["你", "好", "！"]) applyChunk(message, chunk({ content: text }));
    expect(message.content).toBe("你好！");
  });

  it("不带内容的片（只有外层字段）不动正文", () => {
    const message = receiver();
    applyChunk(message, chunk({ content: "开头" }));
    applyChunk(message, chunk({}));
    expect(message.content).toBe("开头");
  });

  it("已经带了内容的 receiver 是**继续接**，不是重置", () => {
    const message = Message.Assistant("已有");
    applyChunk(message, chunk({ content: "续" }));
    expect(message.content).toBe("已有续");
  });
});

describe("applyChunk：推理内容", () => {
  it("`reasoning_content` 累加到同一个字段", () => {
    const message = receiver();
    applyChunk(message, chunk({ reasoning_content: "想一" }));
    applyChunk(message, chunk({ reasoning_content: "想" }));
    expect(message.reasoning_content).toBe("想一想");
    expect(message.content).toBe("");
  });
});

describe("applyChunk：内容段数组（视觉 / 多段）", () => {
  /**
   * 分段流的形状是「首片声明这一段（只有 `index`，不带 `text`），后续片才带正文」。
   *
   * 首片就带 `text` 的形状今天会被拼两遍（`...deltaSection` 已经把值放进去，后面又 `+=`
   * 一次）—— 那是本函数从 `Agent.parseStreamData` 原样搬过来时就有的行为，没有在这次
   * 抽取里改；仓库里没有任何一处会发出这种形状（`testing` 的假模型只发字符串 delta）。
   */
  it("按 `index` 分段累加文本", () => {
    const message = receiver();
    applyChunk(message, chunk({ content: [{ index: 0, type: "text" }] }));
    applyChunk(message, chunk({ content: [{ index: 0, text: "前半" }] }));
    applyChunk(message, chunk({ content: [{ index: 0, text: "后半" }] }));
    expect(message.content).toEqual([{ index: 0, type: "text", text: "前半后半" }]);
  });
});

describe("applyChunk：工具调用", () => {
  it("首片给名字与 id，后续片续参数", () => {
    const message = receiver();
    applyChunk(
      message,
      chunk({
        tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }],
      }),
    );
    applyChunk(message, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }));
    applyChunk(message, chunk({ tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] }));

    const call = message.tool_calls![0];
    expect(call.id).toBe("call_1");
    expect(call.function!.name).toBe("read");
    expect(call.function!.arguments).toBe('{"path":"a.ts"}');
  });

  it("参数串**整段重发**时不重复拼接（本次串以已攒的为前缀 → 替换）", () => {
    const message = receiver();
    applyChunk(message, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }));
    applyChunk(message, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }));
    expect(message.tool_calls![0].function!.arguments).toBe('{"a":1}');
  });

  it("并行调用按 `index` 分开攒", () => {
    const message = receiver();
    applyChunk(message, chunk({ tool_calls: [{ index: 0, function: { name: "read" } }] }));
    applyChunk(message, chunk({ tool_calls: [{ index: 1, function: { name: "exec" } }] }));
    expect(message.tool_calls!.map((call) => call.function!.name)).toEqual(["read", "exec"]);
  });
});

describe("applyChunk：旧的 function_call 形状", () => {
  it("名字与参数各续各的", () => {
    const message = receiver();
    // 首片只带名字（与 `tool_calls` 的 `startsWith` 分支不同，这里没有「整串重发」的判据，
    // 所以首片若同时带 `arguments` 会被拼两遍 —— 同样是原样搬过来的既有行为）
    applyChunk(message, chunk({ function_call: { name: "getTime" } }));
    applyChunk(message, chunk({ function_call: { arguments: "{" } }));
    applyChunk(message, chunk({ function_call: { arguments: "}" } }));
    expect(message.function_call).toEqual({ name: "getTime", arguments: "{}" });
  });
});

describe("applyChunk：流末的用量与结束原因", () => {
  it("`usage` 与 `finish_reason` 钉在本条消息上", () => {
    const message = receiver();
    applyChunk(
      message,
      chunk({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
    );
    expect(message.finish_reason).toBe(AgentNS.FinishReason.Stop);
    expect(message.usage?.completion_tokens).toBe(5);
  });

  it("只有 usage、没有 choices 的片（部分端点如此）照样收下用量", () => {
    const message = receiver();
    applyChunk(message, {
      id: "chunk-2",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    } as unknown as ChatCompletionChunk);
    expect(message.usage?.completion_tokens).toBe(2);
  });
});
