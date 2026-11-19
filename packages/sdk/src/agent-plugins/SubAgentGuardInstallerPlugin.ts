/**
 * subagent 护栏安装器 — SubAgentGuardInstallerPlugin
 *
 * 为什么在 SDK 而不在 CLI：subagent 内循环缺护栏是**所有宿主**共有的问题，不是 CLI 特性。
 * 会话执行搬到服务端之后，服务端装配插件的那一处（`installPlugins`）装不到 CLI 仓里的实现，
 * 远程会话的 subagent 就会裸奔；把它放进 SDK，CLI 与服务端才能装同一份护栏、
 * 共享同一套阈值语义。
 *
 * 背景：SDK 的 subagent 由 `AgentToolLazy` 在委派时 `new Agent({ lifetime: "one-shot", ... })`
 * 构建（core 的 `buildAgent` 回调），新建实例不携带任何插件（`Agent` 的插件表每实例私有，
 * 不向 subagent 传播），且 subagent 走 `runOnce()`（一次性的那一条路），主 Agent 上的
 * `ContextGuardPlugin` 对它完全无效：subagent 的内循环没有上下文 token 护栏。
 *
 * 介入点：core 的 `onSubAgentStart` 钩子在「subagent 已构建、尚未 `runOnce()`」时由宿主 Agent
 * 分发，载荷携带 subagent 实例。`use()` 只是把插件推入插件表，而钩子分发每次都实时遍历
 * 该列表，故在钩子内安插对**本次 runOnce 立即生效**（无需 init；`AgentToolLazy` 也不会调用
 * subagent 的 init）。
 *
 * 约束口径（与主 Agent 同款，一项不落）：把主 Agent 同款的 `ContextGuardPlugin` 装到 subagent 上
 * —— 同一个 `guardTokens`（当前模型的 `tokenThresholds.guard`），使「请求前用量超过硬线即中断」
 * 对 subagent 同样成立；同一个 `isSuspended`（会话层的交接/迁移让行判断），使「交接回合让行」
 * 对 subagent 同样成立。
 *
 * 为什么让行判断也必须透传：交接回合本身就是上下文最满的时刻 —— 主 Agent 那颗护栏靠
 * `isSuspended` 让行才不至于「交接触发拦截 → 拦截又触发交接」地打转。subagent 若只带阈值、
 * 不带让行，就会在交接中派出去的子任务上照拦，护栏比主 Agent 还严一档；递归安插时更是层层
 * 都要带上，否则孙级又会把让行丢掉（同一个缺口往下挪一层而已）。
 * **不设**循环次数上限，**不设**工具调用次数上限。
 *
 * 中断语义（core 重写之后变了，这是必须知道的一条）：护栏在 `onInnerLoopStart` 里**返回
 * 拒绝字符串**（`CORE.md` §11「哪些钩子能拒」），于是 subagent 的那一次请求**压根没发出去** ——
 * 历史里一个字都不多，core 报 `denied`，委派工具照常收尾。父 Agent 这边拿到的是 subagent
 * 已装好的历史（委派工具交回 `messages` 的最后一条），**不是**一段「执行工具时出错」的异常
 * 文本 —— 新 core 里钩子抛错会穿到 `start()` 外面把循环打死，反而连收尾都做不干净。
 *
 * 覆盖范围：core 的委派路径是 `AgentToolLazy`，它分发 onSubAgentStart / onSubAgentEnd，
 * 故本插件对**全部**subagent 生效。SDK 的 `call_skill_sub_agent`（技能 subagent）与
 * `createSubAgentTool` 造出来的那些（名称取自定义的 `function.name`）同样由
 * `AgentToolLazy` 承载、走同一委派边界，因此也在覆盖范围内。
 */

import type { AgentPlugin, SubAgentHookContext } from "@ai-zen/agents-core";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";

export interface SubAgentGuardOptions {
  /** 强行阻断阈值；与主 Agent 同源（当前模型的 `tokenThresholds.guard`） */
  guardTokens: number;
  /**
   * 让行判断（与主 Agent 的 `ContextGuardPlugin` 同一个来源）。
   * 交接回合本身就是上下文最满的时刻，硬线必须让行 —— 否则「交接触发拦截 → 拦截
   * 又触发交接」形成死循环。subagent 也必须遵守同一判断，否则交接中派出去的子任务
   * 会被自己的硬线打断。
   */
  isSuspended?: () => boolean;
}

/**
 * subagent 护栏安装器（装在**宿主 Agent** 上）。
 *
 * 每次委派边界把 `ContextGuardPlugin` 装到 subagent 身上（阈值与让行判断都与主 Agent 相同），
 * 并递归安插自身，使 subagent 再委派（孙级）时同样受约束。始终返回 undefined，永不拒绝委派
 * ——是否中断由 `ContextGuardPlugin` 按阈值决定。
 */
export class SubAgentGuardInstallerPlugin implements AgentPlugin {
  private readonly guardTokens: number;
  /** 让行判断按**引用**存下：它读的是「此刻是否在交接」，不是装配那一刻的快照 */
  private readonly isSuspended?: () => boolean;

  constructor(options: SubAgentGuardOptions) {
    this.guardTokens = options.guardTokens;
    this.isSuspended = options.isSuspended;
  }

  onSubAgentStart({ subAgent }: SubAgentHookContext): void {
    // 与主 Agent 完全同款：同一个 guardTokens 绝对阈值 + 同一个让行判断
    subAgent.use(
      new ContextGuardPlugin({
        guardTokens: this.guardTokens,
        isSuspended: this.isSuspended,
      }),
    );

    // 传染到孙级：subagent 若再委派，其 subagent 同样被安插。
    // 让行判断也必须跟着递归走，否则只差一层就把「交接中让行」丢了。
    subAgent.use(
      new SubAgentGuardInstallerPlugin({
        guardTokens: this.guardTokens,
        isSuspended: this.isSuspended,
      }),
    );
  }
}
