import { AgentNS } from "@ai-zen/agents-core";
import { SdkAgent } from "../runtime/SdkAgent.js";
import type { AgentPlugin, SendContext } from "../runtime/SdkAgent.js";
import { TaskMigrationService } from "../runtime/TaskMigrationService.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger();

export interface AutoMigrateOptions {
  maxTokens: number;
  migrationAgent: SdkAgent;
  onHandoff?: (handoffDoc: string, oldAgent: SdkAgent, newAgent: SdkAgent) => void;
}

/**
 * 自动迁移插件。
 *
 * ```ts
 * agent.use(new AutoMigratePlugin({
 *   maxTokens: 250_000,
 *   migrationAgent,
 *   onHandoff: (doc, old, next) => { ... },
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

    try {
      const historyText = this.serializeMessages(agent.messages);
      const migrationResult = await migrationAgent.send(historyText);

      const handoffDoc = this.getLastAssistantContent(migrationResult);
      if (!handoffDoc) return;

      const newMessages = [
        ...agent.definition.messages,
        ...TaskMigrationService.createPostMessages(handoffDoc),
      ] as AgentNS.Message[];

      const newAgent = new SdkAgent({ ...agent, messages: newMessages });
      ctx.agent = newAgent;

      if (onHandoff) {
        try {
          await onHandoff(handoffDoc, agent, newAgent);
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
