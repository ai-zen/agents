/**
 * 端点自己的用例：只看它说出去的话（HTTP + SSE 帧），一个内部函数都不碰。
 *
 * 这些断言值得写的理由只有一个：替身坏掉时最糟的结果不是红灯，而是下游用例照样绿 ——
 * 少发一片，「流式」就退化成一片；忘了 `[DONE]`，客户端会一直等下一帧；`usage` 挂错片，
 * 计费口径悄悄变成 0。
 */

import { afterEach, describe, expect, it } from "vitest";

import { startFakeLlm } from "./index.js";
import type { FakeLlm, FakeLlmMessage } from "./index.js";

let llm: FakeLlm | null = null;

afterEach(async () => {
  await llm?.close();
  llm = null;
});

/** 等到条件成立（不固定 sleep；超时就抛，不让用例挂死） */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("等待条件成立超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** 把 SSE 响应体拆成 `data:` 里的 JSON（丢 `[DONE]`，单独断言） */
function parseSse(text: string): { frames: any[]; done: boolean } {
  const frames: any[] = [];
  let done = false;
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    frames.push(JSON.parse(payload));
  }
  return { frames, done };
}

/**
 * 发一次请求并读到底。
 *
 * 断流那一条要的是「读的时候抛了错」，`response.text()` 会把那个错吞成空串，
 * 所以这里自己读 reader。
 */
async function request(
  endpoint: FakeLlm,
  body: Record<string, unknown>,
): Promise<{ response: Response; text: string; failure: Error | null }> {
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.body === null) return { response, text: "", failure: null };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let failure: Error | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    failure = error as Error;
  }
  return { response, text, failure };
}

const STREAM_REQUEST = {
  model: "fake-model",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
};

describe("流式分支", () => {
  it("首片带 role、正文按片发、收尾片带 finish_reason 与 usage、以 [DONE] 收尾", async () => {
    llm = await startFakeLlm({ reply: "一二三四五六七八", chunks: 4 });

    const { response, text, failure } = await request(llm, STREAM_REQUEST);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(failure).toBeNull();
    const { frames, done } = parseSse(text);

    expect(frames[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    const pieces = frames
      .map((frame) => frame.choices[0].delta.content ?? "")
      .filter((piece: string) => piece !== "");
    expect(pieces).toEqual(["一二", "三四", "五六", "七八"]);

    const last = frames.at(-1)!;
    expect(last.choices[0].delta).toEqual({});
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 });
    expect(done).toBe(true);
  });

  it("目标消息带工具调用时，分片按 OpenAI 的规矩把参数拼回去", async () => {
    const message: FakeLlmMessage = {
      content: "我先读一下",
      tool_calls: [
        { id: "call_7", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      ],
    };
    llm = await startFakeLlm({ reply: message, chunkSize: 5 });

    const { frames, done } = parseSse((await request(llm, STREAM_REQUEST)).text);
    const calls = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);

    expect(calls[0]).toMatchObject({
      index: 0,
      id: "call_7",
      type: "function",
      function: { name: "read_file" },
    });
    expect(calls.map((call: any) => call.function.arguments).join("")).toBe('{"path":"a.txt"}');
    expect(frames.at(-1)!.choices[0].finish_reason).toBe("tool_calls");
    expect(done).toBe(true);
  });

  it("chunkDelayMs：片与片之间真的隔开（用例靠这个窗口卡中间态）", async () => {
    const delayMs = 60;
    llm = await startFakeLlm({ reply: "一二三", chunks: 3, chunkDelayMs: delayMs });

    const at = performance.now();
    await request(llm, STREAM_REQUEST);
    // 首片之后还有三片正文与一片收尾，每一片之前都等一次
    expect(performance.now() - at).toBeGreaterThanOrEqual(delayMs * 3);
  });
});

describe("非流式分支", () => {
  it("一次回整条消息，形状与 chat.completion 一致", async () => {
    const message: FakeLlmMessage = {
      reasoning_content: "先想一想",
      content: "整条答复",
      tool_calls: [{ id: "call_9", function: { name: "now", arguments: "{}" } }],
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    };
    llm = await startFakeLlm({ reply: message });

    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    const json = (await response.json()) as any;

    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.choices[0].message).toEqual({
      role: "assistant",
      content: "整条答复",
      reasoning_content: "先想一想",
      tool_calls: [
        {
          index: 0,
          id: "call_9",
          type: "function",
          function: { name: "now", arguments: "{}" },
        },
      ],
    });
    // 目标消息自己带了用量，就以它为准（没给 total_tokens 时由前两格相加）
    expect(json.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });
});

