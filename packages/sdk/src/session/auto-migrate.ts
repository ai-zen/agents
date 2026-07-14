import type { Agent } from "@ai-zen/agents-core";
import { AgentNS } from "@ai-zen/agents-core";
import { Message } from "@ai-zen/agents-core";
import type { SessionPlugin } from "./types";
import { shouldMigrate, buildPostMigrationMessages } from "../runtime/task-migration";
import { createLogger } from "../shared/logger";

const log = createLogger();

export interface AutoMigrateOptions {
  /** 触发迁移的 token 阈值 */
  maxTokens: number;
  /** 迁移 Agent（无工具，system prompt = buildMigrationPrompt） */
  migrationAgent: Agent;
  /** 迁移完成回调，传入交接文档、旧 Agent、新 Agent */
  onHandoff?: (handoffDoc: string, oldAgent: Agent, newAgent: Agent) => void;
}

/**
 * 自动迁移插件：每次 Agent.run() 返回后检查 prompt_tokens 是否超限，
 * 超限则用迁移 Agent 生成交接文档，创建新 Agent 替换。
 */
export function autoMigrate(options: AutoMigrateOptions): SessionPlugin {
  const { maxTokens, migrationAgent, onHandoff } = options;

  return {
    afterRun: async (ctx) => {
      const { agent } = ctx;

      // 1. 读取 lastUsage
      const promptTokens = agent.lastUsage?.prompt_tokens;
      if (promptTokens == null) return; // 无用量数据，不迁移

      // 2. 判断是否超限
      if (!shouldMigrate(promptTokens, maxTokens)) return;

      // 3. 触发迁移
      try {
        // a. 将当前 agent.messages（完整历史）序列化后发给 migrationAgent
        const historyText = serializeMessages(agent.messages);
        const migrationResult = await migrationAgent.send(historyText);

        // 获取迁移 Agent 的回复（交接文档）
        const handoffDoc = getLastAssistantContent(migrationResult);
        if (!handoffDoc) return; // 迁移 Agent 无有效输出

        // b. 构建新 Agent：沿用原 system prompt + 工具 + model
        const systemMsg = agent.messages.find(
          (m: any) => m.role === AgentNS.Role.System,
        );

        const newMessages = [
          // 保留 system prompt
          ...(systemMsg ? [new Message(systemMsg as any)] : []),
          // 交接文档作为第一条 user 消息
          ...buildPostMigrationMessages(handoffDoc).map(
            (am) => new Message({ role: am.role as AgentNS.Role, content: am.content }),
          ),
        ];

        const newAgent = new (agent.constructor as any)({
          model: agent.model,
          messages: newMessages,
          tools: agent.tools,
          rag: (agent as any).rag,
          allowJsonParseError: (agent as any).allowJsonParseError,
          onBeforeSend: (agent as any).onBeforeSend,
        });

        // c. 回调 onHandoff（此时新旧 Agent 都已就绪，调用方可重绑事件）
        if (onHandoff) {
          try {
            await onHandoff(handoffDoc, agent, newAgent);
          } catch (err: any) {
            log.error(`[autoMigrate] onHandoff 回调失败: ${err?.message ?? err}`);
          }
        }

        return newAgent;
      } catch (err: any) {
        log.error(`[autoMigrate] 迁移失败: ${err?.message ?? err}`);
        return; // 失败不替换 Agent
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function serializeMessages(messages: any[]): string {
  return messages
    .map((m) => {
      const role = m.role ?? "unknown";
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");
}

function getLastAssistantContent(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === AgentNS.Role.Assistant && messages[i].content) {
      return typeof messages[i].content === "string"
        ? messages[i].content
        : null;
    }
  }
  return null;
}
