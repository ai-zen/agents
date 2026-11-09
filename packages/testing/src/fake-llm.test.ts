/**
 * 假端点自己的测试 —— 钉住它的**外部行为**，不是实现。
 *
 * 为什么值得写：它是测试件。假件坏掉时最糟的结果不是红灯，而是下游那些用例**照样绿**
 * （比如少发一片正文，「流式」就退化成一片，断言 `>1` 才看得出来；比如忘了 `[DONE]`，
 * SDK 会一直挂着等下一帧）。所以这里只用 HTTP 看它「说出去的话」，一个内部函数都不碰。
 */

import { afterEach, describe, expect, it } from "vitest";
import { splitReply, startFakeLlm, type FakeLlm } from "./fake-llm.js";

let llm: FakeLlm | null = null;

afterEach(async () => {
  await llm?.close();
  llm = null;
});

/** 轮询到条件成立（不固定 sleep；超时就抛，不让用例挂死） */
async function until(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
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

describe("startFakeLlm：流式分支", () => {
  it("按分片发正文、末片带 finish_reason 与 usage、以 [DONE] 收尾", async () => {
    llm = await startFakeLlm({ reply: "一二三四五六七八", chunks: 4 });

    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fake-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const { frames, done } = parseSse(await response.text());

    // 首片按 OpenAI 的规矩带 role、正文为空
    expect(frames[0].choices[0].delta).toEqual({
      role: "assistant",
      content: "",
    });
    // 正文分 4 片拼起来等于答复（片数 > 1 才谈得上「流式」）
    const text = frames
      .map((frame) => frame.choices[0].delta.content ?? "")
      .join("");
    expect(text).toBe("一二三四五六七八");
    expect(
      frames.filter((frame) => frame.choices[0].delta.content).length,
    ).toBe(4);
    // 收尾片：正文空、有 finish_reason、有 usage（`stream_options.include_usage` 要的）
    const last = frames.at(-1)!;
    expect(last.choices[0].delta).toEqual({});
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual({
      prompt_tokens: 21,
      completion_tokens: 7,
      total_tokens: 28,
    });
    expect(done).toBe(true);
  });

  it("把收到的请求原样记下来（`messages` / `stream` 都在）", async () => {
    llm = await startFakeLlm({ reply: "答" });
    const body = {
      model: "fake-model",
      stream: true,
      messages: [{ role: "user", content: "记住这句" }],
    };
    await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.text());

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.path).toBe("/v1/chat/completions");
    expect(llm.requests[0]!.body).toEqual(body);
  });
});

describe("startFakeLlm：非流式分支", () => {
  it("回一次性 completion（SDK 不开流时走这条）", async () => {
    llm = await startFakeLlm({ reply: "整段答复" });

    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    const json = (await response.json()) as any;

    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message).toEqual({
      role: "assistant",
      content: "整段答复",
    });
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.completion_tokens).toBe(7);
  });

  it("jsonDelayMs：请求先落地，响应要等延迟过了才来（取消类用例就靠这段窗口）", async () => {
    const delayMs = 120;
    llm = await startFakeLlm({ reply: "慢答复", jsonDelayMs: delayMs });

    const at = performance.now();
    let settled = false;
    const pending = fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    }).then(async (response) => {
      settled = true;
      return (await response.json()) as any;
    });

    // 轮询到「请求已经到了端点」：此刻响应必然还在延迟窗口里
    while (llm.requests.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(settled).toBe(false);

    const json = await pending;
    expect(json.choices[0].message.content).toBe("慢答复");
    // 单调时钟的下界：`setTimeout` 不会早于延迟
    expect(performance.now() - at).toBeGreaterThanOrEqual(delayMs);
  });

  it("jsonDelayMs + 客户端取消：请求记录里的 aborted 置真（取消真的到了 socket）", async () => {
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
});

describe("startFakeLlm：错误分支", () => {
  it("failWith 直接回状态码与 message（错误路径不依赖外网）", async () => {
    llm = await startFakeLlm({
      failWith: { status: 500, message: "上游炸了" },
    });

    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", stream: true, messages: [] }),
    });

    expect(response.status).toBe(500);
    expect(((await response.json()) as any).error.message).toBe("上游炸了");
  });
});

describe("splitReply", () => {
  it("按字符均分；片数 1 或空答复时就是一片", () => {
    expect(splitReply("abcdef", 3)).toEqual(["ab", "cd", "ef"]);
    expect(splitReply("abcdef", 1)).toEqual(["abcdef"]);
    expect(splitReply("", 3)).toEqual([""]);
    // 拼回去必须一字不差（切分只能切，不能改写）
    expect(splitReply("一二三四五六七八", 4).join("")).toBe("一二三四五六七八");
  });
});
