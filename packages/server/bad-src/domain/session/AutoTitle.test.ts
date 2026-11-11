/**
 * 自动标题的生成器 —— 测的是「读配置 → 选模型 → 发那一次请求 → 收拾出一个名字」。
 *
 * 用一个**真的** HTTP 端点（`node:http`）而不是手捏客户端：这里要断言的正是「请求里发了什么」
 * （哪个模型、带没带历史、有没有 system 指令），而手捏对象测的是「给了这个形状的响应之后
 * 怎么走」。响应体照 OpenAI 的真形状写，所以 `openai` SDK 那一层也一起过了。
 *
 * 与会话层的分工：什么时候触发、超时、落盘、发事件、不覆盖手改名全在
 * `SessionManager.test.ts` 里测（那边用注入的假生成器，不碰网）。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { createAutoTitle, type AutoTitleRequest } from "./AutoTitle.js";

/** 起名请求的假端点：回一条固定正文，把收到的请求体记下来 */
interface FakeEndpoint {
  baseUrl: string;
  requests: Array<{ path: string; body: any }>;
  close(): Promise<void>;
}

const endpoints: FakeEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

async function startEndpoint(reply: string): Promise<FakeEndpoint> {
  const requests: Array<{ path: string; body: any }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      // 与 OpenAI 的真响应同形：正文在 `choices[0].message.content`
      response.end(
        JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion",
          created: 0,
          model: "any",
          choices: [
            { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const endpoint: FakeEndpoint = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  endpoints.push(endpoint);
  return endpoint;
}

/** 一份最小可用配置：两个模型走同一个端点，`aux` 是「辅助小请求」那个 */
function configOf(baseUrl: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [{ id: "ep", name: "EP", baseUrl, apiKey: "test-key" }],
    models: [
      {
        id: "main",
        name: "Main",
        endpointId: "ep",
        tokenThresholds: { handoff: 100, guard: 200 },
      },
      {
        id: "aux",
        name: "Aux",
        endpointId: "ep",
        modelName: "aux-sent",
        tokenThresholds: { handoff: 100, guard: 200 },
        defaultParams: { temperature: 0 },
      },
    ],
    ...overrides,
  };
}

/** 造生成器：`configFile` 只是形参，配置由 `loadConfig` 直接给（不碰磁盘） */
function generatorOf(config: AppConfig) {
  return createAutoTitle({ configFile: "/dev/null", loadConfig: async () => config });
}

const REQUEST: AutoTitleRequest = {
  modelId: "main",
  messages: [
    { role: "system", content: "你是助手" },
    { role: "user", content: "帮我把迁移改成 omit" },
    { role: "assistant", content: "好，先看 SessionManager" },
    { role: "user", content: "上一段的历史", omit: true },
  ],
};

describe("AutoTitle：配置开关", () => {
  it("autoTitle:false → 一个字都不发（关掉就是关掉，不是「发了但不落盘」）", async () => {
    const endpoint = await startEndpoint("不该出现的标题");
    const generate = generatorOf(configOf(endpoint.baseUrl, { autoTitle: false }));

    await expect(generate(REQUEST)).resolves.toBeNull();
    expect(endpoint.requests).toEqual([]);
  });

  it("缺这个字段（老配置）→ 按开启算", async () => {
    const endpoint = await startEndpoint("老配置也能起名");

    await expect(generatorOf(configOf(endpoint.baseUrl))(REQUEST)).resolves.toBe("老配置也能起名");
    expect(endpoint.requests).toHaveLength(1);
  });
});

describe("AutoTitle：用哪个模型", () => {
  it("配了 defaultMigrationModel 就用它（含它自己的 defaultParams）", async () => {
    const endpoint = await startEndpoint("用辅助模型");
    const config = configOf(endpoint.baseUrl, { defaultMigrationModel: "aux" });

    await generatorOf(config)(REQUEST);

    const body = endpoint.requests[0]!.body;
    expect(body.model).toBe("aux-sent"); // 实发名 = modelName，不是配置里的 id
    expect(body.temperature).toBe(0); // 模型自己的 defaultParams 展开进 body
  });

  it("没配辅助模型 → 用这一段会话生效的模型", async () => {
    const endpoint = await startEndpoint("用会话模型");

    await generatorOf(configOf(endpoint.baseUrl))(REQUEST);

    expect(endpoint.requests[0]!.body.model).toBe("main");
  });

  it("两个都没有 → 跳过（不发请求）", async () => {
    const endpoint = await startEndpoint("不该出现");
    const generate = generatorOf(configOf(endpoint.baseUrl));

    await expect(generate({ ...REQUEST, modelId: "" })).resolves.toBeNull();
    expect(endpoint.requests).toEqual([]);
  });
});

describe("AutoTitle：提示词与历史", () => {
  it("只送 user / assistant 的正文：system 指令与 omit 掉的旧段都不进 prompt", async () => {
    const endpoint = await startEndpoint("迁移讨论");
    await generatorOf(configOf(endpoint.baseUrl))(REQUEST);

    const body = endpoint.requests[0]!.body;
    expect(body.messages).toHaveLength(2); // system 是起名指令，user 是历史
    expect(body.messages[0].role).toBe("system");
    const transcript = String(body.messages[1].content);
    expect(transcript).toContain("帮我把迁移改成 omit");
    expect(transcript).toContain("好，先看 SessionManager");
    expect(transcript).not.toContain("你是助手");
    expect(transcript).not.toContain("上一段的历史");
  });

  it("不流式、不带工具：一次问一句答一句的辅助请求", async () => {
    const endpoint = await startEndpoint("随便");
    await generatorOf(configOf(endpoint.baseUrl))(REQUEST);

    const body = endpoint.requests[0]!.body;
    expect("stream" in body).toBe(false);
    expect("tools" in body).toBe(false);
  });
});

describe("AutoTitle：把模型的输出收成一个名字", () => {
  it("剥掉引号、只取第一行", async () => {
    const endpoint = await startEndpoint('"迁移策略改造"\n（这是标题，解释略）');

    await expect(generatorOf(configOf(endpoint.baseUrl))(REQUEST)).resolves.toBe("迁移策略改造");
  });

  it("空正文 → null（宁可没名字，也不要一个空标题挡住客户端的兑底显示）", async () => {
    const endpoint = await startEndpoint("   ");

    await expect(generatorOf(configOf(endpoint.baseUrl))(REQUEST)).resolves.toBeNull();
  });
});
