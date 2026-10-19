import { ContextOverflowError } from "../shared/errors.js";
import type { AgentPlugin, SendContext } from "@ai-zen/agents-core";

export interface ContextGuardOptions {
  /** 上下文告警阈值（token）。用量超过 maxTokens × ratio 即中断。 */
  maxTokens: number;
  /**
   * 超出比例。用量 > maxTokens × ratio 时判定为「严重超限」（如读入超大文件），
   * 在请求前抛出 ContextOverflowError 中断对话。默认 1.5（即 +50%）。
   */
  ratio?: number;
  /**
   * 是否处于「需要放宽」的阶段（例如交接回合）。返回 true 时改用 `suspendedRatio`。
   *
   * 为什么需要：交接恰好发生在上下文最满的时刻，而交接回合本身还要再发 1~2 次请求。
   * 若仍按 1.5 倍判定，正常交接会被护栏误杀；完全让行又会失去熔断，故改为放宽而非放行。
   */
  isSuspended?: () => boolean;
  /** 放宽后的比例，默认 2.0（即 maxTokens × 2） */
  suspendedRatio?: number;
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
 * - 交接回合由 `isSuspended` 放宽阈值（而非完全让行），保证交接不被误杀、又保留熔断。
 *
 * ```ts
 * agent.use(new ContextGuardPlugin({
 *   maxTokens: 250_000,
 *   isSuspended: () => handoffService.busy,
 * }));
 * agent.use(new AutoMigratePlugin({ service: handoffService, maxTokens: 250_000 }));
 * ```
 */
export class ContextGuardPlugin implements AgentPlugin {
  private options: ContextGuardOptions;

  constructor(options: ContextGuardOptions) {
    this.options = options;
  }

  async onInnerLoopStart(ctx: SendContext): Promise<void> {
    const { agent } = ctx;
    const { maxTokens, ratio = 1.5, isSuspended, suspendedRatio = 2 } = this.options;

    // 首轮请求前尚无用量数据，跳过（只能在发出首轮请求、拿到 usage 后才有据可查）
    const promptTokens = agent.lastUsage?.prompt_tokens;
    if (promptTokens == null) return;

    // 交接回合等需要放宽的阶段：放宽阈值但保留熔断
    const effectiveRatio = isSuspended?.() ? suspendedRatio : ratio;

    if (promptTokens > maxTokens * effectiveRatio) {
      throw new ContextOverflowError(promptTokens, maxTokens, effectiveRatio);
    }
  }
}
