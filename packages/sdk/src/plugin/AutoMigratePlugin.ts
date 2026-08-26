import type { AgentPlugin, SendContext } from "@ai-zen/agents-core";
import { TaskMigrationService } from "../runtime/TaskMigrationService.js";
import { getLogger } from "../shared/logger.js";
import { SdkAgent } from "../runtime/SdkAgent.js";

const log = getLogger();

export interface AutoMigrateOptions {
  /** 迁移服务实例（持有迁移前后钩子；生成交接文档时复用传入 agent 的模型调用） */
  service: TaskMigrationService;
  /** 触发迁移的上下文阈值 */
  maxTokens: number;
}

/**
 * 自动迁移插件 — 只负责「触发」，实际迁移逻辑统一委托给持有的 `TaskMigrationService` 实例。
 *
 * 当 token 使用量超过 maxTokens 时触发迁移。`service.migrate()` 需要 `agent`（当前对话）作为
 * 唯一运行时参数，其余（模型、迁移前后钩子）已由服务在构造时持有。
 *
 * ```ts
 * agent.use(new AutoMigratePlugin({
 *   service: new TaskMigrationService({ onMigrated }),
 *   maxTokens: 250_000,
 * }));
 * ```
 */
export class AutoMigratePlugin implements AgentPlugin {
  private options: AutoMigrateOptions;

  constructor(options: AutoMigrateOptions) {
    this.options = options;
  }

  async onAfterSend(ctx: SendContext): Promise<void> {
    const agent = ctx.agent as SdkAgent;
    const { service, maxTokens } = this.options;

    const promptTokens = agent.lastUsage?.prompt_tokens;
    if (promptTokens == null) return;

    if (promptTokens <= maxTokens) return;

    try {
      await service.migrate({ agent, promptTokens, maxTokens });
    } catch (err: any) {
      log.error(`[autoMigrate] 迁移失败: ${err?.message ?? err}`);
    }
  }
}
