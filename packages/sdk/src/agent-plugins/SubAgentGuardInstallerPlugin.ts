/**
 * 子 Agent 护栏安装器 — SubAgentGuardInstallerPlugin
 *
 * 为什么在 SDK 而不在 CLI：子 Agent 内循环缺护栏是**所有宿主**共有的问题，不是 CLI 特性。
 * 会话执行搬到服务端之后，服务端装配插件的那一处（`installPlugins`）装不到 CLI 仓里的实现，
 * 远程会话的子 Agent 就会裸奔；把它放进 SDK，CLI 与服务端才能装同一份护栏、
 * 共享同一套阈值语义（原实现位于 CLI 的 `src/sub-agent-guard-plugin.ts`，本次原样搬入）。
 *
 * 背景：SDK 的子 Agent 由 `AgentTool` / `AgentToolLazy` 在委派时 `new Agent({...})` 构建，
 * 新建实例不携带任何插件（`Agent._plugins` 每实例私有，不向子 Agent 传播），且子 Agent 走
 * `run()` 而非 `send()`（`onBeforeSend` / `onAfterSend` 不会触发）。因此主 Agent 上的
 * `ContextGuardPlugin` 对子 Agent 完全无效：子 Agent 的内循环没有上下文 token 护栏。
 *
 * 介入点：core 的 `onSubAgentStart` 钩子在「子 Agent 已构建、尚未 run()」时由宿主 Agent
 * 分发，载荷携带子 Agent 实例。`use()` 只是把插件推入 `_plugins`，而钩子分发每次都实时遍历
 * 该列表，故在钩子内安插对**本次 run 立即生效**（无需 init；AgentTool 也不会调用子 Agent 的
 * init）。
 *
 * 约束口径（与主 Agent 一致，仅此一项）：把主 Agent 同款的 `ContextGuardPlugin` 装到子 Agent 上
 * —— 同一个 `guardTokens`（当前模型的 `tokenThresholds.guard`），使「请求前用量超过硬线即中断」
 * 对子 Agent 同样成立。
 * **不设**轮次上限，**不设**工具调用次数上限。
 *
 * 中断语义：抛错即结束子 Agent 的 run；异常经 `AgentTool` 的 finally（分发 onSubAgentEnd）
 * 上抛至父 Agent，因父 Agent 默认 `allowJsonParseError = true` 而降级为一条工具结果文本
 * （`执行工具 X 时出错: …`），父 Agent 继续下一轮——即「软中断」：停掉越界的子 Agent，但不
 * 终止用户对话（如需硬停，父 Agent 须设 allowJsonParseError=false）。
 *
 * 覆盖范围：core 只有两条委派路径（`AgentTool` / `AgentToolLazy`），均分发 onSubAgentStart，
 * 故本插件对**全部**子 Agent 生效。SDK 的 `call_skill_sub_agent`（技能子 Agent）也走
 * `AgentToolLazy`（见 `skillTools.ts`：工具由 AgentToolLazy 承载，复用统一的委派边界），
 * 同样被覆盖——早期版本的注释说它「不分发该钩子」，那个说法在 skill 子 Agent 统一到
 * core 委派原语之后已不成立。
 */

import type { AgentPlugin, SubAgentContext } from "@ai-zen/agents-core";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";

export interface SubAgentGuardOptions {
  /** 强行阻断阈值；与主 Agent 同源（当前模型的 `tokenThresholds.guard`） */
  guardTokens: number;
}

/**
 * 子 Agent 护栏安装器（装在**宿主 Agent** 上）。
 *
 * 每次委派边界把 `ContextGuardPlugin` 装到子 Agent 身上（阈值与主 Agent 相同），并递归安插
 * 自身，使子 Agent 再委派（孙级）时同样受约束。始终返回 undefined，永不拒绝委派——是否中断
 * 由 `ContextGuardPlugin` 按阈值决定。
 */
export class SubAgentGuardInstallerPlugin implements AgentPlugin {
  private readonly guardTokens: number;

  constructor(options: SubAgentGuardOptions) {
    this.guardTokens = options.guardTokens;
  }

  onSubAgentStart({ subAgent }: SubAgentContext): void {
    // 与主 Agent 完全同款：同一个 guardTokens 绝对阈值
    subAgent.use(new ContextGuardPlugin({ guardTokens: this.guardTokens }));

    // 传染到孙级：子 Agent 若再委派，其子 Agent 同样被安插
    subAgent.use(
      new SubAgentGuardInstallerPlugin({ guardTokens: this.guardTokens }),
    );
  }
}
