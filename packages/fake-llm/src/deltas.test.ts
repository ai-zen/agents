/**
 * 「从一InboxEntry标消息倒推出分片序列」这一件事本身的用例。
 *
 * 这里不看网络：入参是目标消息，出参是增量数组，断言落在「哪一片带了什么」上。
 * 带工具调用与思考的那种消息只有在这一层才看得清 —— 走一遍 HTTP 之后能看到的只是
 * SSE 帧的外壳，外壳一样、里面拼错了照样绿。
 */

import { describe, expect, it } from "vitest";

import { buildDeltas, cutText, splitReply } from "./index.js";
import type { FakeLlmDelta, FakeLlmMessage } from "./index.js";

/** 一片一片地看「正文」 */
function contentPieces(deltas: FakeLlmDelta[]): string[] {
  return deltas.flatMap((delta) => (typeof delta.content === "string" ? [delta.content] : []));
}

/** 每一片怎么读：思考 / 工具调用 / 正文，按发出顺序 */
function kindsOf(deltas: FakeLlmDelta[]): string[] {
  return deltas.map((delta) => {
    if (delta.reasoning_content !== undefined) return `思考:${delta.reasoning_content}`;
    if (delta.tool_calls !== undefined) return `工具:${JSON.stringify(delta.tool_calls)}`;
    const content = delta.content;
    return `正文:${typeof content === "string" ? content : JSON.stringify(content)}`;
  });
}

describe("buildDeltas：正文", () => {
  it("按片数均分正文，拼回去一字不差", () => {
    const deltas = buildDeltas({ content: "一二三四五六七八" }, { chunks: 4 });
    expect(contentPieces(deltas)).toEqual(["一二", "三四", "五六", "七八"]);
    expect(contentPieces(deltas).join("")).toBe("一二三四五六七八");
  });

  it("chunkSize 优先于 chunks，切的是字符数", () => {
    const deltas = buildDeltas({ content: "abcdefg" }, { chunks: 2, chunkSize: 3 });
    expect(contentPieces(deltas)).toEqual(["abc", "def", "g"]);
  });

  it("正文是内容块数组时按块发，每块带自己的 index", () => {
    const deltas = buildDeltas({
      content: [
        { type: "text", text: "看这张" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    });
    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.content).toEqual([{ index: 0, type: "text", text: "看这张" }]);
    expect(deltas[1]!.content).toEqual([
      { index: 1, type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });
});

describe("buildDeltas：工具调用", () => {
  it("第一片带 index / id / name，参数原样切开、拼起来等于原文", () => {
    const args = '{"path":"a.txt","limit":10}';
    const deltas = buildDeltas(
      { tool_calls: [{ id: "call_abc", function: { name: "read_file", arguments: args } }] },
      { chunkSize: 7 },
    );

    const calls = deltas.flatMap((delta) => delta.tool_calls ?? []);
    expect(calls[0]).toEqual({
      index: 0,
      id: "call_abc",
      type: "function",
      function: { name: "read_file", arguments: "" },
    });
    // 之后每片只有参数，没有 id 也没有函数名
    for (const call of calls.slice(1)) {
      expect(call.index).toBe(0);
      expect(call.id).toBeUndefined();
      expect(call.function?.name).toBeUndefined();
    }
    expect(
      calls
        .slice(1)
        .map((call) => call.function!.arguments)
        .join(""),
    ).toBe(args);
    // 切开只是切，不改写：分片数大于 1 才叫增量
    expect(calls.length).toBeGreaterThan(2);
  });

  it("并行工具调用按 index 归位，各自带自己的 id 与函数名", () => {
    const deltas = buildDeltas({
      tool_calls: [
        { id: "call_1", function: { name: "read_file", arguments: '{"path":"a"}' } },
        { id: "call_2", function: { name: "read_file", arguments: '{"path":"b"}' } },
      ],
    });

    const calls = deltas.flatMap((delta) => delta.tool_calls ?? []);
    const firstOf = (index: number) =>
      calls.find((call) => call.index === index && call.id !== undefined)!;
    expect(firstOf(0).id).toBe("call_1");
    expect(firstOf(1).id).toBe("call_2");
    expect(firstOf(0).function?.name).toBe("read_file");
    expect(firstOf(1).function?.name).toBe("read_file");

    for (const index of [0, 1]) {
      const args = calls
        .filter((call) => call.index === index)
        .map((call) => call.function?.arguments ?? "")
        .join("");
      expect(args).toBe(index === 0 ? '{"path":"a"}' : '{"path":"b"}');
    }
  });

  it("没给 id 的调用自己补一个，空参数不会发出一片空增量", () => {
    const deltas = buildDeltas({ tool_calls: [{ function: { name: "now" } }] });
    const calls = deltas.flatMap((delta) => delta.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call_0");
    expect(calls[0]!.function).toEqual({ name: "now", arguments: "" });
  });
});

describe("buildDeltas：先后", () => {
  it("缺省按思考、工具调用、正文三块依次吐完", () => {
    const deltas = buildDeltas(
      {
        reasoning_content: "想",
        tool_calls: [{ id: "call_1", function: { name: "now", arguments: "{}" } }],
        content: "答",
      },
      { chunkSize: 10 },
    );
    const kinds = deltas.map((delta) => {
      if (delta.reasoning_content !== undefined) return "思考";
      if (delta.tool_calls !== undefined) return "工具";
      return "正文";
    });
    expect(kinds[0]).toBe("思考");
    expect(kinds.at(-1)).toBe("正文");
    expect(kinds.filter((kind) => kind === "工具")).toHaveLength(2);
  });

  it("给了 stream_order 就按它循环取，思考与正文交错", () => {
    const deltas = buildDeltas(
      { reasoning_content: "想一下", content: "答一句", stream_order: ["reasoning", "content"] },
      { chunkSize: 1 },
    );
    // (缺省那一格只决定顺序，不参与切分)
    expect(kindsOf(deltas)).toEqual([
      "思考:想",
      "正文:答",
      "思考:一",
      "正文:一",
      "思考:下",
      "正文:句",
    ]);
  });

  it("顺序里没提到的块补在最后，不会凭空消失", () => {
    const deltas = buildDeltas(
      { reasoning_content: "想", content: "答", stream_order: ["content"] },
      { chunkSize: 1 },
    );
    expect(kindsOf(deltas)).toEqual(["正文:答", "思考:想"]);
  });
});

describe("切分工具", () => {
  it("splitReply 按片数均分；片数 1 或空串时就是一片", () => {
    expect(splitReply("abcdef", 3)).toEqual(["ab", "cd", "ef"]);
    expect(splitReply("abcdef", 1)).toEqual(["abcdef"]);
    expect(splitReply("", 3)).toEqual([""]);
    expect(splitReply("一二三四五六七八", 4).join("")).toBe("一二三四五六七八");
  });

  it("cutText：chunkSize 优先，缺省按 3 片切", () => {
    expect(cutText("abcdefgh", { chunkSize: 2 })).toEqual(["ab", "cd", "ef", "gh"]);
    expect(cutText("abcdef", {})).toEqual(["ab", "cd", "ef"]);
    // 短于一片的文字原样返回，不补空格也不切碎
    expect(cutText("ab", { chunkSize: 10 })).toEqual(["ab"]);
  });

  it("目标消息的正文能交给 buildDeltas 直接产出 delta 流", () => {
    const message: FakeLlmMessage = { role: "assistant", content: "收到" };
    expect(buildDeltas(message, { chunks: 1 })).toEqual([{ content: "收到" }]);
  });
});
