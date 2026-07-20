import { AgentNS } from "@ai-zen/agents-core";
import type { AgentPlugin, SendContext } from "../runtime/SdkAgent.js";
import { TaskMigrationService } from "../runtime/TaskMigrationService.js";
import { createLogger } from "../shared/logger.js";
import { SdkAgent } from "../runtime/SdkAgent.js";

const log = createLogger();

export interface AutoMigrateOptions {
  maxTokens: number;
  migrationAgent: SdkAgent;
  onHandoff?: (handoffDoc: string, agent: SdkAgent) => void;
}

/**
 * 自动迁移插件。
 *
 * 当 token 使用量超过 maxTokens 时，自动将对话历史交给 migrationAgent 生成交接文档，
 * 然后用交接文档替换当前 agent 的消息列表，实现无缝迁移。
 *
 * ```ts
 * agent.use(new AutoMigratePlugin({
 *   maxTokens: 250_000,
 *   migrationAgent: anotherAgent,
 *   onHandoff: (doc, agent) => { ... },
 * }));
 * ```
 */
export class AutoMigratePlugin implements AgentPlugin {
  private options: AutoMigrateOptions;

  constructor(options: AutoMigrateOptions) {
    this.options = options;
  }

  async onAfterSend(ctx: SendContext): Promise<void> {
    const { agent } = ctx;
    const { maxTokens, migrationAgent, onHandoff } = this.options;

    const promptTokens = agent.lastUsage?.prompt_tokens;
    if (promptTokens == null) return;

    if (!TaskMigrationService.shouldMigrate(promptTokens, maxTokens)) return;

    log.warn(`[autoMigrate] Token 使用量已达 ${promptTokens}，超出限制 ${maxTokens}，开始自动迁移……`);

    try {
      const historyText = this.serializeMessages(agent.messages);
      const migrationResult = await migrationAgent.send(historyText);

      const handoffDoc = this.getLastAssistantContent(migrationResult);
      if (!handoffDoc) return;

      // 仅替换消息列表，不重建 agent，保留所有引用和插件绑定
      agent.messages.length = 0;
      agent.messages.push(
        ...agent.definition.messages,
        ...TaskMigrationService.createPostMessages(handoffDoc),
      );

      if (onHandoff) {
        try {
          await onHandoff(handoffDoc, agent);
        } catch (err: any) {
          log.error(`[autoMigrate] onHandoff 回调失败: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      log.error(`[autoMigrate] 迁移失败: ${err?.message ?? err}`);
    }
  }

  private serializeMessages(messages: any[]): string {
    return messages
      .map((m) => {
        const role = m.role ?? "unknown";
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      })
      .join("\n\n");
  }

  private getLastAssistantContent(messages: any[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === AgentNS.Role.Assistant && messages[i].content) {
        return typeof messages[i].content === "string"
          ? messages[i].content
          : null;
      }
    }
    return null;
  }
}
