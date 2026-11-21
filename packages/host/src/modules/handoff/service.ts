import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { AgentError, type AgentNS } from "@ai-zen/agents-core";
import { HandoffAbortedError, HandoffService as SdkHandoffService } from "@ai-zen/agents-sdk";
import type {
  AgentRuntime,
  HandoffContext,
  HandoffMode,
  MemoryCommit,
  MigrateParams,
  SdkAgent,
} from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import type { NoticeService } from "../notice/service.js";
import type { QuestionRegistry } from "../question/registry.js";
import { replaceMemory } from "../session/memory.js";
import type { SessionService } from "../session/service.js";
import type { Session } from "../session/types.js";
import type { WorkspaceService } from "../workspace/service.js";

/**
 * 一趟交接交给 SDK 的那几格。
 *
 * 只有这三格是宿主回答得了的：文档落在哪个目录、旧历史怎么处置、算好的记忆落在哪儿。记忆长什么
 * 样（哪些旧消息留、断点的形状、文档够不够长）全在 SDK 那一处算，这里不重做。
 */
export interface SdkHandoffOptions {
  /** 交接文档目录。按这段会话所属项目的 `cwd` 现算，多项目才不会共用一格 */
  readonly handoffDir: string;
  /**
   * 写死 `prune`，不做成参数：没有第二个调用方，参数化就是给不存在的处境留口。
   *
   * 宿主把旧记忆整段挂成另一段存档会话，原会话这边就该腾空；`omit` 把旧消息留在原数组里、只标
   * 一个「不再发给模型」，于是同一批事实同时躺在两段会话里，而两段各有各的读法。
   */
  readonly strategy: "prune";
  /**
   * 落库的接缝：SDK 把算好的记忆交出来，落库与落内存是宿主的事。
   *
   * 载荷里既没有 sessionId 也没有 agent，所以每趟交接现造一个实例、由闭包捕获这一段。换成「宿主
   * 里记一格当前正在交接的会话」会在自动交接那条路上把记忆落到别人头上：那一路是插件直接发起、
   * 宿主不经手 `start`，那一格永远是上一次手动交接留下的。
   */
  readonly commitMemory: (commit: MemoryCommit) => void | Promise<void>;
}

/**
 * 宿主用到的那一面：返回值一格都不读 —— 记忆走 `commitMemory`，成败从事件与通知里看。
 *
 * 从前这里得读回 `mode`，因为「申请自交接、拿回来摘要」要报一声降级。现在没有降级：申请哪个
 * 就跑哪个，做不成就抛，走失败那条路（{@link HandoffService.finish} 的 `error` 那一支）。
 */
export interface SdkHandoff {
  /**
   * `mode` 是这一趟**申请**的执行者；不给就走 SDK 的默认那一个。
   *
   * 返回值保留 SDK 那个形状（插件那一拍要读 `mode`），但宿主的收口一格都不读：成败看抛不抛。
   */
  migrate(params: {
    agent: SdkAgent;
    signal: AbortSignal;
    mode?: HandoffMode;
  }): Promise<Pick<HandoffContext, "mode">>;
}

export type CreateSdkHandoff = (options: SdkHandoffOptions) => SdkHandoff;

/**
 * 真的那一个。
 *
 * 是工厂而不是装好的一份实例：`handoffDir` 与 `commitMemory` 都只对一段会话的一趟交接成立，
 * 那两格要跟着趟换，装一次就等于把它们钉死在装配那一刻。
 */
export function createSdkHandoff(options: SdkHandoffOptions): SdkHandoff {
  return new SdkHandoffService(options);
}

export interface HandoffDeps {
  /** 换记忆要一批跨两张表的写，`replaceMemory` 拿的就是它 */
  readonly db: DatabaseSync;
  readonly sessions: SessionService;
  /** 文档落在项目里，得按会话所属项目的 `cwd` 现算 */
  readonly workspaces: WorkspaceService;
  /**
   * 这一段此刻活着的执行体：问运行时（谁活着只有它知道）。闸、记忆、取消口都落在那个执行体上，
   * 没有它时每一处都是空操作。
   */
  readonly runtime: AgentRuntime;
  /** 失败那条路上没有别的出口：`start` 早就返回了，用户只能从通知里知道 */
  readonly notices: NoticeService;
  /**
   * 软线越线时的那道三选题：装着问出去、并等一个答复（`askAwaitable`）。
   *
   * 题只做实时、不落库（`dev-docs/prd/01-decisions.md` 第 107–111 行）：谁也没有两张表，
   * 等的就是内存里那一格。
   */
  readonly questions: QuestionRegistry;
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
  readonly createSdk: CreateSdkHandoff;
}

