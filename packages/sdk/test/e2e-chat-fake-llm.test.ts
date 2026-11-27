/**
 * 真实 HTTP 链路上的一轮问答：`createModel → SdkAgent → start / push / 等闲`。
 *
 * 端点换成 `@ai-zen/fake-llm`（OpenAI 兼容、只依赖 `node:http`）：既是真 socket、真 SSE 流、
 * 真 `openai` 客户端，又能把剧本定死 —— 于是「发出去的是什么」与「拼起来的答案是什么」
 * 都能写等号。原来那套要 `DEEPSEEK_API_KEY`、只能断言「回复里提到小明」的用例由这个文件取代：
 * 那种断言测的是模型会不会说话，不是这条链路。
 *
 * 起了一个本地端口的 HTTP 服务，所以不在默认套件里：`npm run test:e2e`。
 */
import { describe, it, expect, afterEach } from "vitest";
import { Message } from "@ai-zen/agents-core";
import {
  startFakeLlm,
  type FakeLlm,
  type FakeLlmMessage,
  type FakeLlmReply,
} from "@ai-zen/fake-llm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { Scope } from "../src/scope/Scope.js";
import { createModel } from "../src/runtime/createModel.js";
import { SdkAgent } from "../src/runtime/SdkAgent.js";
import { BUILTIN_TOOL_CLASSES } from "../src/scope/plugins/builtin/index.js";
import { runRound, sendRound, stopAgent } from "../src/test-support/agent-round.js";
import type { AppConfig } from "../src/types/index.js";

const SYSTEM = "你是一个简洁的助手，用一句话回复。";

/** 一张 1×1 的 PNG（白底）：够 `view_image` 认出来，不必在用例里现编编码器 */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 起一个假端点 + 一个装了指定工具的 Agent；用完由 `afterEach` 收 */
interface Harness {
  llm: FakeLlm;
  agent: SdkAgent;
  /** 端点收到的请求（按到达顺序） */
  requests: () => FakeLlm["requests"];
}

let disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function makeAgent(options: {
  reply: FakeLlmReply;
  chunks?: number;
  tools?: string[];
}): Promise<Harness> {
  const llm = await startFakeLlm({ reply: options.reply, chunks: options.chunks ?? 3 });
  const dir = await mkdtemp(join(tmpdir(), "e2e-chat-"));
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });

  const config: AppConfig = {
    endpoints: [{ id: "fake", name: "fake", baseUrl: llm.baseUrl, apiKey: "fake-key" }],
    models: [
      {
        id: "fake-model",
        name: "fake",
        endpointId: "fake",
        modelName: "fake-model",
        // 阈值给得足够大：这一套不测交接
        tokenThresholds: { handoff: 1_000_000, guard: 2_000_000 },
        vision: true,
      },
    ] as AppConfig["models"],
  };

  const scope = new Scope({ getConfig: () => config, agentsDir });
  const model = createModel(scope, "fake-model");
  const tools = BUILTIN_TOOL_CLASSES.map((Cls) => new Cls(scope.env)).filter((t) =>
    (options.tools ?? []).includes(t.function.name),
  );

  const definition = {
    id: "test",
    name: "Test",
    messages: [Message.System(SYSTEM)],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const agent = new SdkAgent({
    scope,
    definition,
    client: model.client,
    model: model.model,
    modelConfig: model.modelConfig,
    messages: [Message.System(SYSTEM)],
    tools,
  });

  disposers.push(async () => {
    await llm.close();
  });
  return { llm, agent, requests: () => llm.requests };
}

/** 把一条消息的正文摊成字符串（工具结果回来时正文是内容块数组） */
function textOf(message: { content?: unknown }): string {
  const content = message.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

describe("真实 HTTP 链路（fake-llm）", () => {
  it("一次问答：流的碎片拼成一句、请求里带着 system 与用户那句话", async () => {
    const h = await makeAgent({ reply: "你好，世界", chunks: 4 });

    const messages = await sendRound(h.agent, "请说你好");

    // 端点把这句话切成了 4 片发出来；客户端拼回去必须一字不差
    const last = messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("你好，世界");

    const sent = h.requests()[0]!.body;
    expect(sent.stream).toBe(true);
    expect(sent.messages[0]).toMatchObject({ role: "system", content: SYSTEM });
    expect(sent.messages.at(-1)).toMatchObject({ role: "user", content: "请说你好" });
  });

  it("工具回路：模型要 read、工具真跑、结果回到下一轮的请求里", async () => {
    const toolCall: FakeLlmMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "package.json" }) },
        },
      ],
      finish_reason: "tool_calls",
    };

    const h = await makeAgent({
      reply: (request: any, index: number) => {
        if (index === 0) return toolCall;
        // 第二轮：端点能看到请求里喂回去的工具结果，用它拼一句话
        const toolMessage = request.messages.find((m: any) => m.role === "tool");
        return `读到了：${String(toolMessage?.content ?? "").includes('"name"')}`;
      },
      tools: ["read"],
    });

    const messages = await sendRound(h.agent, "读一下 packages/sdk 的 package.json");

    // 两轮请求：先要工具，再带着结果收尾
    expect(h.requests()).toHaveLength(2);
    const second = h.requests()[1]!.body.messages as any[];
    const toolMessage = second.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage.content).toContain('"name"');

    expect(messages.at(-1)!.content).toBe("读到了：true");
  });

  it("多轮：第二轮请求里带着上一轮的问与答", async () => {
    const h = await makeAgent({ reply: () => "记住了" });
    const agent = h.agent;

    await runRound(agent, "我的名字叫小明");
    await runRound(agent, "我叫什么名字？");
    await stopAgent(agent);

    const second = h.requests()[1]!.body.messages as any[];
    const said = second.map((m) => `${m.role}:${textOf(m)}`);
    expect(said).toContain("user:我的名字叫小明");
    expect(said).toContain("assistant:记住了");
  });

  it("视觉：view_image 把本地图片编码进下一次请求（这里端点没有 Files API，走内联 data URL）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-image-"));
    const imagePath = join(dir, "one-pixel.png");
    await writeFile(imagePath, ONE_PIXEL_PNG);

    const h = await makeAgent({
      reply: (request: any, index: number) => {
        if (index === 0) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-v",
                type: "function",
                function: {
                  name: "view_image",
                  arguments: JSON.stringify({ path_or_url: imagePath }),
                },
              },
            ],
            finish_reason: "tool_calls",
          } satisfies FakeLlmMessage;
        }
        return "我看到了一张很小的图";
      },
      tools: ["view_image"],
    });

    const messages = await sendRound(h.agent, "看看这张图");

    expect(messages.at(-1)!.content).toBe("我看到了一张很小的图");

    // 图片真的被编成了 image_url 内容块，随下一轮请求发给了端点
    const second = h.requests()[1]!.body.messages as any[];
    const blocks = second
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block) => block?.type === "image_url");
    expect(blocks.length).toBeGreaterThan(0);
    expect(String(blocks[0].image_url?.url ?? "")).toMatch(/^data:image\/png;base64,/);
  });
});
