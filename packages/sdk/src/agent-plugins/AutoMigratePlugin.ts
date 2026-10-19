import type { AgentPlugin, SendContext } from "@ai-zen/agents-core";
import type { HandoffMode, HandoffService } from "../runtime/HandoffService.js";
import { getLogger } from "../shared/logger.js";
import { SdkAgent } from "../runtime/SdkAgent.js";

const log = getLogger();

/** 触发迁移时的用量信息（供执行者选择、确认文案使用） */
export interface AutoMigrateTriggerInfo {
  /** 当前 prompt token 用量 */
  promptTokens: number;
  /** 上下文阈值（当前模型的 maxContextTokens） */
  maxTokens: number;
}

/**
 * 迁移执行者解析器：只负责「用什么方式交接」，不负责「何时迁移」。
 *
 * - 返回 `HandoffMode` → 用该执行者迁移；
 * - 返回 `null` → 跳过本次迁移（例如用户拒绝）；
 * - 未提供 → 使用 `HandoffService` 构造时的默认执行者。
 */
export type AutoMigrateModeResolver = (
  info: AutoMigrateTriggerInfo,
) => HandoffMode | null | Promise<HandoffMode | null>;

export interface AutoMigrateOptions {
  /** 交接服务实例（持有交接前后钩子；编排 handoff / migrate 两条链路） */
  service: HandoffService;
  /** 触发迁移的上下文阈值 */
  maxTokens: number;
  /**
   * 执行者解析（可选）。上层可在此弹确认框、读用户偏好，
   * 或直接返回 `null` 表达「本次不迁移」——**无需**再继承本插件。
   */
  resolveMode?: AutoMigrateModeResolver;
}

/**
 * 自动迁移插件 —— 只负责「何时触发」，实际迁移统一委托给持有的 `HandoffService`。
 *
 * 当 `usage.prompt_tokens` 超过 maxTokens 时触发迁移：
 *
 * ```ts
 * agent.use(new AutoMigratePlugin({
 *   service: handoffService,
 *   maxTokens: 250_000,
 *   resolveMode: async ({ promptTokens, maxTokens }) =>
 *     (await askUser(promptTokens, maxTokens)) ? "self" : null,
 * }));
 * ```
 *
 * 两层让行（缺一不可）：
 *   - `service.busy`：交接回合本身就是一次 `send()`，其 `onAfterSend` 会再次到这里；
 *     不跳过就会「交接触发迁移 → 迁移再交接」无限递归；
 *   - 交接回合结束后的用量也仍可能超阈值，故 busy 判断必须覆盖整个交接 + 迁移过程。
 */
export class AutoMigratePlugin implements AgentPlugin {
  private options: AutoMigrateOptions;

  constructor(options: AutoMigrateOptions) {
    this.options = options;
  }

  async onAfterSend(ctx: SendContext): Promise<void> {
    const agent = ctx.agent as SdkAgent;
    const { service, maxTokens, resolveMode } = this.options;

    // 交接/迁移进行中：让行（防递归）
    if (service.busy) return;

    const promptTokens = agent.lastUsage?.prompt_tokens;
    if (promptTokens == null) return;
    if (promptTokens <= maxTokens) return;

    try {
      const mode = resolveMode
        ? await resolveMode({ promptTokens, maxTokens })
        : undefined;
      if (mode === null) return; // 用户选择跳过本次迁移

      await service.migrate({ agent, promptTokens, maxTokens, mode: mode ?? undefined });
    } catch (err: any) {
      log.error(`[autoMigrate] 迁移失败: ${err?.message ?? err}`);
    }
  }
}
