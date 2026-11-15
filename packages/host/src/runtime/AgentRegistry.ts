/**
 * `AgentRegistry` —— agent **存活管理的唯一拥有者**（architecture §4）。
 *
 * 「agent 还活着没有」这个事实只有一处：本文件的 `entries`。「它该不该活着」这个策略也
 * 只在这里 —— 别处（`ChatRunner` / 交接 / 收尾）只报事件，不再自己判生灭。
 *
 * ## 七个判据（本文件是这些话的唯一落点）
 *
 * | 调用 | 什么时候 | 干什么 |
 * |---|---|---|
 * | `acquire` | 一段有事要办（跑一轮 / 投递进来发现不在） | 在且合用 → 复用同一个实例；不在 → 装配；在但装配事实变了 → 丢掉重建 |
 * | `complete` | 一段结算完 | 陈旧（配置换过）就退役，否则留着（常驻） |
 * | `discard` | 对话 / 项目被删 | 只丢引用（不 abort、不结算） |
 * | `invalidate` | 配置生效 | 空闲的当场退役（不计入返回）；正在跑的只打标记（计入返回），等它 `complete` |
 * | `disposeAll` | 进程收尾 | 全部丢引用 |
 * | `get` | 观测 | 这段对话现在挂着谁（只读） |
 * | `conversationIds` | 观测 | 还活着哪几段（可按键 Workspace 过滤，只读） |
 *
 * 每一步都报一条 {@link AgentLifecycleEvent}（`onLifecycle`）—— 「这段对话为什么没有 agent」
 * 的唯一答案就在那条流里（`reason` 说人话）。它只是观察：不注入就不报，报错也不影响判据。
 *
 * ## 三个实例的依赖关系（写在这里，而不是靠约定）
 *
 * ```
 * Workspace ──1:1── Scope ──1:N── Agent ──1:1── 会话实例
 *                 （能力容器）      （跑的人）      （这一段对话的运行时）
 * ```
 *
 * 创建自上而下（`acquire` 自己向 `ScopeRegistry` 要 Scope，它是幂等 get-or-create，于是
 * 「agent 一定挂在一个活着的 Scope 上」是结构性的）；回收自下而上（`ScopeRegistry.dispose`
 * 撞上本文件里还活着的 agent 就拒绝，见 `ScopeBusyError`）。
 *
 * ## agent 是常驻的：一段对话一个，跨轮复用
 *
 * 装配一次，之后每一轮 `acquire` 都交还同一个实例：它的 `messages` 因此是这段对话的
 * **内存真相** —— 下一轮的历史不必再回库里读一遍，也不该再往它里面 push 一遍（否则同一个
 * 历史会有两份）。库里的行是它的快照，不是它的来源。
 *
 * ## 三种「不再登记」的形状（别把它们混成一种）
 *
 *   - `discard` / `disposeAll`：**只丢引用**。停是会话级动作（`ChatRunner.abort` / `forget`），
 *     落库结算也是一轮自己的事。语义顺序永远是：先停（可选）→ `discard` → `scopes.dispose`。
 *   - `complete` 兑现陈旧标记：那一段已经跑完了，配置却换过，手里这个的模型客户端是旧的 →
 *     退役，下一段 `acquire` 按新配置重新装配。
 *   - `invalidate` 撞上空闲的那个：没什么要等的，当场退役（它不会再被谁取走）。
 *
 * 「有没有在跑」只有 `RunRegistry` 一个来源（构造参数 `runs`），本文件不另记一份。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type { Scope } from "@ai-zen/agents-sdk";

import type {
  AgentBuildContext,
  AgentFactory,
  AgentInboxEvent,
  AgentStatusEvent,
  ChatAgent,
} from "./ChatRunner.js";
import type { RunsView } from "./RunRegistry.js";

/**
 * 造一个 agent 所需的一切 —— 就是装配事实减掉 `scope`。
 *
 * `scope` 不在入参里：它由 `acquire` 自己向 `ScopeRegistry` 要（幂等），
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

/** 对一条登记做过什么：装配（首次 / 之前有过）、复用、退役 */
export type AgentLifecycleAction = "built" | "reused" | "rebuilt" | "retired";

