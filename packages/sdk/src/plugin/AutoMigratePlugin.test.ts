import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoMigratePlugin } from "./AutoMigratePlugin.js";
import { TaskMigrationService } from "../runtime/TaskMigrationService.js";

// mock 客户端：在 mockAgent 上注入，避免真实网络请求
const mocks = vi.hoisted(() => {
  const client = {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  };
  return { client };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mockAgent(opts: {
  lastUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  messages?: any[];
  tools?: any[];
  definition?: any;
}): any {
  const messages: any[] = opts.messages ?? [{ role: "system", content: "You are a helper." }];
  return {
    definition: opts.definition ?? {
      id: "test-agent",
      name: "Test Agent",
      messages: [{ role: "system", content: "You are a helper." }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    client: mocks.client,
    model: "test-model",
    modelConfig: {},
    lastUsage: opts.lastUsage,
    messages,
    tools: opts.tools ?? [],
  };
}

function createService(): TaskMigrationService {
  return new TaskMigrationService();
}

function createPlugin(opts: { maxTokens: number; service?: TaskMigrationService }): AutoMigratePlugin {
  const { maxTokens, service } = opts;
  return new AutoMigratePlugin({ service: service ?? createService(), maxTokens });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("AutoMigratePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("返回一个 AgentPlugin（有 onAfterSend）", () => {
    const plugin = createPlugin({ maxTokens: 50000 });
    expect(plugin).toBeDefined();
    expect(typeof plugin.onAfterSend).toBe("function");
  });

  describe("onAfterSend", () => {
    it("promptTokens <= maxTokens 时不触发迁移", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 },
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "hello" },
        ],
      });
      const plugin = createPlugin({ maxTokens: 50000 });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(mocks.client.chat.completions.create).not.toHaveBeenCalled();
      expect(agent.messages).toHaveLength(2);
    });

    it("promptTokens > maxTokens 时触发迁移并替换消息", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [
          { role: "system", content: "You are a coder." },
          { role: "user", content: "Refactor please" },
          { role: "assistant", content: "Sure, here's the refactored code..." },
        ],
      });
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "## 💬 对话断点\n..." } }],
      });

      const plugin = createPlugin({ maxTokens: 50000 });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      // 模型调用携带了历史
      const createArgs = mocks.client.chat.completions.create.mock.calls[0][0];
      expect(createArgs.model).toBe("test-model");
      const userMsg = createArgs.messages.find((m: any) => m.role === "user");
      expect(userMsg.content).toContain("Refactor please");

      // agent 同引用，消息被替换为 definition.messages(1) + 交接文档注入(1) = 2
      expect(ctx.agent).toBe(agent);
      expect(agent.messages).toHaveLength(2);
      const userMsgs = agent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("## 💬 对话断点");
      expect(userMsgs[0].content).toContain("上一轮对话的任务交接文档");
    });

    it("agent.lastUsage 为 undefined 时不触发迁移", async () => {
      const agent = mockAgent({ lastUsage: undefined });
      const plugin = createPlugin({ maxTokens: 50000 });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(mocks.client.chat.completions.create).not.toHaveBeenCalled();
    });

    it("迁移生成失败时消息不变", async () => {
      const originalMessages = [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "hello" },
      ];
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [...originalMessages],
      });
      mocks.client.chat.completions.create.mockRejectedValue(new Error("Migration API error"));

      const plugin = createPlugin({ maxTokens: 50000 });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(ctx.agent).toBe(agent);
      expect(agent.messages).toEqual(originalMessages);
    });

    it("token 未超限时不触发模型调用", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 },
      });
      const plugin = createPlugin({ maxTokens: 50000 });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(mocks.client.chat.completions.create).not.toHaveBeenCalled();
    });
  });
});
