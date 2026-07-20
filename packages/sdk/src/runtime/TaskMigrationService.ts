import { AgentNS } from "@ai-zen/agents-core";
import type { AgentDefinition } from "../types/index.js";

/**
 * 任务迁移服务。
 */
export class TaskMigrationService {
  static readonly HANDOFF_SECTIONS = {
    breakpoint: "## 💬 对话断点",
    completed: "## ✅ 已完成的任务",
    pending: "## 📋 未完成的任务",
    memory: "## 🧠 重要记忆",
    files: "## 📁 文件索引",
    instructions: "## 🔔 接手指令",
  } as const;

  static shouldMigrate(promptTokens: number, maxTokens: number): boolean {
    return promptTokens > maxTokens;
  }

  static createPrompt(): string {
    return [
      "根据以下对话历史，生成一篇结构化交接文档。不要做任何解释，只输出交接文档。",
      "",
      `文档必须包含以下章节：`,
      `${TaskMigrationService.HANDOFF_SECTIONS.breakpoint}`,
      `- 用户最后说了什么，AI 最后回复了什么`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.completed}`,
      `- 列出已完成的每项任务及其关键产出`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.pending}`,
      `- 按优先级列出未完成的任务、当前进度、下一步`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.memory}`,
      `- 需要新 Agent 记住的关键信息（设计决策、偏好、约定等）`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.files}`,
      `- 涉及的文件及其用途`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.instructions}`,
      `- 接手后建议的操作步骤`,
    ].join("\n");
  }

  static createAgentDefinition(
    options: { modelId?: string } = {},
  ): AgentDefinition {
    const now = new Date().toISOString();
    return {
      id: "task-migration",
      name: "任务交接助手",
      description: "专用迁移 Agent：分析对话历史并生成结构化交接文档",
      messages: [
        { role: AgentNS.Role.System, content: TaskMigrationService.createPrompt() },
      ],
      modelId: options.modelId,
      createdAt: now,
      updatedAt: now,
    };
  }

  static createPostMessages(handoffDoc: string): AgentNS.Message[] {
    const content = [
      "这是上一轮对话的任务交接文档。请先阅读交接文档，理解上下文后再继续协助用户完成任务。",
      "",
      "---",
      "",
      handoffDoc,
      "",
      "---",
      "",
      "请确认你已理解以上内容，然后询问用户接下来需要什么帮助。",
    ].join("\n");

    return [{ role: AgentNS.Role.User, content }];
  }
}

export interface BuildMigrationAgentOptions {
  modelId?: string;
}
