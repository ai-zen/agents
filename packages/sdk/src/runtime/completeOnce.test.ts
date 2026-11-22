/**
 * `completeOnce` 的传输契约 —— 真 `openai` 客户端 + 真 HTTP（假端点）。
 *
 * 与 `HandoffService.summary.test.ts` 同一个理由：手捏客户端只能证明「给了这个形状的响应
 * 之后怎么走」，证明不了「SDK 真会发出什么」。而这里要守的三件事全在 wire 外面看得见：
 * 不流式、不带工具、`modelConfig` 展开进 body。会话自动标题与交接摘要都走这一条路，写错
 * 一次就是两处一起错。
 */

import { afterEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { completeOnce } from "./completeOnce.js";

let llm: FakeLlm | null = null;

afterEach(async () => {
  await llm?.close();
  llm = null;
});

/** 真 `OpenAI` 客户端指向假端点：`baseURL` 是唯一必须改的东西 */
function realClient(baseUrl: string): OpenAI {
  return new OpenAI({ apiKey: "fake-key", baseURL: baseUrl, maxRetries: 0 });
}

describe("completeOnce：一次不流式、不带工具的调用", () => {
  it("两条消息（system 指令 + user 输入）、没有 stream / tools、modelConfig 已展开", async () => {
    llm = await startFakeLlm({ reply: "一份短标题" });

    const text = await completeOnce({
      client: realClient(llm.baseUrl),
      model: "fake-model",
      modelConfig: { temperature: 0.2 },
      system: "你负责起名",
      user: "帮我把这个任务做完",
    });

    expect(text).toBe("一份短标题");

    const request = llm.requests[0]!;
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.body.model).toBe("fake-model");
    expect(request.body.temperature).toBe(0.2);
    expect("tools" in request.body).toBe(false);
    expect("stream" in request.body).toBe(false);
    expect(request.body.messages).toEqual([
      { role: "system", content: "你负责起名" },
      { role: "user", content: "帮我把这个任务做完" },
    ]);
  });

  it("模型没给正文 → 空串（判成败的是调用方，不是这一层）", async () => {
    llm = await startFakeLlm({ reply: "" });

    const text = await completeOnce({
      client: realClient(llm.baseUrl),
      model: "fake-model",
      system: "s",
      user: "u",
    });

    expect(text).toBe("");
  });

  it("signal 真的抵达 socket：请求被中断，不是跑完之后再检查一次", async () => {
    llm = await startFakeLlm({ reply: "来不及了", jsonDelayMs: 500 });
    const controller = new AbortController();

    const pending = completeOnce({
      client: realClient(llm.baseUrl),
      model: "fake-model",
      system: "s",
      user: "u",
      signal: controller.signal,
    });
    // 等到请求真的发出去再取消（不固定 sleep：轮询到条件成立）
    while (llm.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();

    await expect(pending).rejects.toThrow();
    // 端点侧看到的是「客户端挂了」——这才是取消到了传输层的证据
    while (!llm.requests[0]!.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
  });
});
