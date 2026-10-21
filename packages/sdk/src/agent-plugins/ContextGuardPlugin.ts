import { ContextOverflowError } from "../shared/errors.js";
import type { AgentPlugin, SendContext } from "@ai-zen/agents-core";

export interface ContextGuardOptions {
  /**
   * 强行阻断阈值（tokens，绝对值）。
   *
   * 语义只有一条：请求前上一轮用量超过它 → 中断本轮。没有倍数、没有放宽档——
   * 想调松就把它调大，「安全边界写多少就是多少」比「隐式乘以某个系数」可预测得多。
   */
  guardTokens: number;
}

/**
 * 上下文安全护栏插件。
 *
 * 在每次内循环**发请求前**检测上一轮用量（usage.prompt_tokens）：超过 `guardTokens`
 * 即抛 `ContextOverflowError` 中断对话，交由上层向用户报错。
 *
 * 与迁移插件职责分离：
 * - `ContextGuardPlugin`：硬线，只做「严重超限即中断」的安全兜底，绝不继续对话/迁移；
 * - `AutoMigratePlugin`：软线（`tokenThresholds.handoff`），在正常范围内做交接迁移。
 *   两条线都是绝对值，`guard` 应当明显大于 `handoff`，交接回合的额外请求才有余量。
 *
 * ```ts
 * const { handoff, guard } = config.models[i].tokenThresholds;
 * agent.use(new ContextGuardPlugin({ guardTokens: guard }));
 * agent.use(new AutoMigratePlugin({ service: handoffService, handoffTokens: handoff }));
 * ```
 */
export class ContextGuardPlugin implements AgentPlugin {
  private readonly guardTokens: number;

  constructor(options: ContextGuardOptions) {
    this.guardTokens = options.guardTokens;
  }

  async onInnerLoopStart(ctx: SendContext): Promise<void> {
    const promptTokens = ctx.agent.lastUsage?.prompt_tokens;
    // 首轮请求前尚无用量数据，跳过（只能在发出首轮请求、拿到 usage 后才有据可查）
    if (promptTokens == null) return;

    if (promptTokens > this.guardTokens) {
      throw new ContextOverflowError(promptTokens, this.guardTokens);
    }
  }
}
