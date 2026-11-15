/**
 * `AgentRegistry` —— conversationId → 挂在哪个 Scope 上的那个 agent（architecture §4）。
 *
 * 「agent 从哪来」从此只有这一个入口：`create` / `ensure` 先把 Scope 确保出来
 * （`ScopeRegistry.create` 是幂等 get-or-create，调用方不必背「先 Scope 后 agent」的顺序），
 * 再用注入的工厂造 agent、登记、返回。别处（`ChatRunner` / 交接 / 收尾）不再自己拼装配顺序。
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
 * ## agent 是常驻的：一段对话一个，跨轮复用
 *
 * 装配一次，之后每一轮都拿同一个实例（`ensure` 就是 get-or-create）：它的 `messages` 因此
 * 是这段对话的**内存真相** —— 下一轮的历史不必再回库里读一遍，也不该再往它里面 push
 * 一遍（否则同一个历史会有两份）。库里的行是它的快照，不是它的来源。
 *
 * 于是「什么时候死」也变清楚了：只有下面这几件事会让一个 agent 不再被登记
 *
 *   1. `dispose`（对话被删 / 收尾）：只丢引用，不停不结算；
 *   2. `markStale` 撞上**空闲**的那一个：配置改过，它手里的模型客户端是旧的，当场换掉；
 *   3. `markStale` 撞上**正在跑**的那一个：只打标记（那一段还得跑完），由 `ChatRunner`
 *      在结算时 `dispose` —— 下一轮 `ensure` 按新配置重新装配 = 复活；
 *   4. `fits` 说「不合用了」：会话行上的模型 / 思考档位换了（`conversation.setModel` /
 *      `setThinking`），`ChatRunner` 在复用之前问一句，不匹配就丢掉重建（模型客户端是
 *      装配那一刻读的，不重建就等于“改了模型不生效”）。
 *
 * 「有没有在跑」只有 `RunRegistry` 一个来源（构造参数 `runs`），本文件不另记一份。
 *
 * ## `dispose` 只丢引用
 *
 * 它**不 abort、不落库、不结算**：停是会话级动作（`ChatRunner.abort` / `forget`），
 * 落库结算也是一轮自己的事。这里做的是「这个 agent 不再被登记为活着」这一件事，
 * 于是 `ScopeRegistry.dispose` 才敢动手拆能力。语义顺序永远是：
 * 先停（可选）→ `agents.dispose` → `scopes.dispose`。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type { Scope } from "@ai-zen/agents-sdk";

import type { AgentBuildContext, AgentFactory, AgentStatusEvent, ChatAgent } from "./ChatRunner.js";
import type { RunsView } from "./RunRegistry.js";

/**
 * 造一个 agent 所需的一切 —— 就是装配事实减掉 `scope`。
 *
 * `scope` 不在入参里：它由 `create` 自己向 `ScopeRegistry` 要（幂等），
 * 于是「agent 一定挂在一个活着的 Scope 上」是结构性的，而不是调用方的自觉。
 */
export type AgentCreateInput = Omit<AgentBuildContext, "scope">;

/**
 * 装配事实里「会随时间变」的那几项 —— 它们一变，手里那个 agent 就是按旧事实造出来的。
 *
 * 三个字段都是**装配那一刻**从会话行上读的：模型与思考档位由 `conversation.setModel` /
 * `setThinking` 改，助手由 `conversation.create` 定死。其余入参（`conversationId` /
 * `workspaceId` / `history`）不是「事实变了」而是「归谁 / 内容多少」，不参与这套比较。
 */
export type AgentAssemblyFacts = Pick<
  AgentCreateInput,
  "agentId" | "modelId" | "thinkingLevel"
>;

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
  /**
   * 「这段对话有没有在跑一轮」—— 唯一来源（`RunRegistry` 结构上满足它）。
   *
   * 只用在 {@link AgentRegistry.markStale} 上：空闲的立刻销毁、在跑的等它结算。
   * 本文件不自己记第二份「在跑」，否则两份随时会分叉。
   */
  runs: RunsView;
  /**
   * 一段的边界（core 的 `status` 事件 + 它是哪段对话）—— 装配好一个 agent 就订上它。
   *
   * 为什么要在这里订：`AgentRegistry` 是「agent 从哪来」的唯一入口，也就知道「这个 agent 是
   * 哪段对话的」。而 `status` 的消费方（`ChatRunner`）要的正是这个对应关系 —— 让消费方反过来
   * 拿 agent 去查表，等于把「谁是谁的」再存一份。
   *
   * 不注入就不订：本注册表就只做登记（测试里多数用例不关心段边界）。
   */
  onStatus?: (event: AgentStatusEvent) => void;
}