describe("剧本", () => {
  it("给函数：按这次请求里的 messages 决定回哪条", async () => {
    llm = await startFakeLlm({
      reply: (body: any) =>
        String(body?.messages?.[0]?.content ?? "").includes("天气") ? "晴天" : "别的",
      chunks: 1,
    });

    const first = parseSse(
      (
        await request(llm, {
          ...STREAM_REQUEST,
          messages: [{ role: "user", content: "今天天气怎么样" }],
        })
      ).text,
    );
    const second = parseSse(
      (await request(llm, { ...STREAM_REQUEST, messages: [{ role: "user", content: "随便聊聊" }] }))
        .text,
    );

    expect(first.frames[1].choices[0].delta.content).toBe("晴天");
    expect(second.frames[1].choices[0].delta.content).toBe("别的");
  });

  it("给数组：按请求序号取，用完停在最后一条", async () => {
    llm = await startFakeLlm({ reply: ["第一句", "第二句"], chunks: 1 });

    const answers: string[] = [];
    for (let at = 0; at < 3; at += 1) {
      const { frames } = parseSse((await request(llm, STREAM_REQUEST)).text);
      answers.push(frames[1].choices[0].delta.content);
    }
    expect(answers).toEqual(["第一句", "第二句", "第二句"]);
  });

  it("给一InboxEntry标消息：每次请求都回它", async () => {
    llm = await startFakeLlm({ reply: { content: "固定答复" }, chunks: 1 });

    for (let at = 0; at < 2; at += 1) {
      const { frames } = parseSse((await request(llm, STREAM_REQUEST)).text);
      expect(frames[1].choices[0].delta.content).toBe("固定答复");
    }
    expect(llm.requests).toHaveLength(2);
  });

  it("给字符串：等于「正文是这句话、没有工具调用」的那条消息", async () => {
    llm = await startFakeLlm({ reply: "就这一句", chunks: 1 });
    const { frames } = parseSse((await request(llm, STREAM_REQUEST)).text);
    expect(frames[1].choices[0].delta).toEqual({ content: "就这一句" });
    expect(frames.some((frame) => frame.choices[0].delta.tool_calls !== undefined)).toBe(false);
  });
});

describe("故障注入", () => {
  it("断流：吐了两片之后连接消失，客户端拿到的是读失败，不是正常结束", async () => {
    llm = await startFakeLlm({ reply: "一二三四五六七八", chunks: 4, breakAfter: 3 });

    const { text, failure } = await request(llm, STREAM_REQUEST);

    // 已经收到的那些片是真的收到了
    const { frames, done } = parseSse(text);
    expect(frames).toHaveLength(3);
    expect(frames[0].choices[0].delta.role).toBe("assistant");
    // 断在中间：没有收尾片，也没有 [DONE]，客户端读到的是一次错误
    expect(done).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("terminated");
    // 断的是端点这一侧，不该记成「客户端挂断」
    expect(llm.requests[0]!.aborted).toBe(false);
  });

  it("failOn：只让第 2 次请求失败，其余照常回内容", async () => {
    llm = await startFakeLlm({
      reply: "正常",
      chunks: 1,
      failWith: { status: 500, message: "上游炸了" },
      failOn: 1,
    });

    const ok = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    expect(ok.status).toBe(200);

    const failed = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as any).error.message).toBe("上游炸了");

    const again = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    expect(again.status).toBe(200);
  });

  it("failWith 不带 failOn 时每次都失败", async () => {
    llm = await startFakeLlm({ failWith: { status: 500, message: "上游炸了" } });
    for (let at = 0; at < 2; at += 1) {
      const response = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fake-model", stream: true, messages: [] }),
      });
      expect(response.status).toBe(500);
      expect(((await response.json()) as any).error.message).toBe("上游炸了");
    }
  });
});

describe("观测口", () => {
  it("requests：收到的请求按到达顺序原样记下来", async () => {
    llm = await startFakeLlm({ reply: "答" });
    const body = {
      model: "fake-model",
      stream: true,
      messages: [{ role: "user", content: "记住这句" }],
    };
    await request(llm, body);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.path).toBe("/v1/chat/completions");
    expect(llm.requests[0]!.body).toEqual(body);
  });

  it("aborted：客户端在响应写完之前挂断时置真", async () => {
    llm = await startFakeLlm({ reply: "这句不会被收到", jsonDelayMs: 300 });
    const controller = new AbortController();
    const pending = fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
      signal: controller.signal,
    }).then(
      () => "resolved",
      (err) => err,
    );

    await until(() => llm!.requests.length === 1);
    expect(llm.requests[0]!.aborted).toBe(false);

    controller.abort();
    await until(() => llm!.requests[0]!.aborted === true);

    // 取消在客户端侧表现为 AbortError，而且不能把测试进程搞挂（端点得吞掉写失败）
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe("AbortError");
  });

  it("jsonDelayMs：响应要等延迟过了才来", async () => {
    const delayMs = 120;
    llm = await startFakeLlm({ reply: "慢答复", jsonDelayMs: delayMs });

    const at = performance.now();
    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    const json = (await response.json()) as any;

    expect(json.choices[0].message.content).toBe("慢答复");
    expect(performance.now() - at).toBeGreaterThanOrEqual(delayMs);
  });
});
