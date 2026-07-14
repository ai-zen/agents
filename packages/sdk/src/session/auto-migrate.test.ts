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
}) {
  const messages: any[] = opts.messages ?? [{ role: "system", content: "You are a helper." }];
  return {
    lastUsage: opts.lastUsage,
    messages,
    tools: opts.tools ?? [],
    model: opts.model ?? {},
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
  it("返回一个 SessionPlugin（有 afterRun）", () => {
    const migrationAgent = mockAgent({});
    const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent as any });

    expect(plugin).toBeDefined();
    expect(typeof plugin.afterRun).toBe("function");
  });

  describe("afterRun", () => {
    it("promptTokens <= maxTokens 时返回 undefined（不迁移）", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 },
      });
      const migrationAgent = mockAgent({});
      const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent as any });

      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });

      expect(result).toBeUndefined();
      // 迁移 Agent 未被调用
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });

    it("promptTokens > maxTokens 时触发迁移并返回新 Agent", async () => {
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
      // 让 migrationAgent.send 返回交接文档
      migrationAgent.send.mockImplementation(async () => {
        return [{ role: "assistant", content: "## 💬 对话断点\n..." }];
      });

      const onHandoff = vi.fn();

      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent as any,
        onHandoff,
      });

      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });

      // 返回了新 Agent
      expect(result).toBeDefined();
      expect(result).not.toBe(agent);

      // migrationAgent.send 被调用，传入了包含历史消息的内容
      expect(migrationAgent.send).toHaveBeenCalledTimes(1);
      const migrationInput = migrationAgent.send.mock.calls[0][0];
      expect(migrationInput).toContain("Refactor please");

      // onHandoff 被调用，传入了交接文档 + 旧 Agent + 新 Agent
      expect(onHandoff).toHaveBeenCalledTimes(1);
      expect(onHandoff.mock.calls[0][0]).toContain("## 💬 对话断点");   // handoffDoc
      expect(onHandoff.mock.calls[0][1]).toBe(agent);                   // oldAgent
      expect(onHandoff.mock.calls[0][2]).toBe(result);                  // newAgent

      // 新 Agent 保留了 system prompt
      const newAgent = result!;
      const systemMsg = newAgent.messages.find((m: any) => m.role === "system");
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toBe("You are a coder.");

      // 新 Agent 保留了 tools
      expect(newAgent.tools).toEqual(agent.tools);

      // 新 Agent 的 messages 以交接文档作为 user 消息开头
      const userMsgs = newAgent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs.length).toBeGreaterThan(0);
      const handoffUserMsg = userMsgs[0];
      expect(handoffUserMsg.content).toContain("## 💬 对话断点");
      expect(handoffUserMsg.content).toContain("上一轮对话的任务交接文档");
    });

    it("agent.lastUsage 为 undefined 时不触发迁移", async () => {
      const agent = mockAgent({ lastUsage: undefined });
      const migrationAgent = mockAgent({});
      const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent as any });

      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });

      expect(result).toBeUndefined();
      expect(migrationAgent.send).not.toHaveBeenCalled();
    });

    it("迁移 Agent 调用失败时返回 undefined，原 Agent 不变", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockRejectedValue(new Error("Migration API error"));

      const onHandoff = vi.fn();
      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent as any,
        onHandoff,
      });

      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });

      // 失败时返回 undefined，Agent 不变
      expect(result).toBeUndefined();
      // onHandoff 不应被调用
      expect(onHandoff).not.toHaveBeenCalled();
    });

    it("onHandoff 中抛错不影响迁移流程，仍返回新 Agent", async () => {
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
        migrationAgent: migrationAgent as any,
        onHandoff,
      });

      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });

      // 即使 onHandoff 抛错，仍然返回新 Agent
      expect(result).toBeDefined();
      expect(result).not.toBe(agent);
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

      const plugin = autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent as any });
      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });

      expect(result!.model).toBe(sharedModel);
    });

    it("onHandoff 中可将旧 Agent 事件重绑到新 Agent", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [{ role: "system", content: "Helper" }],
      });

      // 模拟 UI 事件绑定：给旧 Agent 挂事件
      const oldEvents: string[] = [];
      (agent as any).events = { on: (e: string) => oldEvents.push(e) };

      const migrationAgent = mockAgent({});

      // 收集迁移后重绑的事件
      const reboundEvents: string[] = [];
      const plugin = autoMigrate({
        maxTokens: 50000,
        migrationAgent: migrationAgent as any,
        onHandoff: (_doc, oldA, newA) => {
          // CLI 模式：解绑旧事件 + 重绑到新 Agent
          // 这里模拟将事件名列表传递到新 Agent
          (newA as any).events = {
            on: (e: string) => reboundEvents.push(e),
          };
        },
      });

      const result = await plugin.afterRun!({ agent: agent as any, model: baseModel });
      expect(result).toBeDefined();

      // 新 Agent 可以绑事件
      (result as any).events.on("chunk");
      (result as any).events.on("sub-agent");
      expect(reboundEvents).toEqual(["chunk", "sub-agent"]);
    });
  });

  describe("集成：Session + autoMigrate", () => {
    it("send 后自动触发迁移并替换 Agent", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 80000, completion_tokens: 5000, total_tokens: 85000 },
        messages: [{ role: "system", content: "Helper" }],
      });
      const migrationAgent = mockAgent({});
      migrationAgent.send.mockResolvedValue([{ role: "assistant", content: "交接文档" }]);

      const session = await createSession({ agent: agent as any, model: baseModel })
        .use(autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent as any }))
        .init();

      const beforeAgent = session.agent;
      await session.send("hello");
      const afterAgent = session.agent;

      // Agent 已被替换
      expect(afterAgent).not.toBe(beforeAgent);
      // 新 Agent 的 messages 以交接文档开头
      const userMsgs = afterAgent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs[0].content).toContain("交接文档");
    });

    it("未超限时不替换 Agent", async () => {
      const agent = mockAgent({
        lastUsage: { prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000 },
      });
      const migrationAgent = mockAgent({});

      const session = await createSession({ agent: agent as any, model: baseModel })
        .use(autoMigrate({ maxTokens: 50000, migrationAgent: migrationAgent as any }))
        .init();

      const beforeAgent = session.agent;
      await session.send("hello");
      const afterAgent = session.agent;

      expect(afterAgent).toBe(beforeAgent);
    });
  });
});
