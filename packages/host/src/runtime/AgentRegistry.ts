/**
 * `AgentRegistry` —— conversationId → 正在跑的那个 agent（architecture §4）。
 *
 * 「agent 从哪来」从此只有这一个入口：`create` 先把 Scope 确保出来（`ScopeRegistry.create`
 * 是幂等 get-or-create，调用方不必背「先 Scope 后 agent」的顺序），再用注入的工厂造 agent、
 * 登记、返回。别处（`ChatRunner` / 交接 / 收尾）不再自己拼装配顺序。
 *
 * ## 三个实例的依赖关系（写在这里，而不是靠约定）
 *
 * ```
 * Workspace ──1:1── Scope ──1:N── Agent ──1:1── 会话实例
 *                 （能力容器）      （跑的人）      （这一段对话的运行时）
 * ```
 *
 * 创建自上而下（本文件的 `create` 先要 Scope）；回收自下而上（`ScopeRegistry.dispose`
 * 撞上本文件里还活着的 agent 就拒绝，见 `ScopeBusyError`）。
 *
 * ## `dispose` 只丢引用
 *
 * 它**不 abort、不落库、不结算**：停是会话级动作（`ChatRunner.abort` / `forget`），
 * 落库结算也是一轮自己的事。这里做的是「这个 agent 不再被登记为活着」这一件事，
 * 于是 `ScopeRegistry.dispose` 才敢动手拆能力。语义顺序永远是：
 * 先停（可选）→ `agents.dispose` → `scopes.dispose`。
 *
 * ## 这一单的寿命没变
 *
 * agent 仍然是「一轮造一个、跑完即丢」（PRD D28）：`ChatRunner` 在 `attemptOnce` 里
 * `create`、在 `settle` 里 `dispose`。本文件只是把这两个动作从散落的隐式代码变成一对
 * 显式 API；改成「常驻」是下一单的事（那时只改「谁在什么时候调它们」）。
 */

import type { Scope } from "@ai-zen/agents-sdk";

import type { AgentBuildContext, AgentFactory, ChatAgent } from "./ChatRunner.js";

/**
 * 造一个 agent 所需的一切 —— 就是装配事实减掉 `scope`。
 *
 * `scope` 不在入参里：它由 `create` 自己向 `ScopeRegistry` 要（幂等），
 * 于是「agent 一定挂在一个活着的 Scope 上」是结构性的，而不是调用方的自觉。
 */
export type AgentCreateInput = Omit<AgentBuildContext, "scope">;

/**
 * 取 Scope 的口子（结构上 `ScopeRegistry` 满足）：只要 get-or-create 这一件事。
 *
 * 写窄口的理由与本文件的其他引脚一样：agent 注册表需要的是「给我那个能力容器」，
 * 不是「一个能销毁/刷新别人的 Scope 注册表」。
 */
export interface ScopeProvider {
  create(workspaceId: string): Promise<Scope>;
}

export interface AgentRegistryOptions {
  /** Scope 的持有者：`create` 内部向它要 Scope（它自己是幂等的 get-or-create） */
  scopes: ScopeProvider;
  /** 造 agent 的工厂（生产用 `createSdkAgentFactory()`，用例注入假 agent） */
  createAgent: AgentFactory;
}

/** 一条登记：agent 与它落在哪个 Scope 上 */
interface AgentEntry {
  workspaceId: string;
  agent: ChatAgent;
}

export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly scopes: ScopeProvider;
  private readonly createAgent: AgentFactory;

  constructor(options: AgentRegistryOptions) {
    this.scopes = options.scopes;
    this.createAgent = options.createAgent;
  }

  /**
   * 造一个 agent 并登记它 —— agent 唯一的来源。
   *
   * 先 `scopes.create(workspaceId)`（幂等：已经有一个就复用同一个实例），再交给工厂装配。
   * 装配失败不留下登记（下一次 `create` 重新尝试），也没有 Scope 的账要抹平
   * —— Scope 活着就是有人持有它，不因为这一次装配失败而回收。
   *
   * 同一段对话已经有 agent 时，新造的那个顶掉旧的登记（一段对话同时只有一个 agent 在跑）；
   * 顶掉的只是引用，不停旧的（停是会话级动作）。
   */
  async create(input: AgentCreateInput): Promise<ChatAgent> {
    const scope = await this.scopes.create(input.workspaceId);
    const agent = await this.createAgent({ ...input, scope });
    this.entries.set(input.conversationId, { workspaceId: input.workspaceId, agent });
    return agent;
  }

  /** 这段对话现在挂着的 agent（没有就 `undefined`）：观察与「谁还活着」用 */
  get(conversationId: string): ChatAgent | undefined {
    return this.entries.get(conversationId)?.agent;
  }

  /**
   * 还活着哪几段对话（可以按 Workspace 过滤）。
   *
   * 两个用处：`ScopeRegistry.dispose` 被挡下来时的拒绝理由（`ScopeBusyError.conversationIds`），
   * 以及观测（用例/日志问「现在还有谁活着」）。
   */
  conversationIds(workspaceId?: string): string[] {
    const ids: string[] = [];
    for (const [conversationId, entry] of this.entries) {
      if (workspaceId === undefined || entry.workspaceId === workspaceId) ids.push(conversationId);
    }
    return ids;
  }

  /**
   * 丢掉登记 —— **只丢引用**：不 abort、不落库、不结算（那些是会话实例的事，见文件头）。
   *
   * 幂等：没登记就什么也不做。
   */
  dispose(conversationId: string): void {
    this.entries.delete(conversationId);
  }
}
