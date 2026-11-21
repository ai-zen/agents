import { ContextOverflowError } from "../shared/errors.js";
import type { AgentPlugin, InnerLoopContext } from "@ai-zen/agents-core";
import { lastPromptTokens } from "../runtime/lastPromptTokens.js";

export interface ContextGuardOptions {
  /**
   * 强行阻断阈值（tokens，绝对值）。
   *
   * 语义只有一条：请求前上一次回答的用量超过它 → 中断这一次请求。没有倍数、没有放宽档——
   * 想调松就把它调大，「安全边界写多少就是多少」比「隐式乘以某个系数」可预测得多。
   */
  guardTokens: number;
}

/**
 * 上下文安全护栏插件。
 *
 * 在每次内循环**发请求前**检测上一次回答的用量（usage.prompt_tokens）：超过 `guardTokens`
 * 就**拒绝这一次请求**，交由上层向用户报错。
 *
 * 与自动交接插件职责分离：
 * - `ContextGuardPlugin`：硬线，只做「严重超限即中断」的安全兜底，绝不继续会话/交接；
 * - `AutoMigratePlugin`：软线（`tokenThresholds.handoff`），在正常范围内做自动交接。
 *   两条线都是绝对值，`guard` 应当明显大于 `handoff`，交接回合的额外请求才有余量。
 *
 * ```ts
 * const { handoff, guard } = config.models[i].tokenThresholds;
 * agent.use(new ContextGuardPlugin({ guardTokens: guard }));
 * agent.use(new AutoMigratePlugin({ service: handoffService, handoffTokens: handoff }));
 * ```
 *
 * ## 交接那一趟也不让路
 *
 * 需求拍定的是**交接那一次请求也不让路**：硬线照旧拦，要避免撞线就把阈值配得够宽。所以这里
 * 没有、也不该有「交接回合让行」的开关 —— 此前那一格（`isSuspended`）的全部用途就是让交接
 * 回合绕过硬线，留着它等于留一个能把硬线关掉的开关。
 *
 * ## 为什么是「返回字符串」而不是「抛错」
 *
 * 新 core（`CORE.md` §11）里 `onInnerLoopStart` 能拒：**返回 string = 这一次请求压根没发出去**
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

  constructor(options: ContextGuardOptions) {
    this.guardTokens = options.guardTokens;
  }

  /** 返回 string = 拒这一次请求（这一次不会发出去，历史里一个字都不多） */
  async onInnerLoopStart(ctx: InnerLoopContext): Promise<string | undefined> {
    // 不看「此刻在不在交接」：交接那一趟也不让路，任何时刻都只看用量

    // 上一次回答的 prompt 用量：只从消息上读（同一份事实、不另立快照，见 `lastPromptTokens`）
    const promptTokens = lastPromptTokens(ctx.agent);
    // 第一条请求之前尚无用量数据，跳过（只能在发出第一条请求、拿到 usage 后才有据可查）
    if (promptTokens == null) return;

    if (promptTokens > this.guardTokens) {
      // 理由就是给用户看的那句话：`denied` 事件里只有字符串这一个通道，
      // 所以用量与阈值一并写进去（`ContextOverflowError` 只用来拼这句话，不往外抛）
      return new ContextOverflowError(promptTokens, this.guardTokens).message;
    }
  }
}
