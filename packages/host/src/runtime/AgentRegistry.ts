/**
 * `AgentRegistry` —— agent **存活管理的唯一拥有者**（PLAN §4）。
 *
 * 「agent 还活着没有」这个事实只有一处：本文件的 `entries`。「它该不该活着」这个策略也
 * 只在这里 —— 别处（`ChatRunner` / 交接 / 收尾）只报事件，不再自己判生灭。
 *
 * ## 七个判据（本文件是这些话的唯一落点）
 *
 * | 调用 | 什么时候 | 干什么 |
 * |---|---|---|
 * | `acquire` | 有人要说话（投递进来，发现其实不在） | 在且合用 → 复用同一个实例；不在 → 装配；在但装配事实变了 → 丢掉重建 |
 * | `complete` | 变闲那一刻（core 的 `state:idle`） | 陈旧（配置换过）就退役，否则留着（常驻） |
 * | `kill` | 会话 / 项目被删 | **`agent.kill()`（立刻死，存量作废）** + 丢引用 |
 * | `killAll` | 项目/Scope 被显式处置 | 同一个 Workspace 下的 agent 全部 `kill()` + 丢引用 |
 * | `invalidate` | 全局配置生效（整个 Workspace） | 空闲的当场退役（不计入返回）；正在跑的只打标记（计入返回），等它 `complete` |
 * | `invalidateSession` | 这一段会话的出厂配置变了（换模型 / 换思考档位） | 与 `invalidate` 同一对分支：空闲的当场退役；在跑的只打标记 |
 * | `disposeAll` | 进程收尾 | 全部 `kill()` 后丢引用 |
 * | `get` | 观测 | 这段会话现在挂着谁（只读） |
 * | `sessionIds` | 观测 | 还活着哪几段（按 Workspace，只读） |
 *
 * 每一步都报一条 {@link AgentLifecycleEvent}（`onLifecycle`）—— 「这段会话为什么没有 agent」
 * 的唯一答案就在那条流里（`reason` 说人话）。它只是观察：不注入就不报，报错也不影响判据；
 * `ChatRunner` 从同一个口订一路自己的（`observeLifecycle`，靠它拆掉那段会话的常驻桥）。
 *
 * ## 三个实例的依赖关系（写在这里，而不是靠约定）
 *
 * ```
 * Workspace ──1:1── Scope ──1:N── Agent ──1:1── 常驻桥
 *                 （能力容器）      （跑的人）      （`ChatRunner` 手上那一条）
 * ```
 *
 * 创建自上而下（`acquire` 自己向 `ScopeRegistry` 要 Scope，它是幂等 get-or-create，于是
 * 「agent 一定挂在一个活着的 Scope 上」是结构性的）；回收自下而上（`ScopeRegistry.dispose`
 * 撞上本文件里还活着的 agent 就拒绝，见 `ScopeBusyError`）。
 *
 * ## agent 是常驻的：一段会话一个，跨投递复用
 *
 * 装配一次，之后每一次 `acquire` 都交还同一个实例：它的 `messages` 因此是这段会话的
 * **内存真相** —— 再投一条时不必回库里读一遍历史，也不该再往它里面 push 一遍（否则同一个
 * 历史会有两份）。库里的行是它的快照，不是它的来源。
 *
 * ## 两种「不再登记」的形状（别把它们混成一种）
 *
 *   - `kill` / `killAll` / `disposeAll`：**硬着陆**。那几段会话（或那个项目）已经不要了，
 *     所以 agent 要真的死（`kill()`：掐在途、存量作废），而不是只从账上消失。只丢引用会留下
 *     一个还捧着队列与在途请求的活 agent —— 它会接着烧 token、接着往库里写。语义顺序：
 *     `ChatRunner.forget`（先丢掉那条桥，再 `kill`）→ `scopes.dispose`。
 *   - `complete` 兑现陈旧标记：它闲下来了，但配置换过，手里这个的模型客户端是旧的 →
 *     退役，下一次 `acquire` 按新配置重新装配。
 *   - `invalidate` / `invalidateSession` 撞上空闲的那个：没什么要等的，当场退役（它不会
 *     再被谁取走）。
 *
 * 后两种**不 kill**：那是「换一个新的」，而它手上那一批还得用旧配置跑完。
 *
 * 「有没有在跑」直接读 agent 手上那一格（`agent.state === "working"`，`CORE.md` §4）：状态不是
 * 第二份账，是循环此刻走到哪儿。本文件不另记一份「在跑」 —— 从前那本账叫 `RunRegistry`，
 * 它随「没有轮」一起废掉了。
 *
 * 「还收不收件」是**另一处状态**（`agent.isOutputPaused`）：它说的是「从下一批起还收不收件」，
 * 不是「手上有活」。两件事各有各的格，所以本文件判「手上有没有活」只看 `state`。
 */

