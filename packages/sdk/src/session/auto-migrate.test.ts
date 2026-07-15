import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoMigrate } from "./auto-migrate";
import { createSession } from "./session";
import type { SessionPlugin } from "./types";

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
    // SdkAgent 需要的字段（autoMigrate 中会通过展开构造新 SdkAgent）
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

const baseModel = { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 };

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("autoMigrate", () => {
  it("返回一个 SessionPlugin（有 afterSend）", () => {
    const migrationAgent = mockAgent({});
    const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent });

    expect(plugin).toBeDefined();
    expect(typeof plugin.afterSend).toBe("function");
  });

  describe("afterSend", () => {
    it("promptTokens <= maxTokens 时不触发迁移", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 },
      });
      const migrationAgent = mockAgent({});
      const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent });

      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      // ctx.agent 不变
      expect(ctx.agent).toBe(agent);
      // 迁移 Agent 未被调用
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });

    it("promptTokens > maxTokens 时触发迁移并通过 ctx.agent 替换", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [
          { role: "system", content: "You are a coder." },
          { role: "user", content: "Refactor please" },
          { role: "assistant", content: "Sure, here's the refactored code..." },
        ],
        tools: [{ name: "readFile" }, { name: "exec" }],
      });

      const migrationAgent = mockAgent({
        messages: [{ role: "system", content: "Migration system prompt" }],
      });
      migrationAgent.send.mockImplementation(async () => {
        return [{ role: "assistant", content: "## 💬 对话断点\n..." }];
      });

      const onHandoff = vi.fn();

      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff,
      });

      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      // ctx.agent 已被替换为新 Agent
      expect(ctx.agent).not.toBe(agent);

      // migrationAgent.send 被调用，传入了包含历史消息的内容
      expect(migrationAgent.send).toHaveBeenCalledTimes(1);
      const migrationInput = migrationAgent.send.mock.calls[0][0];
      expect(migrationInput).toContain("Refactor please");

      // onHandoff 被调用，传入了交接文档 + 旧 Agent + 新 Agent
      expect(onHandoff).toHaveBeenCalledTimes(1);
      expect(onHandoff.mock.calls[0][0]).toContain("## 💬 对话断点");   // handoffDoc
      expect(onHandoff.mock.calls[0][1]).toBe(agent);                   // oldAgent
      expect(onHandoff.mock.calls[0][2]).toBe(ctx.agent);               // newAgent

      // 新 Agent 从 definition.messages 恢复了原始 system prompt
      const newAgent = ctx.agent;
      const systemMsg = newAgent.messages.find((m: any) => m.role === "system");
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toBe("You are a helper.");

      // 新 Agent 保留了 tools
      expect(newAgent.tools).toEqual(agent.tools);

      // 新 Agent 的 messages 包含交接文档
      const userMsgs = newAgent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs.length).toBeGreaterThan(0);
      const handoffUserMsg = userMsgs[0];
      expect(handoffUserMsg.content).toContain("## 💬 对话断点");
      expect(handoffUserMsg.content).toContain("上一轮对话的任务交接文档");
    });

    it("agent.lastUsage 为 undefined 时不触发迁移", async () => {
      const agent = mockAgent({ lastUsage: undefined });
      const migrationAgent = mockAgent({});
      const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent });

      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      expect(ctx.agent).toBe(agent);
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });

    it("迁移 Agent 调用失败时 ctx.agent 不变", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockRejectedValue(new Error("Migration API error"));

      const onHandoff = vi.fn();
      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff,
      });

      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      // 失败时 ctx.agent 不变
      expect(ctx.agent).toBe(agent);
      // onHandoff 不应被调用
      expect(onHandoff).not.toHaveBeenCalled();
    });

    it("onHandoff 中抛错不影响迁移流程，ctx.agent 仍被替换", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档内容" }]);

      const onHandoff = vi.fn().mockImplementation(() => {
        throw new Error("Save failed");
      });

      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff,
      });

      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      // 即使 onHandoff 抛错，ctx.agent 仍然被替换
      expect(ctx.agent).not.toBe(agent);
      expect(onHandoff).toHaveBeenCalled();
    });

    it("新 Agent 使用与旧 Agent 相同的 model", async () => {
      const sharedModel = { some: "model" };
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        model: sharedModel,
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档" }]);

      const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent });
      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      expect(ctx.agent.model).toBe(sharedModel);
    });

    it("onHandoff 中可将旧 Agent 事件重绑到新 Agent", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [{ role: "system", content: "Helper" }],
      });

      const oldEvents: string[] = [];
      (agent as any).events = { on: (e: string) => oldEvents.push(e) };

      const migrationAgent = mockAgent({});

      const reboundEvents: string[] = [];
      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent,
        onHandoff: (_doc, oldA, newA) => {
          (newA as any).events = {
            on: (e: string) => reboundEvents.push(e),
          };
        },
      });

      const ctx = { agent: agent, model: baseModel };
      await plugin.afterSend!(ctx);

      // 新 Agent 可以绑事件
      (ctx.agent as any).events.on("chunk");
      (ctx.agent as any).events.on("sub-agent");
      expect(reboundEvents).toEqual(["chunk", "sub-agent"]);
    });
  });

  describe("集成：Session + autoMigrate", () => {
    function makeSessionAgent(opts?: any) {
      return {
        ...mockAgent(opts),
        definition: {
          id: "test-agent",
          name: "Test Agent",
          modelId: "m1",
          messages: [{ role: "system", content: "Helper" }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        runtime: {
          buildModel: vi.fn(),
          config: {
            defaultModel: "m1",
            models: [{ id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 }],
            endpoints: [],
          },
          agentsDir: "",
          subAgentsPaths: [],
          skillsPaths: [],
          toolsPaths: [],
          mcpPaths: [],
          conversationsDir: "",
          draftsDir: "",
        },
      };
    }

    it("send 后自动触发迁移并替换 Agent", async () => {
      const agent = makeSessionAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [{ role: "system", content: "Helper" }],
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档" }]);

      const session = await createSession({ agent: agent })
        .use(autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent }))
        .init();

      const beforeAgent = session.agent;
      await session.send("hello");
      const afterAgent = session.agent;

      // Agent 已被替换
      expect(afterAgent).not.toBe(beforeAgent);
      // 新 Agent 的 messages 包含交接文档
      const userMsgs = afterAgent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs[0].content).toContain("交接文档");
    });

    it("未超限时不替换 Agent", async () => {
      const agent = makeSessionAgent({
        lastUsage: { prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000 },
      });
      const migrationAgent = mockAgent({});

      const session = await createSession({ agent: agent })
        .use(autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent }))
        .init();

      const beforeAgent = session.agent;
      await session.send("hello");
      const afterAgent = session.agent;

      expect(afterAgent).toBe(beforeAgent);
    });
  });
});
