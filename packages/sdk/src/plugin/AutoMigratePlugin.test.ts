import { describe, it, expect, vi } from "vitest";
import { AutoMigratePlugin } from "./AutoMigratePlugin.js";

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

function mockAgent(opts: {
  lastUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  messages?: any[];
  tools?: any[];
  model?: any;
  definition?: any;
}): any {
  const messages: any[] = opts.messages ?? [{ role: "system", content: "You are a helper." }];
  return {
    runtime: { buildModel: vi.fn(), config: {}, agentsDir: "", subAgentsPaths: [], skillsPaths: [], toolsPaths: [], mcpPaths: [] },
    definition: opts.definition ?? {
      id: "test-agent",
      name: "Test Agent",
      messages: [{ role: "system", content: "You are a helper." }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    lastUsage: opts.lastUsage,
    messages,
    tools: opts.tools ?? [],
    model: opts.model ?? {},
    caps: undefined,
    permissions: undefined,
    send: vi.fn(async (_content: string) => {
      messages.push({ role: "user", content: _content });
      messages.push({ role: "assistant", content: "OK" });
      return messages;
    }),
  };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("AutoMigratePlugin", () => {
  it("返回一个 AgentPlugin（有 onAfterSend）", () => {
    const migrationAgent = mockAgent({});
    const plugin = new AutoMigratePlugin({ maxTokens: 50000, migrationAgent: migrationAgent });

    expect(plugin).toBeDefined();
    expect(typeof plugin.onAfterSend).toBe("function");
  });

  describe("onAfterSend", () => {
    it("promptTokens <= maxTokens 时不触发迁移", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 },
      });
      const migrationAgent = mockAgent({});
      const plugin = new AutoMigratePlugin({ maxTokens: 50000, migrationAgent: migrationAgent });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(ctx.agent).toBe(agent);
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });

    it("promptTokens > maxTokens 时触发迁移并替换消息", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [
          { role: "system", content: "You are a coder." },
          { role: "user", content: "Refactor please" },
          { role: "assistant", content: "Sure, here's the refactored code..." },
        ],
        tools: [{ name: "readFile" }, { name: "exec" }],
      });

      // 迁移前有 3 条消息
      expect(agent.messages).toHaveLength(3);

      const migrationAgent = mockAgent({
        messages: [{ role: "system", content: "Migration system prompt" }],
      });
      migrationAgent.send.mockImplementation(async () => {
        return [{ role: "assistant", content: "## 💬 对话断点\n..." }];
      });

      const onHandoff = vi.fn();

      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff,
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      // agent 没有被替换（同一个对象）
      expect(ctx.agent).toBe(agent);

      expect(migrationAgent.send).toHaveBeenCalledTimes(1);
      const migrationInput = migrationAgent.send.mock.calls[0][0];
      expect(migrationInput).toContain("Refactor please");

      expect(onHandoff).toHaveBeenCalledTimes(1);
      expect(onHandoff.mock.calls[0][0]).toContain("## 💬 对话断点");
      expect(onHandoff.mock.calls[0][1]).toBe(agent);

      // 迁移后：definition.messages(1条system) + createPostMessages(1条user) = 2 条
      expect(agent.messages).toHaveLength(2);

      const systemMsg = agent.messages.find((m: any) => m.role === "system");
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toBe("You are a helper.");

      // 工具保持不变
      expect(agent.tools).toEqual([{ name: "readFile" }, { name: "exec" }]);

      // 新消息中包含交接文档
      const userMsgs = agent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      const handoffUserMsg = userMsgs[0];
      expect(handoffUserMsg.content).toContain("## 💬 对话断点");
      expect(handoffUserMsg.content).toContain("上一轮对话的任务交接文档");
    });

    it("agent.lastUsage 为 undefined 时不触发迁移", async () => {
      const agent = mockAgent({ lastUsage: undefined });
      const migrationAgent = mockAgent({});
      const plugin = new AutoMigratePlugin({ maxTokens: 50000, migrationAgent: migrationAgent });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(ctx.agent).toBe(agent);
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });

    it("迁移 Agent 调用失败时消息不变", async () => {
      const originalMessages = [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "hello" },
      ];
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [...originalMessages],
      });

      // 迁移前长度
      expect(agent.messages).toHaveLength(2);

      const migrationAgent = mockAgent({});
      migrationAgent.send.mockRejectedValue(new Error("Migration API error"));

      const onHandoff = vi.fn();
      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff,
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(ctx.agent).toBe(agent);
      // 迁移失败，消息应保持不变（长度和内容都一致）
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages).toEqual(originalMessages);
      expect(onHandoff).not.toHaveBeenCalled();
    });

    it("onHandoff 中抛错不影响迁移流程，消息仍被替换", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档内容" }]);

      const onHandoff = vi.fn().mockImplementation(() => {
        throw new Error("Save failed");
      });

      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff,
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      // agent 不变，但消息已被替换
      expect(ctx.agent).toBe(agent);
      expect(agent.messages.some((m: any) => m.content?.includes("交接文档"))).toBe(true);
      expect(onHandoff).toHaveBeenCalled();
    });

    it("新消息使用与旧 agent 相同的 model", async () => {
      const sharedModel = { some: "model" };
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        model: sharedModel,
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档" }]);

      const plugin = new AutoMigratePlugin({ maxTokens: 50000, migrationAgent: migrationAgent });
      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(agent.model).toBe(sharedModel);
    });

    it("onHandoff 中可操作 agent", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [{ role: "system", content: "Helper" }],
      });

      const migrationAgent = mockAgent({});

      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff: (_doc, a) => {
          // onHandoff 可以拿到 agent 引用进行额外处理
          (a as any).migrated = true;
        },
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect((agent as any).migrated).toBe(true);
    });

    it("onBeforeMigrate 在迁移开始前被调用", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档" }]);

      const onBeforeMigrate = vi.fn();
      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onBeforeMigrate,
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(onBeforeMigrate).toHaveBeenCalledTimes(1);
      expect(onBeforeMigrate.mock.calls[0][0]).toBe(80000);
      expect(onBeforeMigrate.mock.calls[0][1]).toBe(50000);
      expect(onBeforeMigrate.mock.calls[0][2]).toBe(agent);
    });

    it("onBeforeMigrate 中抛错不影响迁移流程", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档" }]);

      const onBeforeMigrate = vi.fn().mockImplementation(() => {
        throw new Error("UI error");
      });
      const onHandoff = vi.fn();

      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onBeforeMigrate,
        onHandoff,
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      // onBeforeMigrate 抛错不影响后续流程
      expect(onBeforeMigrate).toHaveBeenCalled();
      expect(migrationAgent.send).toHaveBeenCalled();
      expect(onHandoff).toHaveBeenCalled();
    });

    it("token 未超限时不触发 onBeforeMigrate", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 },
      });
      const migrationAgent = mockAgent({});
      const onBeforeMigrate = vi.fn();
      const plugin = new AutoMigratePlugin({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onBeforeMigrate,
      });

      const ctx = { agent, content: "hello", messages: agent.messages };
      await plugin.onAfterSend!(ctx);

      expect(onBeforeMigrate).not.toHaveBeenCalled();
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });
  });
});