import type { Scope } from "@ai-zen/agents-sdk";

import type { AgentBuildContext, AgentFactory, ChatAgent } from "./ChatRunner.js";

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
 * 三个字段都是**装配那一刻**从会话行上读的：模型与思考档位由 `session.setModel` /
 * `setThinking` 改，助手由 `session.create` 定死。其余入参（`sessionId` /
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
 * 为什么这么做 —— 人话，值为**闭集**（`grep` 得到的取值表就是「为什么这段会话没有 agent」
 * 的全部答案）：
 *
 * | 取值 | 出现在 | 意思 |
 * |---|---|---|
 * | `never-built` | `built` | 这段会话从来没有过 agent |
 * | `assembly-facts-unchanged` | `reused` | 手里那个还是照现在的事实造的 |
 * | `assembly-facts-changed` | `retired`（`invalidateSession` / `acquire`）+ `rebuilt`（`acquire`） | 模型 / 思考档位 / 助手换了，旧的按旧事实造的 |
 * | `config-changed` | `retired` | 配置生效，`invalidate` 撞上**空闲**的那个 |
 * | `stale-on-idle` | `retired` | 配置生效时它正干着活（只打了标记），变闲那一刻才兑现 |
 * | `session-deleted` | `retired` | `kill` / `killAll`：会话或项目被删 |
 * | `shutdown` | `retired` | `disposeAll`：进程收尾 |
 */
export type AgentLifecycleReason =
  | "never-built"
  | "assembly-facts-unchanged"
  | "assembly-facts-changed"
  | "config-changed"
  | "stale-on-idle"
  | "session-deleted"
  | "shutdown";

/** 一条生命周期事件（观察用：只回答「为什么在 / 为什么不在」，不参与任何判据） */
export interface AgentLifecycleEvent {
  sessionId: string;
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
   * 每做一次生灭决定就报一条（{@link AgentLifecycleEvent}）—— 接线层接到日志上即可。
   *
   * 内部还有一路用 {@link AgentRegistry.observeLifecycle} 注册的观察者（`ChatRunner` 靠它把
   * 常驻桥拆掉）：两路内容完全一样，只是一个由构造参数给、一个由持有者自己订。
   *
   * 存在的理由：从前「这段会话的 agent 为什么不在」没人答得上来（没建过 / 不合用 / 配置换掉 /
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
   * 存下来只为一件事：`acquire` 要能说出「手里这个还是不是照这段会话现在的事实造的」——
   * 会话行上的模型 / 档位是会变的，而模型客户端是装配那一刻定的。
   */
  built: AgentAssemblyFacts;
  /** 取消订在它上面的那条观察线（那一格；退役时摘） */
  /**
   * 陈旧标记（配置改过，装配时读到的那份已经过期）。
   *
   * 只在「当时正干着活」的那一个上出现：本文件不替它停下，等它自己闲下来 —— 那一刻
   * `ChatRunner` 调 `complete`，陈旧就退役。
   */
  stale: boolean;
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
   * 那一格的观察者（`ChatRunner` 在构造时把自己注册进来）。
   *
   * 为什么订阅在这里、而不在消费方：宿主手上的每个 agent 都是本文件发出去的（装配那一刻
   * 才知道「它是哪段会话的」）。订阅安在装配处，「一段跑完了」这件事就不靠谁记得接线 ——
   * 忘一个接线点就没人接那一跳，而那是一种**静默**的坏法。
   *
   * 从前这里还有一路「inbox 多了一条」的观察者（供 `ChatRunner` 记排队区镜像）：那个镜像已经
   * 删了 —— 排队区改成现读 `agent.inboxPending`（core 取走条目时不发事件，靠通知自建镜像只能
   * 与真队列分叉）。本文件于是只观察那一格。
   */
  /**
   * 生灭决定的观察者（与那一格那一路同一个形状，见 {@link observeLifecycle}）。
   *
   * 它与构造参数 `onLifecycle` 的区别只在**谁订**：那一个是接线层的日志口，这一个给
   * `ChatRunner` —— 它要凭 `action: "retired"` 把那段会话的常驻桥拆掉（bridge 的生灭只能
   * 跟着 agent 的生灭走，别处再记一份「桥在不在」就是第二份事实）。
   */
  private readonly lifecycleObservers = new Set<(event: AgentLifecycleEvent) => void>();
  /**
   * 「这段会话上一次是因为什么没有 agent 的」——只记**还会回来**的那几种理由
   * （会话删了 / 进程收尾之后没人再问）。
   *
   * 它的唯一用处：这段会话不在登记里时，`acquire` 才能分清这一次是 `built`（从来没有过）
   * 还是 `rebuilt`（有过，上一个被前面某个判据退役了），并把那个理由说出来。
   */
  private readonly retired = new Map<string, AgentLifecycleReason>();
  private readonly scopes: ScopeProvider;
  private readonly createAgent: AgentFactory;
  private readonly onLifecycle?: (event: AgentLifecycleEvent) => void;

