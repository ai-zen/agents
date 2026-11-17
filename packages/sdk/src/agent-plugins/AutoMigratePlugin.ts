import { AgentError } from "@ai-zen/agents-core";
import type { AgentPlugin, OuterLoopContext } from "@ai-zen/agents-core";
import { HandoffAbortedError } from "../runtime/HandoffService.js";
import type { HandoffMode, HandoffService } from "../runtime/HandoffService.js";
import { lastPromptTokens } from "../runtime/lastPromptTokens.js";
import { getLogger } from "../shared/logger.js";
import type { SdkAgent } from "../runtime/SdkAgent.js";

/** 触发迁移时的用量信息（供执行者选择、确认文案使用） */
export interface AutoMigrateTriggerInfo {
  /** 当前 prompt token 用量 */
  promptTokens: number;
  /** 交接阈值（当前模型的 tokenThresholds.handoff） */
  handoffTokens: number;
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
  handoffTokens: number;
  /**
   * 执行者解析（可选）。上层可在此弹确认框、读用户偏好，
   * 或直接返回 `null` 表达「本次不迁移」——**无需**再继承本插件。
   */
  resolveMode?: AutoMigrateModeResolver;
  /**
   * 迁移完成之后的回声（可选）：`mode` 是**实际**用的执行者（`self` 降级到 `summary` 时以
   * 服务报的为准）。宿主据此落「这段会话压缩过」这类观测事实 —— 插件自己不认识存储层。
   *
   * 钩子抛错只记一条日志：迁移已经完成，标不出来是观测问题，不该反过来让这一轮报错。
   */
  onMigrated?: (info: AutoMigrateTriggerInfo & { mode: HandoffMode }) => void | Promise<void>;
  /**
   * 迁移**没成**的回声（可选）：模型没有写出来、写出来不够长、落库失败……
   *
   * **取消不算失败**（用户按了停那条不叫它）：那是回到交接前，没什么要收尾的。
   * 宿主拿它把输出闸开回来 —— 闸是交接那一批的批头关上的，而开闸只有宿主能决定
   * （SDK 不认识「记忆换完了」这件事，见 `HandoffService.runHandoff` 的注释）。
   */
  onFailed?: (info: AutoMigrateTriggerInfo & { error: unknown }) => void | Promise<void>;
}

/**
 * 自动迁移插件 —— 只负责「何时触发」，实际迁移统一委托给持有的 `HandoffService`。
 *
 * 当 `usage.prompt_tokens` 超过 handoffTokens 时触发迁移：
 *
 * ```ts
 * agent.use(new AutoMigratePlugin({
 *   service: handoffService,
 *   handoffTokens: 250_000,
 *   resolveMode: async ({ promptTokens, handoffTokens }) =>
 *     (await askUser(promptTokens, handoffTokens)) ? "self" : null,
 * }));
 * ```
 *
 * ## 为什么落在 `onIdle`（旧的 `onAfterSend` 已删除）
 *
 * 迁移是「**彻底不动了才做**」的事：它要在原会话里再跑一个交接回合写文档，换记忆则在
 * 宿主那一侧（服务只管产出文档）。「这一圈答完了」还不够 ——
 * 内循环可能还要接着跑工具、队列里可能还压着别的投递，那些都还在写同一个数组。
 * `onIdle` 的语义正是「手上没活、队列也空」（`CORE.md` §4），此刻开工才不会
 * 踩到正在跑的圈；而 `onOuterLoopEnd` 只保证「这一批跑完了」，队列里可能还有货。
 *
 * ## 两层让行（缺一不可）
 *   - `service.handingOff`：交接回合本身就是「往同一个 agent 里再投一轮」，它跑完后 agent 又会
 *     变闲一次，`onIdle` 会再次到这里；不跳过就会「交接触发交接 → 交接再交接」无限递归；
 *   - 交接回合结束后的用量也仍可能超阈值，故 handingOff 判断必须覆盖整个交接过程。
 *
 * ## `onIdle()` 不带 ctx：agent 从 `onOuterLoopStart` 认领
 *
 * core 的死活钩子（`onIdle` / `onStart` / `onStop` …）没有参数，而交接必须有 agent。
 * 于是这里在 `onOuterLoopStart`（每一批事件开头必到，且排在 `onIdle` 之前）把 agent
 * 记下来 —— 那一步只做登记，不做任何判断。
 */
