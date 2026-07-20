import { describe, it, expect } from "vitest";
import { TaskMigrationService } from "./TaskMigrationService.js";

describe("TaskMigrationService", () => {
  describe("shouldMigrate", () => {
    it("promptTokens 超过 maxTokens 返回 true", () => {
      expect(TaskMigrationService.shouldMigrate(260_000, 250_000)).toBe(true);
    });

    it("promptTokens 未超过返回 false", () => {
      expect(TaskMigrationService.shouldMigrate(180_000, 250_000)).toBe(false);
    });

    it("恰好等于时返回 false（边界内不触发）", () => {
      expect(TaskMigrationService.shouldMigrate(250_000, 250_000)).toBe(false);
    });
  });

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

  describe("createAgentDefinition", () => {
    it("创建无工具的迁移 Agent 定义", () => {
      const def = TaskMigrationService.createAgentDefinition();

      expect(def.id).toBe("task-migration");
      expect(def.name).toContain("任务交接");
      expect(def.messages).toHaveLength(1);
      expect(def.messages[0].role).toBe("system");
      expect(def.messages[0].content).toContain("不要做任何解释");
      expect(def.messages[0].content).toContain("## 💬 对话断点");

      expect(def.function).toBeUndefined();
      expect(def.permissions).toBeUndefined();
    });

    it("可传入自定义 modelId", () => {
      const def = TaskMigrationService.createAgentDefinition({ modelId: "gpt-4" });
      expect(def.modelId).toBe("gpt-4");
    });

    it("包含 createdAt 和 updatedAt", () => {
      const def = TaskMigrationService.createAgentDefinition();
      expect(def.createdAt).toBeTruthy();
      expect(def.updatedAt).toBeTruthy();
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
});