/**
 * 为什么这么做 —— 人话，值为**闭集**（`grep` 得到的取值表就是「为什么这段对话没有 agent」
 * 的全部答案）：
 *
 * | 取值 | 出现在 | 意思 |
 * |---|---|---|
 * | `never-built` | `built` | 这段对话从来没有过 agent |
 * | `assembly-facts-unchanged` | `reused` | 手里那个还是照现在的事实造的 |
 * | `assembly-facts-changed` | `retired` + `rebuilt` | 模型 / 思考档位 / 助手换了，旧的按旧事实造的 |
 * | `config-changed` | `retired` | 配置生效，`invalidate` 撞上**空闲**的那个 |
 * | `stale-on-settle` | `retired` | 配置生效时它正在跑（只打了标记），结算这一刻才兑现 |
 * | `conversation-deleted` | `retired` | `discard`：对话或项目被删 |
 * | `shutdown` | `retired` | `disposeAll`：进程收尾 |
 */
export type AgentLifecycleReason =
  | "never-built"
  | "assembly-facts-unchanged"
  | "assembly-facts-changed"
  | "config-changed"
  | "stale-on-settle"
  | "conversation-deleted"
  | "shutdown";

/** 一条生命周期事件（观察用：只回答「为什么在 / 为什么不在」，不参与任何判据） */
export interface AgentLifecycleEvent {
  conversationId: string;
  action: AgentLifecycleAction;
  /** 人话理由，见 {@link AgentLifecycleReason} 那张表 */
  reason: AgentLifecycleReason;
}

export interface AgentRegistryOptions {
  /** Scope 的持有者：`acquire` 内部向它要 Scope（它自己是幂等的 get-or-create） */
  scopes: ScopeProvider;
  /** 造 agent 的工厂（生产用 `createSdkAgentFactory()`，用例注入假 agent） */
  createAgent: AgentFactory;
  /**
   * 「这段对话有没有在跑一轮」—— 唯一来源（`RunRegistry` 结构上满足它）。
   *
   * 只用在 {@link AgentRegistry.invalidate} 上：空闲的立刻退役、在跑的等它结算。
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
  /**
   * 往这段对话的 inbox 里入队了一条（core 的 `inbox` 事件 + 它是哪段对话）—— 装配好一个 agent
   * 就订上它，不注入就不订。
   *
   * 与 `onStatus` 同一个理由订在这里：消费方（`ChatRunner`）要的是「这段对话 + 条目的来源」，
   * 而「这段对话」只有本注册表知道。消费它的是**一条观察值**（自起段结算时报给宿主的
   * `source`），归谁叫醒、能不能叫醒仍归 core。
   */
  onInbox?: (event: AgentInboxEvent) => void;
  /**
   * 每做一次生灭决定就报一条（{@link AgentLifecycleEvent}）—— 接线层接到日志上即可。
   *
   * 存在的理由：从前「这段对话的 agent 为什么不在」没人答得上来（没建过 / 不合用 / 配置换掉 /
   * 被删 / 重启各在别处发生）。现在五条判据都收在本文件里，理由就顺手从同一个地方报出去。
   *
   * 只是观察：不注入 = 不报；消费方出错不影响判据。
   */
  onLifecycle?: (event: AgentLifecycleEvent) => void;
}