/**
 * 交接：这段会话的记忆要被换成新的一份的那段时间。
 *
 * 「这段在交接」是内存里的一格，不落会话行：它只在这一趟活着期间成立，进程没了这一趟也就没了。
 * 会话行上的 `pendingHandoff` 是另一件事 —— 那是「答完交接题的那一刻不闲、等它变闲再兑现」的
 * 一项待办；两件事可以同时成立，写进同一格之后就读不出眼前说的是哪一件。
 */
export class HandoffService {
  private readonly handingOff = new Set<string>();
  /**
   * 这一趟的取消口，按会话。`cancel` 掐它 —— 手动与自动两条路共用这一格，界面上按停掐断的
   * 因此也包括插件自己发起的那一趟。一趟结束在 `finally` 里摘掉。
   */
  private readonly aborters = new Map<string, AbortController>();
  /**
   * 答过「不交接」的那几段：这段会话就按这个处置策略走，**不再问**。
   *
   * 内存里的一格，不落库：PRD 明写题只做实时、答案也不持久化（`dev-docs/prd/07-handoff.md`
   * 「谁建的会话，自动交接开不开」）——**重启之后还会问一次**，这是认下的代价。
   */
  private readonly declined = new Set<string>();
  /**
   * 这一段此刻挂着、正在等答复的那道交接题。
   *
   * 一段会话上同时只该有**一道**待答的交接题：撞线是可能连着来的 —— 题问出去用户不答、接着
   * 说话，agent 又闲下来又撞上软线 —— 每撞一次问一道，同一段上就叠着两道一模一样的题，那是
   * 缺陷，不是「只问一次」的口径。所以这里有这一格：已经有一道在等，后来的人等的是同一句。
   *
   * 与 `declined` 一样只在内存里：题只做实时（`dev-docs/prd/01-decisions.md` 第 107–111 行）。
   * 答复到手（含 `undefined`：那一段没了、或题被收掉）就把这一格摘掉，下一道题才有位置。
   */
  private readonly asking = new Map<string, Promise<string | undefined>>();

  constructor(private readonly deps: HandoffDeps) {}