/** 一条登记：agent、它落在哪个 Scope 上、按什么装配事实造出来的、以及「等这一段跑完就换掉」的标记 */
interface AgentEntry {
  workspaceId: string;
  agent: ChatAgent;
  /**
   * 装配它时读到的那几项事实（助手 / 模型 / 思考档位）。
   *
   * 存下来只为一件事：`fits` 要能说出「手里这个还是不是照这段对话现在的事实造的」——
   * 会话行上的模型 / 档位是会变的，而模型客户端是装配那一刻定的。
   */
  built: AgentAssemblyFacts;
  /**
   * 陈旧标记（配置改过，装配时读到的那份已经过期）。
   *
   * 只在「当时正在跑」的那一个上出现：本文件不替它停下，等它自己结算 —— 结算那一刻
   * `ChatRunner` 问一句 `isStale` 再 `dispose`。
   */
  stale: boolean;
  /** 取消订在它上面的 `status` 监听（`dispose` 时摘，见 `onStatus`） */
  offStatus?: () => void;
}

/** 从那三项事实里取一份归一化的快照（`undefined` 与 `null` 同义：都是「没有」） */
function factsOf(input: {
  agentId: string;
  modelId: string | null;
  thinkingLevel: string | null;
}): AgentAssemblyFacts {
  return {
    agentId: input.agentId,
    modelId: input.modelId ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
  };
}

