import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskMigrationService } from "./TaskMigrationService.js";

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

describe("TaskMigrationService", () => {
  describe("createPrompt", () => {
    it("包含所有六个章节标题", () => {
      const prompt = TaskMigrationService.createPrompt();
      expect(prompt).toContain("## 💬 对话断点");
      expect(prompt).toContain("## ✅ 已完成的任务");
      expect(prompt).toContain("## 📋 未完成的任务");
      expect(prompt).toContain("## 🧠 重要记忆");
      expect(prompt).toContain("## 📁 文件索引");
      expect(prompt).toContain("## 🔔 接手指令");
    });
  });

  describe("createPostMessages", () => {
    it("交接文档作为第一条 user 消息", () => {
      const handoff = "## 💬 对话断点\n\n用户：帮我重构代码\n\n## ✅ 已完成\n- 重构完成";

      const messages = TaskMigrationService.createPostMessages(handoff);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toContain("## 💬 对话断点");
      expect(messages[0].content).toContain("交接文档");
      expect(messages[0].content).toContain(handoff);
    });

    it("包含接手指令", () => {
      const messages = TaskMigrationService.createPostMessages("交接内容");

      expect(messages[0].content).toContain("这是上一轮对话的任务交接文档");
      expect(messages[0].content).toContain("请先阅读交接文档");
      expect(messages[0].content).toContain("然后询问用户接下来需要什么帮助");
    });
  });

  describe("serializeMessages", () => {
    it("空数组返回空字符串", () => {
      expect(TaskMigrationService.serializeMessages([])).toBe("");
    });

    it("字符串内容序列化为 [role]: content", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any;
      expect(TaskMigrationService.serializeMessages(messages)).toBe(
        "[user]: hello\n\n[assistant]: hi",
      );
    });

    it("数组内容以 JSON 字符串化", () => {
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "多段" }] },
      ] as any;
      expect(TaskMigrationService.serializeMessages(messages)).toBe(
        `[assistant]: ${JSON.stringify([{ type: "text", text: "多段" }])}`,
      );
    });

    it("无 content 时输出 undefined", () => {
      const messages = [{ role: "user" }] as any;
      expect(TaskMigrationService.serializeMessages(messages)).toBe("[user]: undefined");
    });
  });

  describe("migrate", () => {
    function mockAgent(messages: any[] = [{ role: "system", content: "You are a helper." }]) {
      return {
        definition: {
          id: "test-agent",
          name: "Test Agent",
          messages: [{ role: "system", content: "You are a helper." }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        client: mocks.client,
        model: "test-model",
        modelConfig: {},
        messages,
      } as any;
    }

    function createService(): TaskMigrationService {
      return new TaskMigrationService();
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("成功生成交接文档并替换消息，context 记录模型名", async () => {
      const agent = mockAgent([
        { role: "system", content: "You are a coder." },
        { role: "user", content: "Refactor please" },
        { role: "assistant", content: "Sure..." },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "## 💬 对话断点\n..." } }],
      });
      const service = createService();

      const ctx = await service.migrate({
        agent,
        maxTokens: 50000,
        promptTokens: 80000,
      });

      // 已生成交接文档
      expect(ctx.handoffDoc).toContain("## 💬 对话断点");
      expect(ctx.messageCountBefore).toBe(3);
      expect(ctx.promptTokens).toBe(80000);
      expect(ctx.maxTokens).toBe(50000);
      expect(ctx.historyText).toContain("Refactor please");
      expect(ctx.model).toBe("test-model");

      // 请求携带了 agent 的模型名
      const createArgs = mocks.client.chat.completions.create.mock.calls[0][0];
      expect(createArgs.model).toBe("test-model");
      const sysMsg = createArgs.messages.find((m: any) => m.role === "system");
      expect(sysMsg.content).toContain("## 💬 对话断点");
      const userMsg = createArgs.messages.find((m: any) => m.role === "user");
      expect(userMsg.content).toContain("Refactor please");

      // 迁移采用 omit 方案：历史标记 omit（保留可审计），末尾追加对话断点
      // 迁移前 messages = [system, user, assistant]（3 条），definition.messages=[system]（1 条）
      // 迁移后：system 不省略，user/assistant 标记 omit，末尾追加断点 user → 共 4 条
      expect(agent.messages).toHaveLength(4);
      const userMsgs = agent.messages.filter((m: any) => m.role === "user");
      expect(userMsgs).toHaveLength(2);
      // 历史 user 被标记 omit
      expect(userMsgs[0].omit).toBe(true);
      // 末尾断点 user 不省略，且含交接文档
      const breakpoint = userMsgs.at(-1);
      expect(breakpoint.omit).toBeFalsy();
      expect(breakpoint.content).toContain("## 💬 对话断点");
      // 系统提示不省略
      const systemMsg = agent.messages.find((m: any) => m.role === "system");
      expect(systemMsg.omit).toBeFalsy();
    });

    it("构造时传入 client/model/modelConfig 优先于 agent 自带", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      const customClient = {
        chat: { completions: { create: vi.fn() } },
      };
      (customClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      const service = new TaskMigrationService({
        client: customClient as any,
        model: "override-model",
        modelConfig: { temperature: 0.2 },
      });

      const ctx = await service.migrate({ agent });

      // 生成请求使用构造传入的模型名与参数
      const createArgs = customClient.chat.completions.create.mock.calls[0][0];
      expect(createArgs.model).toBe("override-model");
      expect(createArgs.temperature).toBe(0.2);
      expect(ctx.model).toBe("override-model");
      // agent 自带的 client 未被使用
      expect(mocks.client.chat.completions.create).not.toHaveBeenCalled();
    });

    it("构造未传 client/modelConfig 时回退到 agent 自带", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      // 仅覆盖 model，其余回退 agent
      const service = new TaskMigrationService({ model: "override-model" });

      const ctx = await service.migrate({ agent });

      const createArgs = mocks.client.chat.completions.create.mock.calls[0][0];
      expect(createArgs.model).toBe("override-model");
      expect(createArgs.temperature).toBeUndefined();
      expect(ctx.model).toBe("override-model");
      expect(ctx.handoffDoc).toBe("交接文档");
    });

    it("未取到交接文档时抛错且消息不变", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });
      const service = createService();

      await expect(service.migrate({ agent })).rejects.toThrow();
      expect(agent.messages).toHaveLength(2);
    });

    it("historyText 过滤已标记 omit 的历史（重复迁移不重复喂入）", async () => {
      const agent = mockAgent([
        { role: "system", content: "You are a coder." },
        { role: "user", content: "Refactor please", omit: true },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      const service = createService();

      const ctx = await service.migrate({ agent });

      expect(ctx.historyText).not.toContain("Refactor please");
      expect(ctx.historyText).toContain("hello");
    });

    it("onBeforeMigrate 钩子在迁移前拿到完整上下文", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      const onBeforeMigrate = vi.fn();
      const service = new TaskMigrationService({ onBeforeMigrate });

      await service.migrate({
        agent,
        maxTokens: 50000,
        promptTokens: 80000,
      });

      expect(onBeforeMigrate).toHaveBeenCalledTimes(1);
      const beforeCtx = onBeforeMigrate.mock.calls[0][0];
      expect(beforeCtx.agent).toBe(agent);
      expect(beforeCtx.promptTokens).toBe(80000);
      expect(beforeCtx.maxTokens).toBe(50000);
      expect(beforeCtx.handoffDoc).toBeUndefined();
      expect(beforeCtx.historyText).toContain("hello");
      expect(beforeCtx.model).toBe("test-model");
    });

    it("onMigrated 钩子在迁移完成后拿到交接文档", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      const onMigrated = vi.fn();
      const service = new TaskMigrationService({ onMigrated });

      await service.migrate({ agent });

      expect(onMigrated).toHaveBeenCalledTimes(1);
      const afterCtx = onMigrated.mock.calls[0][0];
      expect(afterCtx.handoffDoc).toBe("交接文档");
      expect(afterCtx.agent).toBe(agent);
    });

    it("onBeforeMigrate 抛错不影响迁移流程", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      const onBeforeMigrate = vi.fn().mockImplementation(() => {
        throw new Error("UI error");
      });
      const onMigrated = vi.fn();
      const service = new TaskMigrationService({ onBeforeMigrate, onMigrated });

      await service.migrate({ agent });

      expect(onBeforeMigrate).toHaveBeenCalled();
      expect(mocks.client.chat.completions.create).toHaveBeenCalled();
      expect(onMigrated).toHaveBeenCalled();
    });

    it("onMigrated 抛错不影响迁移流程，消息仍被替换", async () => {
      const agent = mockAgent([
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ]);
      mocks.client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "交接文档" } }],
      });
      const onMigrated = vi.fn().mockImplementation(() => {
        throw new Error("Save failed");
      });
      const service = new TaskMigrationService({ onMigrated });

      await service.migrate({ agent });

      expect(onMigrated).toHaveBeenCalled();
      expect(agent.messages.some((m: any) => m.content?.includes("交接文档"))).toBe(true);
    });
  });
});