  constructor(options: AgentRegistryOptions) {
    this.scopes = options.scopes;
    this.createAgent = options.createAgent;
    this.onLifecycle = options.onLifecycle;
  }

  /**
   * 一段有事要办：**在且合用 → 复用；不在 → 装配；在但装配事实变了 → 丢掉重建**。
   *
   * 这是「常驻」的全部机关 —— 每次投递（发现它不在就复活）都从这里拿
   * agent，于是跨请求复用的是同一个对象：它内存里的 `messages`（上一段的产出、inbox 里还没取走
   * 的条目、装好的模型客户端与插件）一段一段接着用，而不是每段重建一次。
   *
   * 合不合用为什么要在这里判：模型与思考档位存在会话行上（`session.setModel` /
   * `setThinking`），而模型客户端是**装配那一刻**读的。从前一次装配只管一次，改了下次自然生效；
   * 常驻之后不重建的话，换了模型还在用旧的客户端 —— 那就不是「只换了对象的寿命」而是看得见
   * 的行为变化了。于是「复用前问一句」成了本文件的内部实现，调用方只说「我要一段有事要办」。
   *
   * 已有实例且合用时**不碰 Scope**（不 `create`、不刷新）：只交还那个对象。
   */
  async acquire(input: AgentCreateInput, facts: AgentAssemblyFacts): Promise<ChatAgent> {
    const existing = this.entries.get(input.sessionId);
    if (existing) {
      if (this.fits(existing.built, facts)) {
        this.report(input.sessionId, "reused", "assembly-facts-unchanged");
        return existing.agent;
      }
      // 手里这个是按旧事实造的：模型客户端 / 思考档位在装配那一刻定死，就地刷不动 → 丢掉重建
      this.retire(input.sessionId, "assembly-facts-changed");
      return await this.assemble(input, "rebuilt", "assembly-facts-changed");
    }
    // 不在：这段会话以前有过 agent 吗？有过 → 它是被前面某个判据退役的，理由记在 `retired` 里
    const why = this.retired.get(input.sessionId);
    return await this.assemble(
      input,
      why === undefined ? "built" : "rebuilt",
      why ?? "never-built",
    );
  }