/** 一条登记：agent、它落在哪个 Scope 上、按什么装配事实造出来的、以及「等这一段跑完就换掉」的标记 */
interface AgentEntry {
  workspaceId: string;
  agent: ChatAgent;
  /**
   * 装配它时读到的那几项事实（助手 / 模型 / 思考档位）。
   *
   * 存下来只为一件事：`acquire` 要能说出「手里这个还是不是照这段对话现在的事实造的」——
   * 会话行上的模型 / 档位是会变的，而模型客户端是装配那一刻定的。
   */
  built: AgentAssemblyFacts;
  /**
   * 陈旧标记（配置改过，装配时读到的那份已经过期）。
   *
   * 只在「当时正在跑」的那一个上出现：本文件不替它停下，等它自己结算 —— 结算那一刻
   * `ChatRunner` 调 `complete`，陈旧就退役。
   */
  stale: boolean;
  /** 取消订在它上面的 `status` / `inbox` 监听（退役时摘，见 `watch`） */
  offWatch?: () => void;
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
  /**
   * 「这段对话上一次是因为什么没有 agent 的」——只记**还会回来**的那几种理由
   * （对话删了 / 进程收尾之后没人再问）。
   *
   * 它的唯一用处：这段对话不在登记里时，`acquire` 才能分清这一次是 `built`（从来没有过）
   * 还是 `rebuilt`（有过，上一个被前面某个判据退役了），并把那个理由说出来。
   */
  private readonly retired = new Map<string, AgentLifecycleReason>();
  private readonly scopes: ScopeProvider;
  private readonly createAgent: AgentFactory;
  private readonly runs: RunsView;
  private readonly onStatus?: (event: AgentStatusEvent) => void;
  private readonly onInbox?: (event: AgentInboxEvent) => void;
  private readonly onLifecycle?: (event: AgentLifecycleEvent) => void;

  constructor(options: AgentRegistryOptions) {
    this.scopes = options.scopes;
    this.createAgent = options.createAgent;
    this.runs = options.runs;
    this.onStatus = options.onStatus;
    this.onInbox = options.onInbox;
    this.onLifecycle = options.onLifecycle;
  }

  /**
   * 一段有事要办：**在且合用 → 复用；不在 → 装配；在但装配事实变了 → 丢掉重建**。
   *
   * 这是「常驻」的全部机关 —— 每一轮 (`ChatRunner.attemptOnce`) 与每次投递复活都从这里拿
   * agent，于是跨轮复用的是同一个对象：它内存里的 `messages`（上一段的产出、inbox 里还没取走
   * 的条目、装好的模型客户端与插件）一段一段接着用，而不是每段重建一次。
   *
   * 合不合用为什么要在这里判：模型与思考档位存在会话行上（`conversation.setModel` /
   * `setThinking`），而模型客户端是**装配那一刻**读的。从前一轮一装配，改了下一段自然生效；
   * 常驻之后不重建的话，换了模型还在用旧的客户端 —— 那就不是「只换了对象的寿命」而是看得见
   * 的行为变化了。于是「复用前问一句」成了本文件的内部实现，调用方只说「我要一段有事要办」。
   *
   * 已有实例且合用时**不碰 Scope**（不 `create`、不刷新）：只交还那个对象。
   */
  async acquire(input: AgentCreateInput, facts: AgentAssemblyFacts): Promise<ChatAgent> {
    const existing = this.entries.get(input.conversationId);
    if (existing) {
      if (this.fits(existing.built, facts)) {
        this.report(input.conversationId, "reused", "assembly-facts-unchanged");
        return existing.agent;
      }
      // 手里这个是按旧事实造的：模型客户端 / 思考档位在装配那一刻定死，就地刷不动 → 丢掉重建
      this.retire(input.conversationId, "assembly-facts-changed");
      return await this.assemble(input, "rebuilt", "assembly-facts-changed");
    }
    // 不在：这段对话以前有过 agent 吗？有过 → 它是被前面某个判据退役的，理由记在 `retired` 里
    const why = this.retired.get(input.conversationId);
    return await this.assemble(
      input,
      why === undefined ? "built" : "rebuilt",
      why ?? "never-built",
    );
  }

