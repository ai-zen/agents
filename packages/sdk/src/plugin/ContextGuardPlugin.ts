import { ContextOverflowError } from "../shared/errors.js";
import type { AgentPlugin, SendContext } from "../runtime/SdkAgent.js";

export interface ContextGuardOptions {
  /** 上下文告警阈值（token）。用量超过 maxTokens × ratio 即中断。 */
  maxTokens: number;
  /**
   * 超出比例。用量 > maxTokens × ratio 时判定为「严重超限」（如读入超大文件），
   * 在请求前抛出 ContextOverflowError 中断对话。默认 1.2（即 +20%）。
   */
  ratio?: number;
}

/**
 * 上下文安全护栏插件。
 *
 * 在每次内循环**发请求前**检测上一轮用量（usage.prompt_tokens）：
 * - 若用量超过 maxTokens × ratio，说明上下文已严重超限（通常因读入超大文件），
 *   在请求前抛出 ContextOverflowError，**中断对话**，交由上层向用户报错。
 *
 * 与迁移插件职责分离：
 * - ContextGuardPlugin 只做「严重超限即中断」的安全兜底，绝不继续对话/迁移；
 * - AutoMigratePlugin 在正常范围内（超 maxTokens 但未达硬上限）做交接迁移。
 *
 * ```ts
 * agent.use(new ContextGuardPlugin({ maxTokens: 250_000 }));
 * agent.use(new AutoMigratePlugin({
 *   maxTokens: 250_000,
 *   migrationAgent,
 * }));
 * ```
 */
export class ContextGuardPlugin implements AgentPlugin {
  private options: ContextGuardOptions;

  constructor(options: ContextGuardOptions) {
    this.options = options;
  }

  async onInnerLoopStart(ctx: SendContext): Promise<void> {
    const { agent } = ctx;
    const { maxTokens, ratio = 1.2 } = this.options;

    // 首轮请求前尚无用量数据，跳过（只能在发出首轮请求、拿到 usage 后才有据可查）
    const promptTokens = agent.lastUsage?.prompt_tokens;
    if (promptTokens == null) return;

    if (promptTokens > maxTokens * ratio) {
      throw new ContextOverflowError(promptTokens, maxTokens, ratio);
    }
  }
}