  /**
   * 进入交接态，然后把真跑的那一趟交给后台，本方法不等结果。
   *
   * SDK 的 `migrate` 是一次完整的模型调用（自交接还要取走一批、写文档、等那一批收口），等它
   * 就是把「交接开始了」这句话扣到交接快结束才说 —— 那期间界面还允许发消息。所以这里只做同步
   * 的三件事（造取消口、置交接态、发事件），成败都从事件与通知里看。
   *
   * **不碰输出闸。** 闸的两半按 SDK 的分工走：关闸是 `HandoffGuardPlugin.onOuterLoopStart` 在
   * 指令被取走那一拍做的事，开闸是宿主在收口（{@link finish}）做的事。这里先关上的话，`migrate`
   * 一开跑就撞上 `runSelfHandoff` 的第一句（会话不收件就不投递）—— 那一趟直接是失败，用户在
   * 通知里只会看到一句「会话不收件」。
   *
   * 四条判据的顺序不能换。没有活执行体时其余三格都无从谈起；已经在这一趟里的那一段，它自己
   * 正在写文档、输出闸也是关着的 —— 把这一条排到后面，用户拿到的就是 `working` 或
   * `output_paused`，而真实原因是「已经在交接了」。
   *
   * `mode` 是调用方显式挑的执行者（自交接 / 独立摘要）：给了就用它跑这一趟。不给时这一格不往下
   * 传，执行者由 SDK 那一侧的默认值定（`createSdkHandoff` 没建 `mode` 时为 `self`）—— 与这一格
   * 加进来之前的每一趟一致。
   */
  start(sessionId: string, mode?: HandoffMode): void {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }),
        { entity: "session", sessionId },
      );
    }

    const agent = this.deps.runtime.get(sessionId);
    if (agent === undefined) {
      throw new HostError(
        "conflict",
        this.deps.t("会话 {sessionId} 没有运行中的执行体，无法交接", { sessionId }),
        { entity: "session", sessionId, reason: "no_agent" },
      );
    }

    if (this.handingOff.has(sessionId)) {
      throw new HostError("conflict", this.deps.t("会话 {sessionId} 正在交接", { sessionId }), {
        entity: "session",
        sessionId,
        reason: "handoff_in_progress",
      });
    }

    if (agent.state === "working") {
      throw new HostError(
        "conflict",
        this.deps.t("会话 {sessionId} 还在回答，等它答完再交接", { sessionId }),
        { entity: "session", sessionId, reason: "working" },
      );
    }

    if (agent.isOutputPaused) {
      throw new HostError(
        "conflict",
        this.deps.t("会话 {sessionId} 的输出已暂停，先恢复再交接", { sessionId }),
        { entity: "session", sessionId, reason: "output_paused" },
      );
    }

    const handoffDir = this.handoffDir(session);
    const signal = this.enter(sessionId);
    void this.run({ sessionId, agent, handoffDir, signal, mode });
  }

  /**
   * 收口：退出交接态，把输出闸开回来，再把这一趟的结果说给用户。
   *
   * **没有降级这条支**：申请哪个执行者就跑哪个，做不成就抛 —— 那样走到的一律是「失败」
   * （一条带原因的通知），不会出现「换了个执行者、界面上一切正常」那种收口。
   *
   * 开闸只能在这里，不能更早：SDK 那边关闸之后还要写文档，而记忆换成新的那一拍在宿主这一侧
   * （{@link commit}）。在写文档那一刻开闸，这期间落进来的话就会随旧记忆一起进存档。
   *
   * 自动交接那条路在插件的 `onMigrated` / `onFailed` 里走到这里 —— 那两拍是「这一趟结束了」
   * 唯一对外的回声，闸与通知因此只有这一份实现。取消不走这里（{@link cancel}）。
   *
   * 不在交接态时是空操作：第二次到这里事实没有变化，不再推事件也不再推通知。
   */
  finish(sessionId: string, outcome?: { readonly error: unknown }): void {
    if (!this.handingOff.delete(sessionId)) return;
    this.deps.runtime.get(sessionId)?.resumeOutput();
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });

    // 会话可能已经被删掉（这一趟正好撞上）：那条通知挂在它名下会撞外键，而那段会话已经不在了，
    // 也就没有要告知的人
    if (this.deps.sessions.get(sessionId) === undefined) return;

    // 成了就到此为止：记忆换了、闸开了，没什么要说的
    if (outcome === undefined) return;

    this.deps.notices.push({
      level: "error",
      code: "handoff_failed",
      sessionId,
      // 永久留到用户自己清：失败的原因得有机会读到，一闪而过的错误档等于没说。
      // SDK 报的那几种做不成（没有写文件的工具 / 不是常驻会话 / 会话不收件 / 会话已不存在 /
      // 没写出可用的文档）各自带一句原因，原样送到这里
      durationMs: null,
      message: this.deps.t("交接失败：{reason}", {
        reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      }),
    });
  }

  /**
   * 用户按了停：掐断那一趟，关闸，退出交接态，**不开闸** —— 回滚之后就该停在那一段，开闸等于替
   * 用户按了「继续」。
   *
   * 「不开闸」现在得**显式关一次**：闸已经不再由 {@link start} 关（那一手会让每一趟交接都失败），
   * 而取消完全可能发生在批头关闸之前 —— 那一拍还没到，闸就一直是开着的。「取消不开闸」的意思是
   * 取消之后保持暂停；不显式关这一下，取消会顺手把闸留在开着的状态，那一段于是接着取件。
   *
   * 掐断排在最前面：SDK 的取消只认调用方递进去的 `signal`（它自己不持有句柄），不掐这一下，
   * 后台那一趟会接着把整段历史烧完 —— 界面上写着「已中断」，账单上写着没中断。
   *
   * 不在交接态时是空操作，与 {@link finish} 同 —— 关闸因此也只能排在判据之后：不然一次无处可去
   * 的取消会把一段没在交接的会话按住。
   */
  cancel(sessionId: string): void {
    this.aborters.get(sessionId)?.abort();
    if (!this.handingOff.has(sessionId)) return;
    this.deps.runtime.get(sessionId)?.pauseOutput();
    this.handingOff.delete(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });
  }

  /**
   * 把 SDK 算好的那份记忆落到库、换到执行体上，记忆长什么样不在这里算。
   *
   * 这份记忆的来处是 SDK 的 `commitMemory` 接缝：`migrate()` 算好递进来，而那个实例是
   * {@link run} 每趟现造的，`sessionId` 由闭包捕获。
   *
   * 存档那一段的会话行由这里造：只有它同时知道 `t` 与哪些格要照抄原会话。
   *
   * 换记忆成功之后推两条 `session.changed`，顺序不能换：客户端先看到列表里多了一段，再去重拉
   * 原会话的消息。反过来，先到的那一条会让它去重拉一段还没有新记忆的会话。
   */
  commit(sessionId: string, memory: readonly AgentNS.Message[], templateCount: number): void {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }),
        { entity: "session", sessionId },
      );
    }

    const at = Date.now();
    const archived: Session = {
      id: crypto.randomUUID(),
      workspaceId: session.workspaceId,
      name: this.deps.t("已存档_{name}", { name: session.name }),
      // 名字是这里给的，不是自动起的：置真会让自动命名在下一次变闲时把它换成别的名字，
      // 那一段于是不再叫「已存档_…」
      nameIsAuto: false,
      pinned: false,
      agentId: session.agentId,
      modelId: session.modelId,
      thinkingLevel: session.thinkingLevel,
      // 两条阈值、自动交接开关、血缘都照抄：存档就是原会话在交接那一刻的样子，不是新的一段
      handoffThreshold: session.handoffThreshold,
      guardThreshold: session.guardThreshold,
      autoHandoff: session.autoHandoff,
      lineage: session.lineage,
      pendingHandoff: null,
      createdAt: at,
      updatedAt: at,
    };

    replaceMemory(this.deps.db, { sessionId, archived, memory, templateCount });
    // 落库在前、换内存在后：`replaceMemory` 是一个事务，它失败时整批退回、内存这时还没动，
    // 两处一致地停在交接前。反过来先换内存，落库一旦失败就留下「内存是新的、库是旧的」，
    // 而进程重启读回来的是库那一份 —— 用户看到的是记忆复活。
    //
    // 就地 `splice`，不给 `agent.messages` 整体赋值：那个数组是记忆的唯一真相，换掉它会让已经
    // 拿到引用的地方（插件的钩子上下文、正在进行的那次请求）继续指着旧的那一份。
    const agent = this.deps.runtime.get(sessionId);
    if (agent !== undefined) agent.messages.splice(0, agent.messages.length, ...memory);

    this.deps.events.emit({ type: "session.changed", session: archived });
    // 原会话这一行只有更新时间会动（记忆不在一行里），所以补丁是空的；`session.changed`
    // 由 `update` 自己那条推出去
    this.deps.sessions.update(sessionId, {});
  }

  /** 写库那条路动手之前问这一格：交接期间这段会话的消息照样推事件，但不落库 */
  isHandingOff(sessionId: string): boolean {
    return this.handingOff.has(sessionId);
  }

  /**
   * 越线那一刻这一趟要不要交班，用哪个执行者（`dev-docs/prd/07-handoff.md`「谁建的会话，自动交接
   * 开不开」那一张表）。
   *
   * 现读而不是让调用方把值递进来：开关改了不重建执行体（`dev-docs/prd/05-control.md`），装配那
   * 一刻读到的值会让用户改完没反应。
   *
   * 四条分支，顺序就是下面这几条（顺序本身就是口径）：
   *   1. 会话行不在 → `null`（这一段没了，没什么可交的）；
   *   2. 开着自动交接（平级会话默认开，或用户自己打开）→ `"self"`，**不问**；
   *   3. 这一段答过「不交接」→ `null`，**不再问**；
   *   4. 否则问一道三选题，等一个答复。
   *
   * 判据只有开关，**与有没有客户端连着无关**：题只活在内存里，客户端断开再连回来照样看得到它，
   * 进程没了才没 —— 没有客户端照样问，题挂着等人答。不拿「有没有人在场」替用户做「要不要交接」
   * 的决定。
   *
   * 第 4 条问出去的那道题**一段上只挂一道**（{@link asking}）：撞线是可能连着来的，而用户没答时
   * 后来的人等的是同一道，不再新问一道 —— 同一段上摞着两道一模一样的题是缺陷，不是「只问一次」
   * 的口径。
   *
   * 题是 `blocking: false`：PRD 原话是「题挂着时不挡发送」——要不要因为一道没答的题把发送按住是
   * 客户端的事，它手上就有那道题，而宿主只知道有这么一道题（`blocking` 仍进载荷）。
   *
   * 答复是 `undefined` 的意思是「没人答它了」（那段没了、或被 `forget` 掉），不是「用户说了不」——
   * 按默认执行者走。
   *
   * 这个方法是被 `AutoMigratePlugin` 的 `resolveMode` 调的，那个类型本来就允许 `Promise`
   * （`AutoMigrateModeResolver`），所以这里等用户答复就是等这一趟，不阻塞别的。
   */
  async automaticMode(sessionId: string): Promise<HandoffMode | null> {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) return null;
    if (session.autoHandoff === true) return "self";
    if (this.declined.has(sessionId)) return null;

    // 同一段上同时只该有一道待答的题：已经有一道在等，就等**同一道**。撞线是可能连着来的（用户
    // 不答、接着说，agent 又闲下来又撞上软线），每撞一次问一道，同一段上就叠着两道一模一样的题。
    let answer = this.asking.get(sessionId);
    if (answer === undefined) {
      const asked = this.deps.questions.askAwaitable({
        sessionId,
        message: this.deps.t("这段会话装不下时，用哪种方式交接？"),
        choices: [
          { value: "self", label: this.deps.t("自交接：在这段会话里接着写交接文档") },
          { value: "summary", label: this.deps.t("独立交接：另起一次调用写交接文档") },
          { value: "no", label: this.deps.t("不交接：接着聊，撞上硬线为止") },
        ],
        // 题挂着不挡发送：按不按发送是客户端拿着这一格自己决定的事
        blocking: false,
      }).answer;

      answer = asked;
      this.asking.set(sessionId, asked);
      // 答复到手就摘掉这一格 —— 拿到 `undefined`（那一段没了、或题被 `forget` 掉）也算答复，
      // 抛错也摘：留着它，这一段从此永远在等一个已经结束的答复，下一道题再也问不出去。
      // 摘之前认一次身份：这一格可能已经被 `forget` 清掉、又被下一道题填上。
      void asked.finally(() => {
        if (this.asking.get(sessionId) === asked) this.asking.delete(sessionId);
      });
    }

    const value = await answer;
    if (value === "self" || value === "summary") return value;
    if (value === "no") {
      // 答不要就记成这段的处理策略：开关关掉、这一段不再问（答案不持久化，重启之后还会问一次）
      this.declined.add(sessionId);
      this.deps.sessions.update(sessionId, { autoHandoff: false });
    }
    // `undefined`（没人答它了）与「不交接」都是 `null`：这一趟不迁移
    return null;
  }

  /**
   * 这一段没了：把交接这一侧按会话记的两格一起忘掉。
   *
   * 两格都是「按会话 id 记住这件事」的内存格（`declined` 是「答过不交接、这一段不再问」，
   * `asking` 是此刻挂着的那道题），会话行被删掉时它们不会跟着消失 —— 留着只会一直长大，而同一段
   * id 万一再出现，它会带着上一段的答案接着不说话：一撞线就不问，而那段其实从没被问过。
   *
   * 题本身由 `QuestionRegistry.forget` 收（还等在那里的那一句解出 `undefined`）；这里只管交接
   * 这一侧记的事。
   */
  forget(sessionId: string): void {
    this.declined.delete(sessionId);
    this.asking.delete(sessionId);
  }

  /**
   * 自动那一趟交给插件的那一份：`AutoMigratePlugin` 那一格要的是 SDK 的 `HandoffService`。
   *
   * 不给真的实例：这一趟必须由宿主发起 —— 取消口按会话在 `aborters` 里（界面上按停掐的就是
   * 它），交接态决定这一趟的消息落不落库，换完的记忆落在 {@link commit} 上。造一个真的实例再
   * 把 `migrate` 换掉行不通：插件调 `migrate` 时不带 `signal`，那一趟就拿不到宿主的取消口。
   * 插件只碰 `handingOff` 与 `migrate` 两格（另外两格是「只写文档」与文档目录，宿主这一侧没有
   * 对应的路），所以这里也只给那两格。
   */
  automatic(session: Session): SdkHandoffService {
    const sessionId = session.id;
    const handoffDir = this.handoffDir(session);
    const isHandingOff = () => this.isHandingOff(sessionId);
    const facade = {
      // 整趟跑着的时候它必须是 true：交接回合结束、执行体又变闲那一拍插件会再到这里一次，
      // 那时用量还超着线，不让行就是「交接触发交接」
      get handingOff(): boolean {
        return isHandingOff();
      },
      migrate: (params: MigrateParams) => this.runAutomatically(sessionId, handoffDir, params),
    };
    return facade as unknown as SdkHandoffService;
  }

  /**
   * 进入交接态：造这一趟的取消口、置态、发事件。
   *
   * 手动与自动两条路共用它，四条判据不在这里 —— 那四条判的是「人现在能不能点交接」，而自动
   * 那一趟是插件自己发的，它只在执行体闲着时才会到这里。
   */
  private enter(sessionId: string): AbortSignal {
    const abort = new AbortController();
    this.aborters.set(sessionId, abort);
    this.handingOff.add(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: true });
    return abort.signal;
  }

  /** 交接文档落在项目里，按会话所属项目的 `cwd` 现算：多项目共用一个目录，文档就跟代码分家了 */
  private handoffDir(session: Session): string {
    const workspace = this.deps.workspaces.get(session.workspaceId);
    if (workspace === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {workspaceId} 的项目", { workspaceId: session.workspaceId }),
        { entity: "workspace", workspaceId: session.workspaceId },
      );
    }
    return join(workspace.cwd, ".ai-zen", "handoffs");
  }

  /**
   * 后台那一趟：造一个只为这一趟服务的 SDK 实例，跑 `migrate`，成败都在收口里落地。
   *
   * 失败与成功各走一条，两条都必须退出交接态：留在交接态的那一段既不再落库，也不再取件。
   * 失败还要把闸开回来（只有取消不开）—— `start` 早就返回了，{@link finish} 推的那条通知是
   * 用户唯一能拿到「为什么没换」的地方。
   *
   * 取消不是失败：`cancel` 已经摘了牌、也把闸留在关着的那一边。这里还认一种它不经手
   * 的取消 —— 用户在界面上按停打的是这段会话的中断（`agent.abort()`，它不碰这里的 `signal`），
   * SDK 抛的同样是取消；报成失败就会凭空多一条「交接失败」。
   */
  private async run(run: {
    readonly sessionId: string;
    readonly agent: SdkAgent;
    readonly handoffDir: string;
    readonly signal: AbortSignal;
    /** 调用方挑的执行者；不给就交给 SDK 的默认值（见 {@link start}） */
    readonly mode?: HandoffMode;
  }): Promise<void> {
    const { sessionId, agent, handoffDir, signal, mode } = run;

    try {
      const sdk = this.deps.createSdk({
        handoffDir,
        strategy: "prune",
        commitMemory: (commit) =>
          this.commit(sessionId, commit.memory, agent.definition.messages?.length ?? 0),
      });
      // 返回值一格都不读：记忆走 `commitMemory`，成败看这里抛不抛。成了就收口，没别的话要说。
      // `mode` 原样递给 SDK：摘要那一档它自己起一个一次性执行体去写，这段会话的 agent 只被读
      // 历史（`summary` 不往它的队列里投指令）
      await sdk.migrate({ agent, mode, signal });
      this.finish(sessionId);
    } catch (error) {
      if (signal.aborted || error instanceof HandoffAbortedError) {
        this.cancel(sessionId);
        return;
      }

      this.finish(sessionId, { error });
    } finally {
      this.aborters.delete(sessionId);
    }
  }

  /**
   * 自动那一趟：插件越线时发起，不经 `start` 的四条判据。
   *
   * 收口不在这里：成与不成从插件的两个回声里走 {@link finish}（闸只能在那里开）。取消只能
   * 在这里交给 {@link cancel} —— 插件把取消咽掉、不会叫它的 `onFailed`，不在这里摘牌，这一段
   * 的消息从此不再落库。
   *
   * 申请的执行者由插件按开关现读后递进来（`automaticMode`），与手动那条是同一个：都是自交接 ——
   * 做不成就报失败，不换成摘要。
   */
  private async runAutomatically(
    sessionId: string,
    handoffDir: string,
    params: MigrateParams,
  ): Promise<Pick<HandoffContext, "mode">> {
    const signal = this.enter(sessionId);

    try {
      const sdk = this.deps.createSdk({
        handoffDir,
        strategy: "prune",
        commitMemory: (commit) =>
          this.commit(sessionId, commit.memory, params.agent.definition.messages?.length ?? 0),
      });
      return await sdk.migrate({ agent: params.agent, mode: params.mode, signal });
    } catch (error) {
      if (signal.aborted || error instanceof HandoffAbortedError) {
        this.cancel(sessionId);
        throw error;
      }

      // 执行体已经关门：插件对那一格也不叫 `onFailed`（那里没有可收的东西），交接态就没人摘。
      // 留着它，这段会话重新被叫醒之后消息永远不落库，而界面上只是「它不回话」
      if (error instanceof AgentError && error.code === "closed") this.finish(sessionId, { error });
      throw error;
    } finally {
      this.aborters.delete(sessionId);
    }
  }
}
