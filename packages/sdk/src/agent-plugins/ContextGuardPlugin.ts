import { ContextOverflowError } from "../shared/errors.js";
import type { AgentPlugin, InnerLoopContext } from "@ai-zen/agents-core";
import { lastPromptTokens } from "../runtime/lastPromptTokens.js";

export interface ContextGuardOptions {
  /**
   * 强行阻断阈值（tokens，绝对值）。
   *
   * 语义只有一条：请求前上一轮用量超过它 → 中断本轮。没有倍数、没有放宽档——
   * 想调松就把它调大，「安全边界写多少就是多少」比「隐式乘以某个系数」可预测得多。
   */
  guardTokens: number;
  /**
   * 临时让行：返回 `true` 时本轮不做超限判定（默认 `false`）。
   *
   * 用于交接回合 —— 那种回合本身就是「上下文已满」时才发起的，若不放宽必定被打回。
   * 语义是「谁做限制谁放宽」：限制在护栏自己身上，放宽也必须由护栏自己表达，
   * 而不是由调用方去改写用量数据。典型接线：`isSuspended: () => handoffService.handingOff`。
   */
  isSuspended?: () => boolean;
}

/**
 * 上下文安全护栏插件。
 *
 * 在每次内循环**发请求前**检测上一轮用量（usage.prompt_tokens）：超过 `guardTokens`
 * 就**拒绝这一圈**，交由上层向用户报错。
 *
 * 与自动交接插件职责分离：
 * - `ContextGuardPlugin`：硬线，只做「严重超限即中断」的安全兜底，绝不继续对话/交接；
 * - `AutoMigratePlugin`：软线（`tokenThresholds.handoff`），在正常范围内做自动交接。
 *   两条线都是绝对值，`guard` 应当明显大于 `handoff`，交接回合的额外请求才有余量。
 *
 * ```ts
 * const { handoff, guard } = config.models[i].tokenThresholds;
 * agent.use(
 *   new ContextGuardPlugin({
 *     guardTokens: guard,
 *     isSuspended: () => handoffService.handingOff, // 交接回合让行
 *   }),
 * );
 * agent.use(new AutoMigratePlugin({ service: handoffService, handoffTokens: handoff }));
 * ```
 *
 * ## 为什么是「返回字符串」而不是「抛错」
 *
 * 新 core（`CORE.md` §11）里 `onInnerLoopStart` 能拒：**返回 string = 这一圈压根没发出去**
 * —— 不会留下一类「永远 Pending 的助手占位」，core 报一个 `denied` 事件（带钩子名与理由），
 * 然后回外循环等下一个事件，循环还活着。
 *
 * 抛错不是「更硬的拒绝」：钩子里的异常会穿到 `start()` 外面，把整个循环打死
 * （`start()` 的 promise 直接 resolve、循环不再取件），agent 从此变成「塞进去也不动」的
 * 僵尸。这也是为什么老的「抛 `ContextOverflowError` 让上层接住」不能照搬 —— 上层现在能从
 * `denied` 事件和 `message` 的历史里看到同一件事，不需要一个把 agent 弄死的异常。
 */
export class ContextGuardPlugin implements AgentPlugin {
  private readonly guardTokens: number;
  private readonly isSuspended?: () => boolean;

  constructor(options: ContextGuardOptions) {
    this.guardTokens = options.guardTokens;
    this.isSuspended = options.isSuspended;
  }

  /** 返回 string = 拒这一圈（这一圈不会发出去，历史里一个字都不多） */
  async onInnerLoopStart(ctx: InnerLoopContext): Promise<string | undefined> {
    // 交接回合让行（见 `isSuspended`）
    if (this.isSuspended?.()) return;

    // 上一轮的 prompt 用量：只从消息上读（同一份事实、不另立快照，见 `lastPromptTokens`）
    const promptTokens = lastPromptTokens(ctx.agent);
    // 首轮请求前尚无用量数据，跳过（只能在发出首轮请求、拿到 usage 后才有据可查）
    if (promptTokens == null) return;

    if (promptTokens > this.guardTokens) {
      // 理由就是给用户看的那句话：`denied` 事件里只有字符串这一个通道，
      // 所以用量与阈值一并写进去（`ContextOverflowError` 只用来拼这句话，不往外抛）
      return new ContextOverflowError(promptTokens, this.guardTokens).message;
    }
  }
}
