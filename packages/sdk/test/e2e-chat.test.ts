/**
 * 真实聊天端到端测试（需 API Key）。
 *
 * 使用 DeepSeek API 测试完整的 send() 链路：
 *   createAgent → agent.init() → agent.send()
 *
 * 运行方式：
 *   npm test -- --testPathPattern "test/e2e-chat"
 *
 * 跳过条件：未设置 DEEPSEEK_API_KEY 时自动跳过。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Provider } from "../src/runtime/Provider";
import { createModel } from "../src/runtime/createModel";
import { SdkAgent } from "../src/runtime/SdkAgent";
import { BUILTIN_TOOLS } from "../src/capabilities/implements/builtin/index";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const API_KEY = process.env.DEEPSEEK_API_KEY || "";

const skip = !API_KEY;

const config = {
  defaultModel: "deepseek-chat",
  endpoints: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: API_KEY,
    },
  ],
  models: [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      endpointId: "deepseek",
      modelName: "deepseek-chat",
      maxContextTokens: 128_000,
      defaultParams: {},
    },
  ],
};

const provider = new Provider({
  config,
  agentsDir: join(tmpdir(), "ai-zen-e2e-chat", "agents"),
  conversationsDir: join(tmpdir(), "ai-zen-e2e-chat", "conversations"),
  draftsDir: join(tmpdir(), "ai-zen-e2e-chat", "drafts"),
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe.runIf(!skip)("真实聊天（DeepSeek API）", () => {
  it("简单问答：一句话回复", async () => {
    const model = createModel(provider.config, "deepseek-chat");
    const agent = new SdkAgent({
      provider,
      definition: {
        id: "test",
        name: "Test",
        messages: [{ role: "system", content: "你是一个简洁的助手，用一句话回复。" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      model,
      messages: [{ role: "system", content: "你是一个简洁的助手，用一句话回复。" }],
    });

    const messages = await agent.send("请说'你好，世界'");

    expect(messages.length).toBeGreaterThan(0);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(typeof lastMsg.content).toBe("string");
    expect((lastMsg.content as string).length).toBeGreaterThan(0);
    console.log("AI 回复:", (lastMsg.content as string).slice(0, 100));
  });

  it("带工具调用：readFile 读取自身 package.json", async () => {
    const model = createModel(provider.config, "deepseek-chat");
    const pkgPath = join(__dirname, "..", "package.json");
    const tools = BUILTIN_TOOLS.filter((t) =>
      ["readFile", "glob", "ls", "cwd"].includes(t.function.name),
    );

    const agent = new SdkAgent({
      provider,
      definition: {
        id: "test-tool",
        name: "Test Tool",
        messages: [
          {
            role: "system",
            content: `你是一个助手，可以用工具。当前项目根目录在 ${join(__dirname, "..")}。调用工具完成任务后直接返回结果，不要多余解释。`,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      model,
      messages: [
        {
          role: "system",
          content: `你是一个助手，可以用工具。当前项目根目录在 ${join(__dirname, "..")}。调用工具完成任务后直接返回结果，不要多余解释。`,
        },
      ],
      tools,
    });

    const messages = await agent.send(`请用 readFile 读取 package.json 文件，告诉我这个包的 name 和 version。文件路径: ${pkgPath}`);

    expect(messages.length).toBeGreaterThan(0);
    const text = messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    ).join("\n");

    // 至少提到了包名
    expect(text).toMatch(/@ai-zen\/agents-sdk|agents-sdk/);
    console.log("对话结果摘要:", text.slice(0, 300));
  }, 60_000);

  it("多轮对话：记住上下文", async () => {
    const model = createModel(provider.config, "deepseek-chat");
    const agent = new SdkAgent({
      provider,
      definition: {
        id: "test-multi",
        name: "Test Multi",
        messages: [
          { role: "system", content: "你是一个助手。记住用户说的信息。" },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      model,
      messages: [
        { role: "system", content: "你是一个助手。记住用户说的信息。" },
      ],
    });

    // 第一轮
    await agent.send("我的名字叫小明，我今年25岁。");
    // 第二轮
    const messages = await agent.send("我叫什么名字？今年多大？");

    const lastContent = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join(" ");

    expect(lastContent).toMatch(/小明/);
    expect(lastContent).toMatch(/25/);
    console.log("多轮对话确认:", (lastContent as string).slice(0, 200));
  }, 60_000);
});

// 无 API Key 时的占位测试
describe.skipIf(!skip)("真实聊天（跳过 — 未配置 API Key）", () => {
  it("占位", () => {
    expect(true).toBe(true);
  });
});
