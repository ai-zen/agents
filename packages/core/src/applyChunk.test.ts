/**
 * `applyChunk` —— 一片增量攒进消息的那些规则。
 *
 * 这些断言以前散在 `Agent` 的端到端用例里（只能通过「最终消息长什么样」间接看），
 * 抽取成独立函数之后直接对着它测：规则一旦漂，先在这里红，而不是等某个客户端攒出来的
 * 对象与服务端那份不一致。
 *
 * 入参就是**那一片增量本身**（core 的 `AgentNS.Delta`），不包任何外壳：事件载荷里是它，
 * 厂商 chunk 的 `choices[0].delta` 也是它。所以这里造片也只造这一个形状 —— 包一层
 * `{ choices: [{ delta }] }` 再喂进来，测的就是搬运而不是规则。
 *
 * 关于 `any`：一片增量里「首片只声明 `index`、后续片才带正文」那种段（`{ index: 0, type: "text" }`）
 * 在 `Delta` 的类型上是不完整的（`TextContentSection` 要求 `text`），真实流里却合法 ——
 * 用例要钉的正是运行期这两种形状都认，所以片按 `any` 造、只把结果按 `Delta` 交出去。
 */

import { describe, expect, it } from "vitest";
import { applyChunk } from "./applyChunk.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";

/** 一片增量（`AgentNS.Delta`）—— 不包 `choices`，它就是流里那一片本身 */
function delta(value: any = {}): AgentNS.Delta {
  return value as AgentNS.Delta;
}

/** 一条正在拼的 assistant 消息（`Agent.run` 内循环开头 append 的那种） */
function receiver() {
  return Message.Assistant();
}

describe("applyChunk：正文", () => {
  it("逐片追加，拼出完整一句", () => {
    const message = receiver();
    for (const text of ["你", "好", "！"]) applyChunk(message, delta({ content: text }));
    expect(message.content).toBe("你好！");
  });

  it("什么都不带的片不动正文", () => {
    const message = receiver();
    applyChunk(message, delta({ content: "开头" }));
    applyChunk(message, delta({}));
    expect(message.content).toBe("开头");
  });

  it("已经带了内容的 receiver 是**继续接**，不是重置", () => {
    const message = Message.Assistant("已有");
    applyChunk(message, delta({ content: "续" }));
    expect(message.content).toBe("已有续");
  });
});

describe("applyChunk：推理内容", () => {
  it("`reasoning_content` 累加到同一个字段", () => {
    const message = receiver();
    applyChunk(message, delta({ reasoning_content: "想一" }));
    applyChunk(message, delta({ reasoning_content: "想" }));
    expect(message.reasoning_content).toBe("想一想");
    expect(message.content).toBe("");
  });
});

