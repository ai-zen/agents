import { AgentError } from "@ai-zen/agents-core";
import type { AgentPlugin, OuterLoopContext } from "@ai-zen/agents-core";
import { HandoffAbortedError } from "../runtime/HandoffService.js";
import type { HandoffContext, HandoffMode, HandoffService } from "../runtime/HandoffService.js";
import { lastPromptTokens } from "../runtime/lastPromptTokens.js";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";
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
   * 钩子抛错就让这一次迁移报错（本插件不接）：写钩子的是宿主，它写崩了该在自己的调用栈里
   * 炸出来，而不是被吞成一行日志。
   */
  onMigrated?: (info: AutoMigrateTriggerInfo & { mode: HandoffMode }) => void | Promise<void>;
  /**
   * 迁移**没成**的回声（可选）：模型没有写出来、写出来不够长、落库失败、端点 4xx……
   *
   * **取消不算失败**（用户按了停那条不叫它）：那是回到交接前，没什么要收尾的。
   * 宿主拿它把输出闸开回来 —— 闸是交接那一批的批头关上的，而开闸只有宿主能决定
   * （SDK 不认识「记忆换完了」这件事，见 `HandoffService.runHandoff` 的注释）。
   *
   * 钩子抛错就让这一次迁移报错（本插件不接）：这一道是「把闸开回来」的唯一一道门，
   * 它自己崩了被吞成一行日志，闸就可能一直关着。
   */
  onFailed?: (info: AutoMigrateTriggerInfo & { error: unknown }) => void | Promise<void>;
  /**
   * 日志口（可选）：迁移失败且没有被回应声接住的那一条从前走全局日志，现在从这里出去。
   *
   * 不注入就不记 —— 库不替调用方往 stdout 写（宿主注入自己那份，带上来源标签）。
   */
  logger?: LogSink;
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
 * 宿主那一侧（服务只管产出文档）。「这一次回答完了」还不够 ——
 * 内循环可能还要接着跑工具、队列里可能还压着别的投递，那些都还在写同一个数组。
 * `onIdle` 的语义正是「手上没活、队列也空」（`CORE.md` §4），此刻开工才不会
 * 踩到正在跑的那一次请求；而 `onOuterLoopEnd` 只保证「这一批跑完了」，队列里可能还有货。
 *
 * ## 两层让行（缺一不可）
 *   - `service.handingOff`：交接回合本身就是「往同一个 agent 里再投一次」，它跑完后 agent 又会
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
  /** 日志口（构造时定下缺省：不注入就是 {@link SILENT_LOG}） */
  private readonly logger: LogSink;
  /** 认领到的 agent（见类注释最后一段：`onIdle()` 不带 ctx） */
  private agent?: SdkAgent;

  constructor(options: AutoMigrateOptions) {
    this.options = options;
    this.logger = options.logger ?? SILENT_LOG;
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

    // 上一次回答的 prompt 用量：只从消息上读（与 `ContextGuardPlugin` 同一份事实、同一个读法）
    const promptTokens = lastPromptTokens(agent);
    if (promptTokens == null) return;
    if (promptTokens <= handoffTokens) return;

    // 迁移本身（写文档 + 换记忆）失败：报一句、把失败回声叫起来
    let migrated: HandoffContext;
    try {
      const mode = resolveMode ? await resolveMode({ promptTokens, handoffTokens }) : undefined;
      if (mode === null) return; // 用户选择跳过本次交接

      // 自动交接走 `migrate()`：**写文档 + 换记忆**。记忆长什么样只有 SDK 这一处算，
      // 落在哪儿看服务有没有注入落库接缝（宿主注入了，于是它落库、落内存；外部使用者没注入，
      // 于是 SDK 自己换 `agent.messages`）—— 不是两套实现，是同一份结果两个落点。
      migrated = await service.migrate({
        agent,
        promptTokens,
        handoffTokens,
        mode: mode ?? undefined,
      });
    } catch (err: any) {
      // 用户主动取消不是失败：服务已把会话退回交接前，这里再报错只会在界面上
      // 凭空多一条「迁移失败」（日志口是注入的，宿主那格可能是终端）
      if (err instanceof HandoffAbortedError) return;
      // agent 已经关门/被硬杀（`stop()` / `kill()` 之后又走到 idle）：没什么可交接的。
      // 不报错、也不降级 summary —— 那会为一个已经没有的会话白烧一次全量输入。
      if (err instanceof AgentError && err.code === "closed") return;
      this.logger.error(`[autoMigrate] handoff failed: ${err?.message ?? err}`);
      // 失败回声是「把闸开回来」的那一道：它自己抛错不在这里接，让它在这个调用栈里炸出来
      await onFailed?.({ promptTokens, handoffTokens, error: err });
      return;
    }

    // 记忆已经换完：这时候才报「压过了」（实际执行者以服务报的为准）。
    // 它故意留在上面那个 try 之外：回声自己崩了不是「交接失败」，不该被当成失败再报一遍
    // 失败回声 —— 它就在这个调用栈里炸出来（与 `commitMemory` 同一个口径）。
    await onMigrated?.({ promptTokens, handoffTokens, mode: migrated.mode });
  }
}
