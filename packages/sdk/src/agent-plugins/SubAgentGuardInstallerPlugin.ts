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
 * —— 同一个 `guardTokens`（当前模型的 `tokenThresholds.guard`；会话行上有覆盖时取会话行那一格），
 * 使「请求前用量超过硬线即中断」对 subagent 同样成立。
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
  /**
   * 强行阻断阈值；与主 Agent 同源（当前模型的 `tokenThresholds.guard`，会话行上有覆盖时取那一格）。
   *
   * 可以是一个 getter：那样每次委派都现读，改阈值不必重建 Agent。
   */
  guardTokens: number;
}

/**
 * subagent 护栏安装器（装在**宿主 Agent** 上）。
 *
 * 每次委派边界把 `ContextGuardPlugin` 装到 subagent 身上（阈值与主 Agent 相同），
 * 并递归安插自身，使 subagent 再委派（孙级）时同样受约束。始终返回 undefined，永不拒绝委派
 * ——是否中断由 `ContextGuardPlugin` 按阈值决定。
 */
export class SubAgentGuardInstallerPlugin implements AgentPlugin {
  /** 选项按**引用**存下：阈值每次委派现读（它可能是一个 getter），不存装配那一刻的快照 */
  constructor(private readonly options: SubAgentGuardOptions) {}

  onSubAgentStart({ subAgent }: SubAgentHookContext): void {
    // 与主 Agent 完全同款：同一个 guardTokens 绝对阈值
    subAgent.use(new ContextGuardPlugin({ guardTokens: this.options.guardTokens }));

    // 传染到孙级：subagent 若再委派，其 subagent 同样被安插。
    subAgent.use(new SubAgentGuardInstallerPlugin({ guardTokens: this.options.guardTokens }));
  }
}