describe("applyChunk：内容段数组（视觉 / 多段）", () => {
  /**
   * 分段流的形状是「首片声明这一段（只有 `index`，不带 `text`），后续片才带正文」。
   *
   * 首片就带正文的形状也要对：首片**只放声明字段**、正文一律走 `+=` —— 两件都做的话
   * （先 `...deltaSection` 再 `+=`）首片自带的 `"A"` 会变成 `"AA"`。
   */
  it("按 `index` 分段累加文本", () => {
    const message = receiver();
    applyChunk(message, delta({ content: [{ index: 0, type: "text" }] }));
    applyChunk(message, delta({ content: [{ index: 0, text: "前半" }] }));
    applyChunk(message, delta({ content: [{ index: 0, text: "后半" }] }));
    expect(message.content).toEqual([{ index: 0, type: "text", text: "前半后半" }]);
  });

  it('首片自带正文：只算一遍（`"A"` 不会变成 `"AA"`）', () => {
    const message = receiver();
    applyChunk(message, delta({ content: [{ index: 0, type: "text", text: "A" }] }));
    applyChunk(message, delta({ content: [{ index: 0, text: "B" }] }));
    expect(message.content).toEqual([{ index: 0, type: "text", text: "AB" }]);
  });

  it("首片带 `image_url`：`url` 就是那个字符串，不是 `[object Object]…`", () => {
    const message = receiver();
    applyChunk(
      message,
      delta({
        content: [{ index: 0, type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      }),
    );
    expect(message.content).toEqual([
      { index: 0, type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });

  it("一片带两个内容段：两段都在，顺序按 `index`（不是只看第 0 个）", () => {
    const message = receiver();
    applyChunk(
      message,
      delta({
        content: [
          { index: 0, type: "text", text: "先看图" },
          { index: 1, type: "image_url", image_url: { url: "https://example.com/b.png" } },
        ],
      }),
    );
    expect(message.content).toEqual([
      { index: 0, type: "text", text: "先看图" },
      { index: 1, type: "image_url", image_url: { url: "https://example.com/b.png" } },
    ]);
  });

  it("已是段数组时来了字符串 delta：已有段不丢，新内容自己成一段 text", () => {
    const message = receiver();
    applyChunk(message, delta({ content: [{ index: 0, type: "text", text: "已有" }] }));
    applyChunk(message, delta({ content: "后来又一句" }));
    expect(message.content).toEqual([
      { index: 0, type: "text", text: "已有" },
      { type: "text", text: "后来又一句" },
    ]);
  });
});

describe("applyChunk：工具调用", () => {
  it("首片给名字与 id，后续片续参数", () => {
    const message = receiver();
    applyChunk(
      message,
      delta({
        tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }],
      }),
    );
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }));
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] }));

    const call = message.tool_calls![0];
    expect(call.id).toBe("call_1");
    expect(call.function!.name).toBe("read");
    expect(call.function!.arguments).toBe('{"path":"a.ts"}');
  });

  it("参数串**整段重发**时不重复拼接（本次串以已攒的为前缀 → 替换）", () => {
    const message = receiver();
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }));
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }));
    expect(message.tool_calls![0].function!.arguments).toBe('{"a":1}');
  });

  it("首片只给名字（没有 `arguments`），后续片续参数：不能拼出 `undefined{...}`", () => {
    const message = receiver();
    applyChunk(
      message,
      delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "write" } }] }),
    );
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }));
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] }));

    const call = message.tool_calls![0];
    expect(call.function!.name).toBe("write");
    expect(call.function!.arguments).toBe('{"path":"a.ts"}');
  });

  it("厂商显式给 `arguments: undefined` 也当没给", () => {
    const message = receiver();
    applyChunk(
      message,
      delta({ tool_calls: [{ index: 0, function: { name: "read", arguments: undefined } }] }),
    );
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }));

    expect(message.tool_calls![0].function!.arguments).toBe("{}");
  });

  it("并行调用按 `index` 分开攒", () => {
    const message = receiver();
    applyChunk(message, delta({ tool_calls: [{ index: 0, function: { name: "read" } }] }));
    applyChunk(message, delta({ tool_calls: [{ index: 1, function: { name: "exec" } }] }));
    expect(message.tool_calls!.map((call) => call.function!.name)).toEqual(["read", "exec"]);
  });

  it("一片带两个调用：两个都在，按 `index` 归位（不是只看第 0 个）", () => {
    const message = receiver();
    applyChunk(
      message,
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"p":1}' },
          },
          {
            index: 1,
            id: "call_2",
            type: "function",
            function: { name: "exec", arguments: '{"cmd":"ls"}' },
          },
        ],
      }),
    );

    expect(message.tool_calls!.map((call) => call.id)).toEqual(["call_1", "call_2"]);
    expect(message.tool_calls!.map((call) => call.function!.name)).toEqual(["read", "exec"]);
    expect(message.tool_calls!.map((call) => call.function!.arguments)).toEqual([
      '{"p":1}',
      '{"cmd":"ls"}',
    ]);
  });
});

describe("applyChunk：旧的 function_call 形状", () => {
  it("名字与参数各续各的", () => {
    const message = receiver();
    // 首片只带名字（与 `tool_calls` 的 `startsWith` 分支不同，这里没有「整串重发」的判据，
    // 所以首片若同时带 `arguments` 会被拼两遍 —— 同样是原样搬过来的既有行为）
    applyChunk(message, delta({ function_call: { name: "getTime" } }));
    applyChunk(message, delta({ function_call: { arguments: "{" } }));
    applyChunk(message, delta({ function_call: { arguments: "}" } }));
    expect(message.function_call).toEqual({ name: "getTime", arguments: "{}" });
  });
});
