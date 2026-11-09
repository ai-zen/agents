/**
 * `summary` 分支的**传输契约** —— 真 `openai` 客户端 + 真 HTTP（假端点），中间没有手捏对象。
 *
 * ## 为什么要单独一个文件
 *
 * `HandoffService.test.ts` 里所有 `summary` 用例共用一个手捏客户端：
 *
 * ```ts
 * create: vi.fn(async () => ({ choices: [{ message: { content: docContent() } }] }))
 * ```
 *
 * 它答的是「拿到**这个形状**的响应之后服务怎么走」，答不了「SDK 真会给这个形状吗」。真实的
 * `chat.completions.create` 还负责：把 `modelConfig` 展开进 body、决定非流式到底发不发
 * `stream`、把 HTTP 错误包成 `InternalServerError`、把 `RequestOptions.signal` 真的接到
 * socket 上。这四件事没有一件能靠手捏对象验出来 —— 而这正是本项目踩过的坑的形状
 * （core 那条 `chunk-parsed` 两参的 bug，就是因为假件的形状与真件不一致，躲过了整轮单测）。
 *
 * ## 为什么用假端点而不是真模型
 *
 * 真模型要 key、要网、答复不确定（断言只能写「非空」）。`@ai-zen/agents-testing` 的假端点
 * 顶上之后：答复正文、响应延迟、错误码都由用例指定，请求体被原样记下来 —— 于是断言可以写
 * 等号，还能断言「请求里**没有** `tools` / **没有** `stream`」这种只有从 wire 外面才看得见的事。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { HandoffAbortedError, HandoffService } from "./HandoffService.js";

/** 交接文档正文（> 400 字节阈值，且带上面板标题，形状与真件一致） */
function docContent(padding = 500): string {
  return `## 💬 Conversation Breakpoint\n上一轮停在「把 summary 分支盖上」\n## 🔔 First Step for the Next Agent\n- 先读 HANDOFF\n${"x".repeat(padding)}`;
}

const HISTORY = [
  "[system]: You are a helper.",
  "[user]: 帮我把这个任务做完",
  "[assistant]: 好的，开始了",
].join("\n\n");

let llm: FakeLlm | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await llm?.close();
  llm = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aizen-handoff-summary-"));
  dirs.push(dir);
  return dir;
}

/** 真 `OpenAI` 客户端指向假端点：`baseURL` 是唯一必须改的东西 */
function realClient(baseUrl: string, maxRetries = 2): OpenAI {
  return new OpenAI({ apiKey: "fake-key", baseURL: baseUrl, maxRetries });
}

/** 只实现 `summary` 用到的那几个字段的假 agent（`tools` 为空 → 自交接不可用，必然走摘要） */
function makeAgent(client: OpenAI) {
  return {
    messages: [
      { role: "system", content: "You are a helper." },
      { role: "user", content: "帮我把这个任务做完" },
      { role: "assistant", content: "好的，开始了" },
    ],
    definition: { messages: [{ role: "system", content: "You are a helper." }] },
    tools: [],
    model: "fake-model",
    modelConfig: { temperature: 0.3 },
    lastUsage: {},
    client,
    use() {},
  };
}

/** 只关日志噪音（行为不变）；Skill 目录不配，走兜底模板 */
const silentLogger = { info() {}, warn() {}, error() {} };

/** 轮询到条件成立（不固定 sleep；超时就抛，不让用例挂死） */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("等待条件成立超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("HandoffService summary 分支：真 SDK、真 HTTP", () => {
  it("正文原样落盘；请求体里没有 stream / tools，modelConfig 已展开，system 带交接路径", async () => {
    const doc = docContent();
    llm = await startFakeLlm({ reply: doc });
    const dir = makeDir();
    const service = new HandoffService({ handoffDir: dir, mode: "summary", logger: silentLogger });

    const ctx = await service.handoff({ agent: makeAgent(realClient(llm.baseUrl)) as any });

    // 1) 落盘的内容就是端点答复的那一段，一字不差
    expect(ctx.mode).toBe("summary");
    expect(ctx.handoffDoc).toBe(doc);
    expect(readFileSync(ctx.handoffPath, "utf-8")).toBe(doc);

    // 2) 请求体的契约（只有从 HTTP 外面才看得见）
    const body = llm.requests[0]!.body;
    expect(llm.requests[0]!.path).toBe("/v1/chat/completions");
    expect(body.model).toBe("fake-model");
    // `modelConfig` 是展开进 body 的，而不是塞进某个字段
    expect(body.temperature).toBe(0.3);
    // 摘要是「一次不带工具、不开流的调用」——两样都不该出现
    expect("tools" in body).toBe(false);
    expect("stream" in body).toBe(false);

    // 3) 两条消息：system 是规范（含落盘路径），user 是序列化后的历史
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain(ctx.handoffPath);
    expect(body.messages[1]).toEqual({ role: "user", content: HISTORY });
  });

  it("端点回空正文 → 抛 Failed to generate the handoff document，目录里不留半成品", async () => {
    llm = await startFakeLlm({ reply: "" });
    const dir = makeDir();
    const service = new HandoffService({ handoffDir: dir, mode: "summary", logger: silentLogger });

    await expect(
      service.handoff({ agent: makeAgent(realClient(llm.baseUrl)) as any }),
    ).rejects.toThrow("Failed to generate the handoff document");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("端点回 500 → 抛 SDK 的 InternalServerError（错误原文来自端点），不落盘", async () => {
    llm = await startFakeLlm({ failWith: { status: 500, message: "upstream exploded" } });
    const dir = makeDir();
    const service = new HandoffService({ handoffDir: dir, mode: "summary", logger: silentLogger });

    // `maxRetries: 0`：这里验的是「错误原样往上冒」，不是 SDK 的重试策略（它是 SDK 自己的事，
    // 留着默认两次会把这条用例拖成 1.2 秒）
    const client = realClient(llm.baseUrl, 0);

    // 不吞、不改写成「文档没写出来」——那会误导用户去查 Skill
    await expect(service.handoff({ agent: makeAgent(client) as any })).rejects.toThrow(
      "upstream exploded",
    );
    expect(llm.requests).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("请求还在路上时 abort → 抛 HandoffAbortedError，且不留半成品", async () => {
    // 非流式也要能「慢」：`jsonDelayMs` 撑出这段窗口，abort 才落得进去
    llm = await startFakeLlm({ reply: docContent(), jsonDelayMs: 200 });
    const dir = makeDir();
    const service = new HandoffService({ handoffDir: dir, mode: "summary", logger: silentLogger });
    const controller = new AbortController();

    // 先把 rejection 接住再 abort：否则中途抛出的错会在断言之前变成未处理 rejection
    const settled = service
      .handoff({ agent: makeAgent(realClient(llm.baseUrl)) as any, signal: controller.signal })
      .then(
        () => "resolved",
        (err) => err,
      );

    // 轮询到请求已抵达端点（此刻响应还在 `jsonDelayMs` 窗口里）—— 这才叫「在路上」
    await until(() => llm!.requests.length === 1);
    controller.abort();

    const result = await settled;
    // 调用方只需要认这一种（底层是 SDK 的 APIUserAbortError，服务统一翻译过来）
    expect(result).toBeInstanceOf(HandoffAbortedError);
    // 关键断言：取消真的抵达了 socket。只看「最后抛了取消错」不够 —— 请求跑完全部延迟、
    // 正常返回之后，服务在最后一道取消点再检查一次 `signal.aborted`，也会扔出同一个错。
    // 只有假端点看到的断连能区分这两种情况。
    await until(() => llm!.requests[0]!.aborted === true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
