import type { AgentDefinition, AgentMessage } from "../types";

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

// ---- 迁移 Agent 定义 ----

export interface BuildMigrationAgentOptions {
  /** 指定模型，不填用默认 */
  modelId?: string;
}

/**
 * 创建迁移 Agent 的 AgentDefinition。
 * 该 Agent 无权限（无工具），仅用于文本分析生成交接文档。
 */
export function buildMigrationAgentDefinition(
  options: BuildMigrationAgentOptions = {},
): AgentDefinition {
  const now = new Date().toISOString();
  return {
    id: "task-migration",
    name: "任务交接助手",
    description: "专用迁移 Agent：分析对话历史并生成结构化交接文档",
    messages: [
      { role: "system", content: buildMigrationPrompt() },
    ],
    modelId: options.modelId,
    createdAt: now,
    updatedAt: now,
  };
}

// ---- 迁移后新对话 ----

/**
 * 构建迁移后的新对话初始消息。
 * 将交接文档包装为第一条 user 消息，引导新 Agent 先阅读再继续。
 */
export function buildPostMigrationMessages(handoffDoc: string): AgentMessage[] {
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

  return [{ role: "user", content }];
}