export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly scopes: ScopeProvider;
  private readonly createAgent: AgentFactory;
  private readonly runs: RunsView;
  private readonly onStatus?: (event: AgentStatusEvent) => void;

  constructor(options: AgentRegistryOptions) {
    this.scopes = options.scopes;
    this.createAgent = options.createAgent;
    this.runs = options.runs;
    this.onStatus = options.onStatus;
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
    // 先摘旧的订阅（同一段对话的新 agent 顶掉旧的登记，旧的那个不再被谁持有）
    this.dispose(input.conversationId);
    this.entries.set(input.conversationId, {
      workspaceId: input.workspaceId,
      agent,
      built: factsOf(input),
      stale: false,
      offStatus: this.watch(input.conversationId, agent),
    });
    return agent;
  }

  /**
   * 订上这个 agent 的段边界（`status`），并补上「哪段对话」。
   *
   * 载荷原样透传 `from` / `to`：本文件不对段状态做任何解释，只负责把「谁的事」说清楚。
   *
   * 订阅本身没有生命周期问题（`EventBus` 挂在 agent 对象上，agent 没了监听也一起没了），
   * 摘的原因不是泄漏而是「别叫到一个已经不在登记表里的 agent 上」—— 它可能正在被换掉，
   * 而消费方（`ChatRunner`）已经按「这段对话现在是新那个」在数现场了。
   */
  private watch(conversationId: string, agent: ChatAgent): (() => void) | undefined {
    const onStatus = this.onStatus;
    if (!onStatus) return undefined;
    const forward = (ctx: { from: AgentNS.RunStatus; to: AgentNS.RunStatus }): void => {
      onStatus({ conversationId, agent, from: ctx.from, to: ctx.to });
    };
    const handle = agent.events.on("status", forward);
    if (typeof handle === "function") return handle as () => void;
    if (typeof handle === "object" && handle !== null) {
      const disposable = handle as { dispose?: () => void };
      if (typeof disposable.dispose === "function") return () => disposable.dispose!();
    }
    return undefined;
  }

  /**
   * get-or-create：这段对话有 agent 就返回**同一个实例**，没有才装配一个。
   *
   * 这是「常驻」的全部机关 —— 每一轮 (`ChatRunner.attemptOnce`) 都从这里拿 agent，于是
   * 跨轮复用的是同一个对象：它内存里的 `messages`（上一段的产出、inbox 里还没取走的条目、
   * 装好的模型客户端与插件）一段一段接着用，而不是每段重建一次。
   *
   * 已有实例时**不碰 Scope**（不 `create`、不刷新）：只交还那个对象。
   */
  async ensure(input: AgentCreateInput): Promise<ChatAgent> {
    const existing = this.entries.get(input.conversationId);
    if (existing) return existing.agent;
    return await this.create(input);
  }

  /** 这段对话现在挂着的 agent（没有就 `undefined`）：观察与「谁还活着」用 */
  get(conversationId: string): ChatAgent | undefined {
    return this.entries.get(conversationId)?.agent;
  }

  /**
   * 手里那个 agent 是不是还按**这段对话现在的事实**造出来的。
   *
   * 为什么要问：模型与思考档位存在会话行上（`conversation.setModel` / `setThinking`），而模型
   * 客户端是**装配那一刻**读的。从前一轮一装配，改了下一段自然生效；常驻之后不重建的话，换了
   * 模型还在用旧的客户端 —— 那就不是「只换了对象的寿命」而是看得见的行为变化了。所以调用方
   * （`ChatRunner.run`）在复用之前问一句，不匹配就丢掉重建（重建那一路还会按新模型重新还原
   * 历史里的素材，换模型本来就该重走那一步）。
   *
   * 没有登记时 `false`（没什么可复用的）。
   */
  fits(conversationId: string, facts: AgentAssemblyFacts): boolean {
    const entry = this.entries.get(conversationId);
    if (!entry) return false;
    const wanted = factsOf(facts);
    return (
      entry.built.agentId === wanted.agentId &&
      entry.built.modelId === wanted.modelId &&
      entry.built.thinkingLevel === wanted.thinkingLevel
    );
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
   * 把某个 Workspace 下活着的 agent 打上「陈旧」标记 —— 配置改过的生效手段。
   *
   * 为什么要换掉 agent（而不是就地刷）：`Scope.refresh()` 刷得动能力（工具、MCP），刷不动
   * 已经建好的模型客户端 —— `createModel(scope.config, …)` 是**装配那一刻**读的。所以
   * 「改了配置最迟下一段生效」必须显式重建，见 `ChatRunner` 结算那一步。
   *
   * 两种情形分开办：
   *   - **空闲**的（这段对话没有在跑的一轮）当场 `dispose`：没有要等的，而它也不会再被谁
   *     取走 —— 直接消失即可（下一段 `ensure` 重新装配）；
   *   - **正在跑**的只打标记，并且在返回值里报出来：那一段还得用旧配置跑完（不打断用户），
   *     标记由 `ChatRunner` 在结算那一刻兑现。
   *
   * @returns 被打上标记、但还没销毁的 `conversationId`（空闲的那些不在里面：它们已经没了）
   */
  markStale(workspaceId: string): string[] {
    const marked: string[] = [];
    // 先取一份键的快照：循环体里会往 `entries` 里删（`dispose`），不复制就会漏掉几项
    for (const conversationId of [...this.entries.keys()]) {
      const entry = this.entries.get(conversationId);
      if (!entry || entry.workspaceId !== workspaceId) continue;
      if (this.runs.isRunning(conversationId)) {
        entry.stale = true;
        marked.push(conversationId);
        continue;
      }
      // 空闲：没什么要等的，直接丢掉登记（只丢引用：停与结算都不是这里的事）
      this.dispose(conversationId);
    }
    return marked;
  }

  /**
   * 这个 agent 是不是「配置改过、等着结算之后换掉」。
   *
   * `ChatRunner` 在结算那一刻问一句：是就 `dispose`，下一段 `ensure` 重新装配。
   * 没有登记时 `false`（已经没了，没什么可换的）。
   */
  isStale(conversationId: string): boolean {
    return this.entries.get(conversationId)?.stale === true;
  }

  /**
   * 丢掉登记 —— **只丢引用**：不 abort、不落库、不结算（那些是会话实例的事，见文件头）。
   *
   * 陈旧标记随之一起消失（它挂在登记上）：销毁之后 `isStale` 回到 `false`。
   * 幂等：没登记就什么也不做。
   */
  dispose(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
    entry.offStatus?.();
  }
}
