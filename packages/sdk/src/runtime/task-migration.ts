import type { AgentMessage } from "../types";

/**
 * 按 JSON.stringify(messages).length 计算上下文字符数近似值。
 */
export function countContextChars(messages: AgentMessage[]): number {
  return JSON.stringify(messages).length;
}

/**
 * 判断是否需要触发任务迁移。
 */
export function shouldMigrate(messages: AgentMessage[], maxContextChars: number): boolean {
  return countContextChars(messages) > maxContextChars;
}

/** 交接文档各节标题 */
export const HANDOFF_SECTIONS = {
  breakpoint: "## 💬 对话断点",
  completed: "## ✅ 已完成的任务",
  pending: "## 📋 未完成的任务",
  memory: "## 🧠 重要记忆",
  files: "## 📁 文件索引",
  instructions: "## 🔔 接手指令",
} as const;

/**
 * 构建发送给迁移 Agent 的提示词。
 * 迁移 Agent 应为无工具专用 Agent，只做文本分析。
 */
export function buildMigrationPrompt(): string {
  return [
    "你是一个任务交接助手。请根据以下对话历史，生成一份结构化交接文档。",
    "",
    `文档必须包含以下章节：`,
    `${HANDOFF_SECTIONS.breakpoint}`,
    `- 用户最后说了什么，AI 最后回复了什么`,
    "",
    `${HANDOFF_SECTIONS.completed}`,
    `- 列出已完成的每项任务及其关键产出`,
    "",
    `${HANDOFF_SECTIONS.pending}`,
    `- 按优先级列出未完成的任务、当前进度、下一步`,
    "",
    `${HANDOFF_SECTIONS.memory}`,
    `- 需要新 Agent 记住的关键信息（设计决策、偏好、约定等）`,
    "",
    `${HANDOFF_SECTIONS.files}`,
    `- 涉及的文件及其用途`,
    "",
    `${HANDOFF_SECTIONS.instructions}`,
    `- 接手后建议的操作步骤`,
    "",
    "只输出交接文档本身，不要加额外说明。",
  ].join("\n");
}