  /**
   * 一段结算完：陈旧（配置换过）就退役，否则留着。
   *
   * 陈旧的兑现处只有这里：`invalidate` 撞上正在跑的那一个时只打标记（那一段还得用旧配置跑完，
   * 不打断用户），标记留到这一段真的结束 —— 丢掉登记，下一段 `acquire` 按新配置重新装配。
   *
   * 顺序上它必须排在 `RunRegistry.finish` **之后**：两步之间没有 await，`invalidate` 插不进来；
   * 反过来（先判后 finish）插进来的 `invalidate` 会看见「还在跑」而只打标记 —— 那个标记就没人
   * 再来兑现了（这一段已经过了检查点）。先 finish 则它看见「空闲」，当场就能退役。
   */
  complete(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || !entry.stale) return;
    this.retire(conversationId, "stale-on-settle");
  }

  /**
   * 对话（或它所在的项目）没了：只丢引用 —— **不 abort、不落库、不结算**。
   *
   * 停与结算都是会话级动作（`ChatRunner.abort` / `forget`），本文件只做「不再登记为活着」
   * 这一件事，于是 `ScopeRegistry.dispose`（删项目）才敢动手拆能力。幂等：没登记就什么也不做。
   */
  discard(conversationId: string): void {
    this.retire(conversationId, "conversation-deleted");
  }

  /**
   * 配置改过的生效手段：这个 Workspace 下活着的 agent 该换掉了。
   *
   * 为什么要换掉 agent（而不是就地刷）：`Scope.refresh()` 刷得动能力（工具、MCP），刷不动
   * 已经建好的模型客户端 —— `createModel(scope.config, …)` 是**装配那一刻**读的。
   *
   * 两种情形分开办：
   *   - **空闲**的（这段对话没有在跑的一轮）当场退役：没有要等的，而它也不会再被谁取走；
   *   - **正在跑**的只打标记，并且在返回值里报出来：那一段还得用旧配置跑完（不打断用户），
   *     标记由 {@link complete} 在结算那一刻兑现。
   *
   * @returns 被打上标记、但还没退役的 `conversationId`（空闲的那些不在里面：它们已经没了）
   */
  invalidate(workspaceId: string): string[] {
    const marked: string[] = [];
    // 先取一份键的快照：循环体里会往 `entries` 里删，不复制就会漏掉几项
    for (const conversationId of [...this.entries.keys()]) {
      const entry = this.entries.get(conversationId);
      if (!entry || entry.workspaceId !== workspaceId) continue;
      if (this.runs.isRunning(conversationId)) {
        entry.stale = true;
        marked.push(conversationId);
        continue;
      }
      // 空闲：没什么要等的，直接丢掉登记（只丢引用：停与结算都不是这里的事）
      this.retire(conversationId, "config-changed");
    }
    return marked;
  }

  /** 收尾：全部丢引用（进程要退了，没有「稍后再丢」这回事）。幂等。 */
  disposeAll(): void {
    for (const conversationId of [...this.entries.keys()]) {
      this.retire(conversationId, "shutdown");
    }
    // 收尾之后没人再来问「为什么它不在」了：理由不用留着
    this.retired.clear();
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
   * 手里那个 agent 是不是还按**这段对话现在的事实**造出来的 —— `acquire` 的唯一判据。
   *
   * 私有：调用方不该「复用前问一句」（那是它反问自己的实现细节），只该说「我要一段有事要办」。
   */
  private fits(built: AgentAssemblyFacts, facts: AgentAssemblyFacts): boolean {
    const wanted = factsOf(facts);
    return (
      built.agentId === wanted.agentId &&
      built.modelId === wanted.modelId &&
      built.thinkingLevel === wanted.thinkingLevel
    );
  }

  /**
   * 真的装一个：先把 Scope 确保出来（幂等），再交给工厂装配，然后登记。
   *
   * 装配失败不留下登记（下一次 `acquire` 重新尝试），也没有 Scope 的账要抹平：Scope 活着就是
   * 有人持有它，不因为这一次装配失败而回收。
   */
  private async assemble(
    input: AgentCreateInput,
    action: AgentLifecycleAction,
    reason: AgentLifecycleReason,
  ): Promise<ChatAgent> {
    const scope = await this.scopes.create(input.workspaceId);
    const agent = await this.createAgent({ ...input, scope });
    // 一段对话同时只有一个 agent：新造的这个顶掉旧的登记（丢掉只是引用，不停旧的 —— 停是
    // 会话级动作）。走到这里时旧的那个要么已经退役（不合用那条路），要么是同一段对话的并发
    // 装配 —— 后者不该被报成一次「退役」，所以这里只摘订阅、不报事件。
    this.drop(input.conversationId);
    this.entries.set(input.conversationId, {
      workspaceId: input.workspaceId,
      agent,
      built: factsOf(input),
      stale: false,
      offWatch: this.watch(input.conversationId, agent),
    });
    // 它现在在了：上一轮退役留下的那条理由不再成立
    this.retired.delete(input.conversationId);
    this.report(input.conversationId, action, reason);
    return agent;
  }

  /**
   * 丢掉一条登记并按理由报一次 `retired`（没有登记就什么也不做，也不报）。
   *
   * 只丢引用：不 abort、不落库、不结算（见文件头）。
   */
  private retire(conversationId: string, reason: AgentLifecycleReason): void {
    if (!this.drop(conversationId)) return;
    // 记下「为什么它不在了」：只有还会回来的那几种值得记（对话删了 / 进程收尾之后没人再问）
    if (reason !== "conversation-deleted" && reason !== "shutdown") {
      this.retired.set(conversationId, reason);
    }
    this.report(conversationId, "retired", reason);
  }

  /**
   * 摘掉一条登记（**只丢引用**），返回摘下来的那条 —— 不报事件、不记理由。
   *
   * `retire` 与「新装配的顶掉旧的」共用它：两件事都只是「不再登记为活着」，区别只在要不要
   * 说出理由。
   */
  private drop(conversationId: string): AgentEntry | undefined {
    const entry = this.entries.get(conversationId);
    if (!entry) return undefined;
    this.entries.delete(conversationId);
    entry.offWatch?.();
    return entry;
  }

  /** 报一条生命周期事件（只是观察：不注入就没有听众） */
  private report(
    conversationId: string,
    action: AgentLifecycleAction,
    reason: AgentLifecycleReason,
  ): void {
    this.onLifecycle?.({ conversationId, action, reason });
  }

  /**
   * 订上这个 agent 的两条观察线（`status` 段边界、`inbox` 入队），并补上「哪段对话」。
   *
   * 载荷原样透传：本文件不对段状态与 inbox 条目做任何解释，只负责把「谁的事」说清楚。
   *
   * 订阅本身没有生命周期问题（`EventBus` 挂在 agent 对象上，agent 没了监听也一起没了），
   * 摘的原因不是泄漏而是「别叫到一个已经不在登记表里的 agent 上」—— 它可能正在被换掉，
   * 而消费方（`ChatRunner`）已经按「这段对话现在是新那个」在数现场了。
   */
  private watch(conversationId: string, agent: ChatAgent): (() => void) | undefined {
    const offs: Array<() => void> = [];
    const onStatus = this.onStatus;
    if (onStatus) {
      const off = toUnsubscribe(
        agent.events.on("status", (ctx: { from: AgentNS.RunStatus; to: AgentNS.RunStatus }) => {
          onStatus({ conversationId, agent, from: ctx.from, to: ctx.to });
        }),
      );
      if (off) offs.push(off);
    }
    const onInbox = this.onInbox;
    if (onInbox) {
      const off = toUnsubscribe(
        agent.events.on("inbox", (ctx: { entry: AgentNS.InboxEntry }) => {
          onInbox({ conversationId, agent, entry: ctx.entry });
        }),
      );
      if (off) offs.push(off);
    }
    if (offs.length === 0) return undefined;
    return () => {
      for (const off of offs) off();
    };
  }
}

/**
 * `events.on` 的返回值归一成「取消订阅」一个函数。
 *
 * 两种形态都认（取消函数 / 可 `dispose` 的句柄）；认不出来就当作订不上（返回 `undefined`）——
 * 那不该是错误，只是一个观察点没接上。
 */
function toUnsubscribe(handle: unknown): (() => void) | undefined {
  if (typeof handle === "function") return handle as () => void;
  if (typeof handle === "object" && handle !== null) {
    const disposable = handle as { dispose?: () => void };
    if (typeof disposable.dispose === "function") return () => disposable.dispose!();
  }
  return undefined;
}