  /**
   * 变闲了（core 的 `state:idle`）：陈旧（配置换过）就退役，否则留着。
   *
   * 陈旧的兑现处只有这里：`invalidate` 撞上正在跑的那一个时只打标记（那一段还得用旧配置跑完，
   * 不打断用户），标记留到这一段真的结束 —— 丢掉登记，下一段 `acquire` 按新配置重新装配。
   *
   * 调用时机是**变闲那一刻**（`ChatRunner` 收到 core 的 `state:idle`）：那一刻 agent 自己已经
   * 是 `idle` 了，所以紧跟其后的 `invalidate` 读到的是「空闲」，当场就能退役 —— 这也是
   * `invalidate` 不看别的账本、只读 `agent.state` 的理由。
   */
  complete(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.stale) return;
    this.retire(sessionId, "stale-on-idle");
  }

  /**
   * 会话（或它所在的项目）没了：**`kill()` 然后丢引用**。
   *
   * 为何是 `kill` 而不是 `stop`：`stop` 是「关门，存量走完」—— 而用户删了这段会话，队列里那
   * 几句与在途的那一批就没有去处了，把它们跑完等于对着一片空地烧 token、往库里写一行没人会
   * 读的消息。`kill` 硬着陆（存量作废、在途中断）才是「删了」的意思。
   *
   * 幂等：没登记就什么也不做（会话可能已被删两次，或者从未装配过）。
   *
   * 前提：kill 之后这个实例**不可复活**（`push` 抛 `AgentError("closed")`）。调用方（`ChatRunner.forget`）
   * 已经把通往它的每一条路先断掉（常驻桥、装配窗口里的缓冲、会话行）；真要撞上已关门的
   * `push`，那个错会回到投递方 —— 投递唯一的入口就在那一处。
   */
  kill(sessionId: string): void {
    this.killEntry(sessionId, "session-deleted");
  }

  /**
   * 一整个 Workspace（= 一个 Scope）下的 agent 全部 `kill()`。
   *
   * 用在「项目被删 / Scope 被显式处置」那一刻：能力容器要拆了，它下面那些 agent 没有一个还有
   * 意义（它们服务的就是这个项目），而且它们手里的 MCP 连接与工具马上就要随 Scope 一起没。
   * 先 kill 再 `scopes.dispose`，于是「拆 Scope」不会因为还挂着活 agent 而被拒绝。
   *
   * 只接 Workspace：本方法就是「那个项目不要了」这一个意思（收尾那种「全部」在
   * {@link disposeAll} 里，不靠一个可选参数混进来）。
   */
  killAll(workspaceId: string): void {
    // 先取键的快照：循环体里会往 `entries` 里删
    for (const sessionId of [...this.entries.keys()]) {
      const entry = this.entries.get(sessionId);
      if (!entry || entry.workspaceId !== workspaceId) continue;
      this.killEntry(sessionId, "session-deleted");
    }
  }

  /**
   * 配置改过的生效手段：这个 Workspace 下活着的 agent 该换掉了。
   *
   * 为什么要换掉 agent（而不是就地刷）：`Scope.refresh()` 刷得动能力（工具、MCP），刷不动
   * 已经建好的模型客户端 —— `createModel(scope.config, …)` 是**装配那一刻**读的。
   *
   * 两种情形分开办（判据是手上有没有活，不是别的账本，也与收不收件无关）：
   *   - **闲**的当场退役：它手上没有活，而它也不会再被谁取走；
   *   - **在干**的只打标记，并且在返回值里报出来：它手上那一批还得用旧配置跑完（不打断用户），
   *     标记由 {@link complete} 在变闲那一刻兑现。
   *
   * 不收件、但手上有活的那种（那批正在跑）算「在干」：那批跑完照样报闲，标记到那一刻兑现。
   *
   * **「只打标记」那一支只为这条路留着**：全局配置生效（PRD 4.11 / D34）**不杀任何会话** ——
   * 用户改的是「以后都用什么」，正在跑的那一批不该被打断，所以它只挂一个标记，等自己闲下来
   * 再换人。换模型 / 换思考档位那条路（{@link invalidateSession}）用的也是这一支，但那边
   * 的前提是「已经确认空闲」，标记基本撞不到。
   *
   * @returns 被打上标记、但还没退役的 `sessionId`（闲的那些不在里面：它们已经没了）
   */
  invalidate(workspaceId: string): string[] {
    const marked: string[] = [];
    // 先取一份键的快照：循环体里会往 `entries` 里删，不复制就会漏掉几项
    for (const sessionId of [...this.entries.keys()]) {
      const entry = this.entries.get(sessionId);
      if (!entry || entry.workspaceId !== workspaceId) continue;
      if (this.markStaleIfWorking(entry)) {
        marked.push(sessionId);
        continue;
      }
      // 手上没活（闲）：没什么要等的，直接丢掉登记（只丢引用：停与写库都不是这里的事）
      this.retire(sessionId, "config-changed");
    }
    return marked;
  }

  /**
   * **这一段会话**的出厂配置变了（换模型 / 换思考档位改的就是它）：手里那个 agent 不能留着。
   *
   * 为什么不能留：模型客户端与思考参数都是装配那一刻读的（`createModel(scope.config, …)` +
   * `sessionModelParams`），会话行改了也不会跟着变 —— 留着它就等于「换了模型还在用旧的
   * 客户端」。所以改完会话行当场退役：下一句话按新事实重新装配，中间不留一个「半新半旧」的
   * agent（不搞「先打标记、变闲再兑现」那一套）。
   *
   * 与 {@link invalidate} 是同一对分支、同一个实现（判据都只有 `agent.state`，见
   * {@link markStaleIfWorking}），区别只在**范围**：那一个按 Workspace 刷（全局配置生效，
   * PRD 4.11 / D34），这一个只动一段会话（用户改了这一段以后用什么）。
   *
   * 「在跑」那一支在这里基本撞不到：调用方（`SessionService.setModel` / `setThinking`）
   * 已经先按「`agent.state === "idle"` 才允许改」拒过一遍。留着它不是重复判断，而是兜住两次
   * 判断之间的空档（判过之后它自己又跑起来了）：那一刻正确的做法与全局那条一样 —— 不打断，
   * 打上标记等它闲下来由 {@link complete} 兑现。
   *
   * @returns 真的退役了没有（在跑的、没有登记的，都回 `false`）
   */
  invalidateSession(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    if (this.markStaleIfWorking(entry)) return false;
    this.retire(sessionId, "assembly-facts-changed");
    return true;
  }

  /** 收尾：全部硬着陆（进程要退了，没有「稍后再死」这回事）。幂等。 */
  disposeAll(): void {
    // 「全部」只在这里：不靠 `killAll` 的可选参数，收尾那一条路自己把每一条都弄死
    for (const sessionId of [...this.entries.keys()]) {
      this.killEntry(sessionId, "shutdown");
    }
    // 收尾之后没人再来问「为什么它不在」了：理由不用留着
    this.retired.clear();
  }

  /**
   * 注册一个「生灭决定」的观察者，返回注销函数。
   *
   * 与构造参数 `onLifecycle` 报的是同一批事件；分成两个口是因为**两个消费者要的东西不一样**：
   * 接线层只是记日志（进程级一个），`ChatRunner` 要凭 `retired` 把那段会话的常驻桥拆掉
   * （一段一个，跟着 agent 走）。让 `ChatRunner` 去改接线层的那个回调，等于把两个消费者的
   * 生命周期绑在一起。
   */
  observeLifecycle(observer: (event: AgentLifecycleEvent) => void): () => void {
    this.lifecycleObservers.add(observer);
    return () => this.lifecycleObservers.delete(observer);
  }

  /** 这段会话现在挂着的 agent（没有就 `undefined`）：观察与「谁还活着」用 */
  get(sessionId: string): ChatAgent | undefined {
    return this.entries.get(sessionId)?.agent;
  }

  /**
   * 这个 Workspace 下还活着哪几段会话。
   *
   * 用处有两个：`ScopeRegistry.dispose` 被挡下来时的拒绝理由
   * （`ScopeBusyError.sessionIds`）—— 「这个能力容器上还挂着谁」；以及只读的观测（用例/日志
   * 问「这个项目下现在还有谁活着」）。
   *
   * 只按 Workspace 答：没有「不给 = 全部」那一支 —— 生产侧没有人问那个问题，多一个可选参数
   * 只是多一条能写错的旁路。
   */
  sessionIds(workspaceId: string): string[] {
    const ids: string[] = [];
    for (const [sessionId, entry] of this.entries) {
      if (entry.workspaceId === workspaceId) ids.push(sessionId);
    }
    return ids;
  }

  /**
   * 「手上有没有活」这一处判据（`invalidate` 与 `invalidateSession` 共用）：在跑就打上陈旧
   * 标记并回 `true`，闲着回 `false`（由调用方退役）。
   *
   * 只读 `agent.state`（`working` / `idle`，`CORE.md` §4）：`isOutputPaused` 是**另一处状态**
   * （从下一批起还收不收件），不是「手上有活」。
   */
  private markStaleIfWorking(entry: AgentEntry): boolean {
    if (entry.agent.state !== "working") return false;
    entry.stale = true;
    return true;
  }

  /**
   * 手里那个 agent 是不是还按**这段会话现在的事实**造出来的 —— `acquire` 的唯一判据。
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
    // 一段会话同时只有一个 agent：新造的这个顶掉旧的登记（丢掉只是引用，不停旧的 —— 停是
    // 会话级动作）。走到这里时旧的那个要么已经退役（不合用那条路），要么是同一段会话的并发
    // 装配 —— 后者不该被报成一次「退役」，所以这里只摘订阅、不报事件。
    this.drop(input.sessionId);
    this.entries.set(input.sessionId, {
      workspaceId: input.workspaceId,
      agent,
      built: factsOf(input),
      stale: false,
    });
    // 它现在在了：上一次退役留下的那条理由不再成立
    this.retired.delete(input.sessionId);
    this.report(input.sessionId, action, reason);
    return agent;
  }

  /**
   * 丢掉一条登记并按理由报一次 `retired`（没有登记就什么也不做，也不报）。
   *
   * 只丢引用：不 abort、不 kill、不落库、不推事件 —— 「换一个新的」那几条路（`complete` 兑现
   * 陈旧标记、`invalidate` / `invalidateSession` 撞上空闲的、装配事实变了重建）用这一条，
   * 因为它们手上那一批可能还要把话说完。真正要它死的三条路（会话被删 / 项目被删 / 进程收尾）
   * 走 {@link killEntry}。
   */
  private retire(sessionId: string, reason: AgentLifecycleReason): void {
    if (!this.drop(sessionId)) return;
    // 记下「为什么它不在了」：只有还会回来的那几种值得记（会话删了 / 进程收尾之后没人再问）
    if (reason !== "session-deleted" && reason !== "shutdown") {
      this.retired.set(sessionId, reason);
    }
    this.report(sessionId, "retired", reason);
  }

  /**
   * 硬着陆一条：先丢登记，再 `agent.kill()`，最后报一条 `retired`。
   *
   * 顺序是有意的：`kill()` 会**同步**广播 `killed`（宿主那条常驻桥据此报「死」并灭），而那一刻
   * 这个实例已经不该再被当成「活着的」了 —— 下一次 `complete` 不该再摸到它。
   *
   * 报的还是同一个 `retired` 事件、同一套理由：对观察者而言，「被 kill 了」与「被退役了」
   * 是同一件事（这段会话现在没有 agent），而理由（`session-deleted` / `shutdown`）
   * 会告诉它这是哪一种。
   */
  private killEntry(sessionId: string, reason: AgentLifecycleReason): void {
    const entry = this.drop(sessionId);
    if (!entry) return;
    // kill 之后这个实例**不可复活**（`push` 抛 `AgentError("closed")`），所以它不能再回到
    // `entries` 里；真要再用这段会话，下一段 `acquire` 会装配一个新的。
    entry.agent.kill();
    if (reason !== "session-deleted" && reason !== "shutdown") {
      this.retired.set(sessionId, reason);
    }
    this.report(sessionId, "retired", reason);
  }


  /**
   * 摘掉一条登记（**只丢引用**），返回摘下来的那条 —— 不报事件、不记理由。
   *
   * `retire` 与「新装配的顶掉旧的」共用它：两件事都只是「不再登记为活着」，区别只在要不要
   * 说出理由。
   */
  private drop(sessionId: string): AgentEntry | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    this.entries.delete(sessionId);
    return entry;
  }

  /** 报一条生命周期事件（只是观察：不注入就没有听众） */
  private report(
    sessionId: string,
    action: AgentLifecycleAction,
    reason: AgentLifecycleReason,
  ): void {
    const event: AgentLifecycleEvent = { sessionId, action, reason };
    this.onLifecycle?.(event);
    for (const observer of this.lifecycleObservers) observer(event);
  }

}