export class AutoMigratePlugin implements AgentPlugin {
  private options: AutoMigrateOptions;
  /** 认领到的 agent（见类注释最后一段：`onIdle()` 不带 ctx） */
  private agent?: SdkAgent;

  constructor(options: AutoMigrateOptions) {
    this.options = options;
  }

  /** 只登记 agent：`onIdle()` 没有 ctx，而交接需要它。不做任何判断。 */
  onOuterLoopStart(ctx: OuterLoopContext): void {
    this.agent = ctx.agent as SdkAgent;
  }

  async onIdle(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;

    const { service, handoffTokens, resolveMode, onMigrated, onFailed } = this.options;

    // 交接进行中（本服务这一趟还在跑）：让行（防递归）
    if (service.handingOff) return;

    // 上一轮 prompt 用量：只从消息上读（与 `ContextGuardPlugin` 同一份事实、同一个读法）
    const promptTokens = lastPromptTokens(agent);
    if (promptTokens == null) return;
    if (promptTokens <= handoffTokens) return;

    try {
      const mode = resolveMode ? await resolveMode({ promptTokens, handoffTokens }) : undefined;
      if (mode === null) return; // 用户选择跳过本次交接

      // 自动交接走 `migrate()`：**写文档 + 换记忆**。记忆长什么样只有 SDK 这一处算，
      // 落在哪儿看服务有没有注入落库接缝（宿主注入了，于是它落库、落内存；外部使用者没注入，
      // 于是 SDK 自己换 `agent.messages`）—— 不是两套实现，是同一份结果两个落点。
      const migrated = await service.migrate({
        agent,
        promptTokens,
        handoffTokens,
        mode: mode ?? undefined,
      });
      // 记忆已经换完：这时候才报「压过了」（实际执行者以服务报的为准）
      await this.notifyMigrated(onMigrated, {
        promptTokens,
        handoffTokens,
        mode: migrated.mode,
      });
    } catch (err: any) {
      // 用户主动取消不是失败：服务已把会话退回交接前，这里再报错只会在界面上
      // 凭空多一条「迁移失败」（默认 logger 是 console.error，TUI 下直接撕画面）
      if (err instanceof HandoffAbortedError) return;
      // agent 已经关门/被硬杀（`stop()` / `kill()` 之后又走到 idle）：没什么可交接的。
      // 不报错、也不降级 summary —— 那会为一个已经没有的会话白烧一轮全量输入。
      if (err instanceof AgentError && err.code === "closed") return;
      getLogger().error(`[autoMigrate] handoff failed: ${err?.message ?? err}`);
      await this.notifyFailed(onFailed, { promptTokens, handoffTokens, error: err });
    }
  }

  /** 迁移之后的回声：钩子自己的失败不影响迁移结果（只记日志） */
  private async notifyMigrated(
    hook: AutoMigrateOptions["onMigrated"],
    info: AutoMigrateTriggerInfo & { mode: HandoffMode },
  ): Promise<void> {
    if (!hook) return;
    try {
      await hook(info);
    } catch (err: any) {
      getLogger().error(`[autoMigrate] onMigrated hook failed: ${err?.message ?? err}`);
    }
  }

  /** 没成那一拍的回声：同样只记日志（这一趟就是要告诉宿主一声，它崩了不该变成第二件坏事） */
  private async notifyFailed(
    hook: AutoMigrateOptions["onFailed"],
    info: AutoMigrateTriggerInfo & { error: unknown },
  ): Promise<void> {
    if (!hook) return;
    try {
      await hook(info);
    } catch (err: any) {
      getLogger().error(`[autoMigrate] onFailed hook failed: ${err?.message ?? err}`);
    }
  }
}
