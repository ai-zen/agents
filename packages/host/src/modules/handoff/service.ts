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
import type { FormAnswer } from "../question/types.js";
import { replaceMemory } from "../session/memory.js";
import type { messageTable } from "../session/messages.js";
import type { SessionService } from "../session/service.js";
import type { SessionRecord } from "../session/types.js";
import type { WorkspaceService } from "../workspace/service.js";

/**
 * 一次作答 → 交接看得懂的那四种原样：`self` / `summary` / `no` / `undefined`（没人答它了）。
 *
 * 拒绝与关掉都算「不交接」：这一题没有“不作答”这个去处 —— 题一挂着，这一段就一直等在它上面
 * （自动那条路也不再问第二次）。三态里的 `decline` 与 `cancel` 在这里落到同一个去处，是这一题的
 * 口径，不是通用的。
 *
 * `content.mode` 那一格不再判一次：登记表已经按表校验过 enum（`QuestionRegistry.answer` 的
 * `normalize`），走到这里的值只能是那三个之一。
 */
function handoffModeOf(answer: FormAnswer | undefined): HandoffMode | "no" | undefined {
  if (answer === undefined) return undefined;
  if (answer.action !== "accept") return "no";
  return answer.content?.mode as HandoffMode;
}

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
 * 宿主用到的那一面。
 *
 * `handoff` 与 `migrate` 是 SDK 那两个方法的两档：前者只产出文档、一个字节都不改记忆；后者写完
 * 文档再把记忆交给宿主落库。收口那一侧只读 `handoff` 回来的 `handoffPath`（通知里要说文档落在
 * 哪），其余几格一格都不读 —— 成与不成看抛不抛。
 */
export interface SdkHandoff {
  /**
   * 只写文档那一档：交接回合留在记忆里（可以接着让它改同一份文档），脱敏与阈值校验都在 SDK
   * 那一侧，这里只收它回来的那份上下文。
   */
  handoff(params: {
    agent: SdkAgent;
    signal: AbortSignal;
    mode?: HandoffMode;
  }): Promise<HandoffContext>;

  /**
   * `mode` 是这一趟申请的执行者；不给就走 SDK 的默认那一个。
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

/**
 * 一次交接是哪一档。
 *
 * - `document`：只写交接文档，记忆一个字节都不动、不建存档会话、不换 Agent 的身份；
 * - `swap`：写完文档之后把这段记忆换成新的一份，旧记忆成为另一段存档会话。
 *
 * 两档共用交接态与取消口：取消都要回到交接前（半截文档删掉、这一段退出交接态）。
 *
 * 消息落库只有换手那一档在交接期间跳过（那份记忆马上要换成新的一份），只写文档那一档照常落库
 * —— 交接回合是这段会话真实发生过的事。
 */
export type HandoffKind = "document" | "swap";

/** `start` 的那两格：谁去写、写不写换手 */
export interface HandoffStartOptions {
  /**
   * 执行者。不给时进 `start` 就不往下传、由 SDK 的默认值定，而进 {@link HandoffService.startAsked}
   * 会先问一次（手动那条路的形状）。
   */
  readonly mode?: HandoffMode;
  /**
   * 这一档。不给就是 `swap`：「交接」这个动作本来指的就是「写文档 + 换手」，只写文档是分出来的
   * 另一档，得由调用方自己开口 —— 不开口的调用方（还没更新的客户端、自动那一趟）拿到的仍是原来
   * 那一趟。
   */
  readonly kind?: HandoffKind;
}

export interface HandoffDeps {
  /** 换记忆要一批跨两张表的写，`replaceMemory` 拿的就是它 */
  readonly db: DatabaseSync;
  readonly sessions: SessionService;
  /**
   * 消息表：取消那一侧要用它撤掉库里那几条。只写文档这一档在交接期间照常落库，而取消会把交接
   * 回合从记忆里截掉，库里留着就是「内存里没有、库里有」。
   */
  readonly messages: ReturnType<typeof messageTable>;
  /** 文档落在项目里，得按会话所属项目的 `cwd` 现算 */
  readonly workspaces: WorkspaceService;
  /**
   * 这一段此刻活着的 Agent：问运行时（哪些会话有活 Agent 只有它知道）。开关、记忆、取消口都落在那个 Agent 上，
   * 没有它时每一处都是空操作。
   */
  readonly runtime: AgentRuntime;
  /** 失败那条路上没有别的出口：`start` 早就返回了，用户只能从通知里知道 */
  readonly notices: NoticeService;
  /**
   * 软线越线时的那道三选题：装着问出去、并等一个答复（`askAwaitable`）。
   *
   * 题只做实时、不落库：没有第二张表，等的就是内存里那一格。
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
 * 会话行上也没有「待交接」这么一格 —— 会话行就那十一格，交接不往上多占一格。
 */
export class HandoffService {
  /**
   * 这段会话此刻在交接。两档都进这一格：界面上的「正在交接」、只留中断、输入开关都读它。
   */
  private readonly handingOff = new Set<string>();
  /**
   * 这段会话此刻在换手：交接期间它的消息不落库。
   *
   * 只有换手那一档进这一格 —— 那份记忆马上要换成新的一份，落进去没有意义。只写文档那一档不进：
   * 它的交接回合是真实发生过的，照常落库，内存与库因此是同一份。
   */
  private readonly swapping = new Set<string>();
  /**
   * 这一趟的取消口，按会话。`cancel` 中止它 —— 手动与自动两条路共用这一格，界面上按停中止的
   * 因此也包括插件自己发起的那一趟。一趟结束在 `finally` 里摘掉。
   */
  private readonly aborters = new Map<string, AbortController>();
  /**
   * 答过「不交接」的那几段：这段会话就按这个处置策略走，不再问。
   *
   * 内存里的一格，不落库：题只做实时、答案也不持久化（「谁建的会话，自动交接开不开」）——
   * 重启之后还会问一次，这是认下的代价。
   */
  private readonly declined = new Set<string>();
  /**
   * 这一段此刻挂着、正在等答复的那道交接题。
   *
   * 一段会话上同时只该有一道待答的交接题：撞线是可能连着来的 —— 题问出去用户不答、接着
   * 说话，agent 又闲下来又撞上软线 —— 每撞一次问一道，同一段上就叠着两道一模一样的题，那是
   * 缺陷，不是「只问一次」的口径。所以这里有这一格：已经有一道在等，后来的人等的是同一句。
   *
   * 与 `declined` 一样只在内存里：题只做实时。
   * 答复到手（含 `undefined`：那一段没了、或题被收掉）就把这一格摘掉，下一道题才有位置。
   */
  private readonly asking = new Map<string, Promise<HandoffMode | "no" | undefined>>();

  constructor(private readonly deps: HandoffDeps) {}

  /**
   * 进入交接态，然后把真跑的那一趟交给后台，本方法不等结果。
   *
   * SDK 的 `migrate` 是一次完整的模型调用（自交接还要取走一批、写文档、等那一批收口），等它
   * 就是把「交接开始了」这句话扣到交接快结束才说 —— 那期间界面还允许发消息。所以这里只做同步
   * 的三件事（造取消口、置交接态、发事件），成败都从事件与通知里看。
   *
   * 不碰输出开关。 开关的两半按 SDK 的分工走：关开关是 `HandoffGuardPlugin.onOuterLoopStart` 在
   * 指令被取走那一拍做的事，开开关是宿主在收口（{@link finish}）做的事。这里先关上的话，`migrate`
   * 一开跑就撞上 `runSelfHandoff` 的第一句（会话不收件就不投递）—— 那一趟直接是失败，用户在
   * 通知里只会看到一句「会话不收件」。
   *
   * 四条判据见 {@link assertStartable}（顺序不能换）。
   *
   * `mode` 是调用方显式挑的执行者（自交接 / 独立摘要）：给了就用它跑这一趟。不给时这一格不往下
   * 传，执行者由 SDK 那一侧的默认值定（`createSdkHandoff` 没建 `mode` 时为 `self`）—— 手动那条
   * 路上「不给」意味着先问一次，那一格在 {@link startAsked}，不在这里。
   *
   * `kind` 是这一档走哪两个 SDK 方法（见 {@link HandoffKind}）。两档的四条判据、交接态、取消口
   * 完全一样，分岔只在后台那一趟的最后一步。
   */
  start(sessionId: string, options: HandoffStartOptions = {}): void {
    const { session, agent } = this.assertStartable(sessionId);
    const handoffDir = this.handoffDir(session);
    const kind = options.kind ?? "swap";
    const signal = this.enter(sessionId, kind);
    void this.run({
      sessionId,
      agent,
      handoffDir,
      signal,
      mode: options.mode,
      kind,
    });
  }

  /**
   * 手动那条路：没给执行者就先问一次，答完再开跑（{@link askHandoffMode}）。
   *
   * 与 {@link start} 分成两条，是因为这一条要等（等人答），而那一格是同步的：进交接态、把
   * 真跑的那一趟交给后台。所以调用方（`handoff.start` 那条 procedure）叫它是「不等结果地叫起来」
   * —— 题一出来那条 RPC 就该回去，否则界面上按一下回车要等用户点完选项才见到回执。
   *
   * 与阈值那条（{@link automaticMode}）共用同一道题：手动敲命令与撞线是两件事，但「用哪种方式
   * 交接」只有一个答案，两处各写一份题就会各说一套措辞。
   *
   * 判据在问之前先跑一遍：能问的必须是真能交的，别让人答完才被告知「还在回答」。
   */
  async startAsked(sessionId: string, options: HandoffStartOptions = {}): Promise<void> {
    // 显式挑了执行者就不问：选择题只是「没指定时」的那一问
    if (options.mode !== undefined) {
      this.start(sessionId, options);
      return;
    }

    // 这条路没有人在等结果（题一出来那条 RPC 就回去了），所以判据的拒绝只能收成一条通知 ——
    // 让它在后台变成一个没人接的 rejection，用户看到的就是「敲了命令，什么都没发生」
    try {
      this.assertStartable(sessionId);
    } catch (error) {
      this.noticeNotStarted(sessionId, error);
      return;
    }

    const value = await this.askHandoffMode(sessionId);
    // 不交接、或没人答它了（`undefined`）：什么都不做，也不记成「这一段不再问」—— 那一条是
    // 阈值那条路的处置策略，手动这一趟的「不交接」就是这一次不交
    if (value !== "self" && value !== "summary") return;

    try {
      this.start(sessionId, { ...options, mode: value });
    } catch (error) {
      // 问的这段时间里状态可能变了（这一段开始了别的交接、被硬杀、被删掉）：`start` 那四条判据
      // 再判一遍，判不过就落在这一格
      this.noticeNotStarted(sessionId, error);
    }
  }

  /** 「交接没开起来」那一条通知（判据拒了、或开跑那一刻状态已经变了） */
  private noticeNotStarted(sessionId: string, error: unknown): void {
    this.deps.notices.push({
      level: "error",
      code: "handoff_failed",
      sessionId,
      durationMs: null,
      message: this.deps.t("交接没有开始：{reason}", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
  }

  /**
   * 交接的四条判据，过了才往下走。
   *
   * 顺序不能换。没有活 Agent 时其余三格都无从谈起；已经在这一趟里的那一段，它自己正在写文档、
   * 输出开关也是关着的 —— 把这一条排到后面，用户拿到的就是 `working` 或 `output_paused`，而真实
   * 原因是「已经在交接了」。
   *
   * 两条路（{@link start} 直接开跑、{@link startAsked} 问之前先判）共用它：判据只有一份，多写
   * 一遍就一定会有一条路少判一格。`handoff.start` 那条 procedure 也会先调它一次 —— 题还没出，
   * 这一段跑不了就当场拒，客户端拿得到理由。
   */
  assertStartable(sessionId: string): { session: SessionRecord; agent: SdkAgent } {
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
        this.deps.t("会话 {sessionId} 没有运行中的Agent，无法交接", { sessionId }),
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

    return { session, agent };
  }

  /**
   * 收口：退出交接态，把输出开关开回来，再把这一趟的结果说给用户。
   *
   * 没有降级这条支：申请哪个执行者就跑哪个，做不成就抛 —— 那样走到的一律是「失败」
   * （一条带原因的通知），不会出现「换了个执行者、界面上一切正常」那种收口。
   *
   * 开开关只能在这里，不能更早：SDK 那边关开关之后还要写文档，而记忆换成新的那一拍在宿主这一侧
   * （{@link commit}）。在写文档那一刻开开关，这期间落进来的话就会随旧记忆一起进存档。
   *
   * 自动交接那条路在插件的 `onMigrated` / `onFailed` 里走到这里 —— 那两拍是「这一趟结束了」
   * 唯一对外的回声，开关与通知因此只有这一份实现。取消不走这里（{@link cancel}）。
   *
   * 不在交接态时是空操作：第二次到这里事实没有变化，不再推事件也不再推通知。
   */
  finish(sessionId: string, outcome?: { readonly error: unknown }): void {
    const wasHandingOff = this.handingOff.delete(sessionId);
    this.swapping.delete(sessionId);
    if (!wasHandingOff) return;
    this.deps.runtime.get(sessionId)?.resumeOutput();
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });

    // 会话可能已经被删掉（这一趟正好撞上）：那条通知挂在它名下会撞外键，而那段会话已经不在了，
    // 也就没有要告知的人
    if (this.deps.sessions.get(sessionId) === undefined) return;

    // 成了就到此为止：记忆换了、开关开了，没什么要说的
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
   * 只写文档那一档的收尾：交接态已经退掉，这里把文档落在哪说给用户。
   *
   * 换手那一档没有这一句 —— 那一档的收尾是「记忆换了」，用户要看的不是路径，而是下一句话。
   *
   * 永久留到用户自己清：路径是这条通知的全部内容，一闪而过就等于没说（文档是给人去读、去改、
   * 去提交的，读完那一眼很可能不是此刻）。
   */
  private announceDocument(sessionId: string, handoffPath: string): void {
    // 会话可能在这一趟里被删掉：那条通知挂在它名下会撞外键，而那段会话已经不在了
    if (this.deps.sessions.get(sessionId) === undefined) return;

    this.deps.notices.push({
      level: "success",
      code: "handoff_document",
      sessionId,
      durationMs: null,
      message: this.deps.t("交接文档已写到 {path}", { path: handoffPath }),
    });
  }

  /**
   * 用户按了停：中止那一趟，关开关，退出交接态，不开开关 —— 回滚之后就该停在那一段，开开关等于替
   * 用户按了「继续」。
   *
   * 「不开开关」现在得显式关一次：开关已经不再由 {@link start} 关（那一手会让每一趟交接都失败），
   * 而取消完全可能发生在批头关开关之前 —— 那一拍还没到，开关就一直是开着的。「取消不开开关」的意思是
   * 取消之后保持暂停；不显式关这一下，取消会把开关留在开着的状态，那一段于是接着取走。
   *
   * 中止排在最前面：SDK 的取消只认调用方递进去的 `signal`（它自己不持有句柄），不中止这一下，
   * 后台那一趟会接着把整段历史跑完 —— 界面上写着「已中断」，账单上写着没中断。
   *
   * 不在交接态时是空操作，与 {@link finish} 同 —— 关开关因此也只能排在判据之后：不然一次无处可去
   * 的取消会把一段没在交接的会话按住。
   */
  cancel(sessionId: string): void {
    this.aborters.get(sessionId)?.abort();
    if (!this.handingOff.has(sessionId)) return;
    this.deps.runtime.get(sessionId)?.pauseOutput();
    this.handingOff.delete(sessionId);
    this.swapping.delete(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });
  }

  /**
   * 把 SDK 算好的那份记忆落到库、换到 Agent 上，记忆长什么样不在这里算。
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
    const archived: SessionRecord = {
      id: crypto.randomUUID(),
      workspaceId: session.workspaceId,
      // 名字沿用原会话的：名字里不烘展示文本。存档这件事由 `nameSource` 说 —— 前缀是按当时
      // 界面语言渲染的，语言一换库里那些旧名字就跟不上，而列表里两行同名时也说不清哪行是存档
      name: session.name,
      nameSource: "handoff",
      pinned: false,
      agentId: session.agentId,
      modelId: session.modelId,
      thinkingLevel: session.thinkingLevel,
      // 两条阈值、自动交接开关、血缘都照抄：存档就是原会话在交接那一刻的样子，不是新的一段
      handoffThreshold: session.handoffThreshold,
      guardThreshold: session.guardThreshold,
      autoHandoff: session.autoHandoff,
      lineage: session.lineage,
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

  /** 这段会话此刻在不在交接：界面上的「正在交接」、只留中断、输入开关都读它（两档都有交接态） */
  isHandingOff(sessionId: string): boolean {
    return this.handingOff.has(sessionId);
  }

  /**
   * 写库那条路动手之前问这一格：这段会话此刻在换手。
   *
   * 交接期间不落库只对换手那一档成立 —— 那份记忆马上要换成新的一份。只写文档那一档的消息照常
   * 落库，推给客户端的那几条与库里那几条因此是同一份。
   */
  suppressesPersist(sessionId: string): boolean {
    return this.swapping.has(sessionId);
  }

  /**
   * 越线那一刻这一趟要不要交班，用哪个执行者（「谁建的会话，自动交接开不开」那一张表）。
   *
   * 现读而不是让调用方把值递进来：开关改了不重建 Agent，装配那一刻读到的值会让用户改完
   * 没有反应。
   *
   * 四条分支，顺序就是下面这几条（顺序本身就是口径）：
   *   1. 会话行不在 → `null`（这一段没了，没什么可交的）；
   *   2. 开着自动交接（平级会话默认开，或用户自己打开）→ `"self"`，不问；
   *   3. 这一段答过「不交接」→ `null`，不再问；
   *   4. 否则出那道题（{@link askHandoffMode}），等一个答复。
   *
   * 判据只有开关那一格，与「谁建的」无关：开着自动交班，关着问一次。开关的初值才与谁建的
   * 有关（用户建的默认关、平级会话默认开），那是建会话那一侧的事。
   *
   * 判据也与有没有客户端连着无关：题只活在内存里，客户端断开再连回来照样看得到它，
   * 进程没了才没 —— 没有客户端照样问，题挂着等人答。不拿「有没有人在场」替用户做「要不要交接」
   * 的决定。
   *
   * 答复是 `undefined` 的意思是「没人答它了」（那段没了、或被 `forget` 掉），不是「用户说了不」——
   * 这一趟不迁移，但也不记成「这一段不再问」。
   *
   * 这个方法是被 `AutoMigratePlugin` 的 `resolveMode` 调的，那个类型本来就允许 `Promise`
   * （`AutoMigrateModeResolver`），所以这里等用户答复就是等这一趟，不阻塞别的。
   */
  async automaticMode(sessionId: string): Promise<HandoffMode | null> {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) return null;
    if (session.autoHandoff === true) return "self";
    if (this.declined.has(sessionId)) return null;

    const value = await this.askHandoffMode(sessionId);
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
   * 出那道交接三选题（自交接 / 独立交接 / 不交接），等一个答复。
   *
   * 手动与阈值两条路共用这一份：一条是用户敲了命令，一条是撞线了，两件事不一样，但「用哪种
   * 方式交接」只有一个答案 —— 各写一份题，用户看到的就是两套措辞、两个形状。
   *
   * 同一段上只挂一道（{@link asking}）：撞线是可能连着来的，用户没答时后来的人等的是同一道，
   * 不再新问一道 —— 同一段上摞着两道一模一样的题是缺陷，不是「只问一次」的口径。
   *
   * 题是 `blocking: false`：「题挂着时不挡发送」——要不要因为一道没答的题把发送按住是
   * 客户端的事，它手上就有那道题，而宿主只知道有这么一道题（`blocking` 仍进载荷）。
   *
   * 返回值是宿主看得懂的那四种原样：`self` / `summary` / `no` / `undefined`（没人答它了）。怎么
   * 处置是调用方的事 —— 「不交接」在阈值那条路上要记成这一段不再问，在手动那条路上只是这一次不交。
   */
  private async askHandoffMode(sessionId: string): Promise<HandoffMode | "no" | undefined> {
    let answer = this.asking.get(sessionId);
    if (answer === undefined) {
      const asked = this.deps.questions
        .askAwaitable({
          sessionId,
          message: this.deps.t("用哪种方式交接？"),
          // 一个单选枚举字段 —— 题就是一张表单（形状见 `question/types.ts`），三选一只是它最常见的
          // 那一格。候选顺序即展示顺序
          requestedSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: this.deps.t("用哪种方式交接？"),
                enum: ["self", "summary", "no"],
                enumNames: [
                  this.deps.t("自交接：在这段会话里接着写交接文档"),
                  this.deps.t("独立交接：另起一次调用写交接文档"),
                  this.deps.t("不交接：保持现状"),
                ],
              },
            },
            required: ["mode"],
          },
          // 题挂着不挡发送：按不按发送是客户端拿着这一格自己决定的事
          blocking: false,
          // 「不交接」是枚举里的一项，不再另给拒绝/取消两个按钮：三个入口说同一件事
          actions: ["accept"],
        })
        .answer.then(handoffModeOf);

      answer = asked;
      this.asking.set(sessionId, asked);
      // 答复到手就摘掉这一格 —— 拿到 `undefined`（那一段没了、或题被 `forget` 掉）也算答复，
      // 抛错也摘：留着它，这一段从此永远在等一个已经结束的答复，下一道题再也问不出去。
      // 摘之前认一次身份：这一格可能已经被 `forget` 清掉、又被下一道题填上。
      void asked.finally(() => {
        if (this.asking.get(sessionId) === asked) this.asking.delete(sessionId);
      });
    }

    return answer;
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
   * 不给真的实例：这一趟必须由宿主发起 —— 取消口按会话在 `aborters` 里（界面上按停中止的就是
   * 它），交接态决定这一趟的消息落不落库，换完的记忆落在 {@link commit} 上。造一个真的实例再
   * 把 `migrate` 换掉行不通：插件调 `migrate` 时不带 `signal`，那一趟就拿不到宿主的取消口。
   * 插件只碰 `handingOff` 与 `migrate` 两格（另外两格是「只写文档」与文档目录，宿主这一侧没有
   * 对应的路），所以这里也只给那两格。
   */
  automatic(session: SessionRecord): SdkHandoffService {
    const sessionId = session.id;
    const handoffDir = this.handoffDir(session);
    const isHandingOff = () => this.isHandingOff(sessionId);
    const facade = {
      // 整趟跑着的时候它必须是 true：交接回合结束、Agent 又变闲那一拍插件会再到这里一次，
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
   * 那一趟由插件发起，只在 Agent 闲着时才会走到这里。
   *
   * `kind` 只决定这一趟进不进落库抑制那一格（见 {@link suppressesPersist}）。
   */
  private enter(sessionId: string, kind: HandoffKind): AbortSignal {
    const abort = new AbortController();
    this.aborters.set(sessionId, abort);
    this.handingOff.add(sessionId);
    if (kind === "swap") this.swapping.add(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: true });
    return abort.signal;
  }

  /** 交接文档落在项目里，按会话所属项目的 `cwd` 现算：多项目不共用一个目录，文档才与代码在同一处 */
  private handoffDir(session: SessionRecord): string {
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
   * 后台那一趟：造一个只为这一趟服务的 SDK 实例，按这一档调 `handoff` 或 `migrate`，成败都在收口
   * 里写进 messages。
   *
   * 失败与成功各走一条，两条都必须退出交接态：留在交接态的会话不再取走（换手那一档连消息也
   * 不落库）。失败还要把开关开回来（只有取消不开）—— `start` 早就返回了，{@link finish} 推的那条
   * 通知是用户唯一能拿到「为什么没换」的地方。
   *
   * 两档只在最后一步分岔：只写文档那一档不调 `commitMemory`（SDK 的 `handoff` 根本不会叫它），
   * 于是记忆、存档会话、Agent 的身份一格都不动，这一趟要告知的只有文档落在哪。它写下的那几条
   * 消息照常落库，收口之后也不截 —— 这一段会话真的说了那几句。
   *
   * 取消不是失败：`cancel` 已经摘了牌、也把开关留在关着的那一边。这里还认一种它不经手
   * 的取消 —— 用户在界面上按停打的是这段会话的中断（`runtime.agent.abort()`，它不碰这里的 `signal`），
   * SDK 抛的同样是取消；报成失败就会凭空多一条「交接失败」。
   */
  private async run(run: {
    readonly sessionId: string;
    readonly agent: SdkAgent;
    readonly handoffDir: string;
    readonly signal: AbortSignal;
    /** 调用方挑的执行者；不给就交给 SDK 的默认值（见 {@link start}） */
    readonly mode?: HandoffMode;
    /** 这一档（见 {@link HandoffKind}） */
    readonly kind: HandoffKind;
  }): Promise<void> {
    const { sessionId, agent, handoffDir, signal, mode, kind } = run;

    try {
      const sdk = this.deps.createSdk({
        handoffDir,
        strategy: "prune",
        commitMemory: (commit) =>
          this.commit(sessionId, commit.memory, agent.definition.messages?.length ?? 0),
      });
      // `mode` 原样递给 SDK：摘要那一档它自己起一个一次性 Agent 去写，这段会话的 agent 只被读
      // 历史（`summary` 不往它的队列里投指令）
      if (kind === "document") {
        // 只写文档：回来的路径是这一趟唯一要告知的事，记忆那一侧 SDK 一个字节都不动
        const ctx = await sdk.handoff({ agent, mode, signal });
        this.finish(sessionId);
        this.announceDocument(sessionId, ctx.handoffPath);
        return;
      }

      // 换手：返回值一格都不读，记忆走 `commitMemory`，成败看这里抛不抛
      await sdk.migrate({ agent, mode, signal });
      this.finish(sessionId);
    } catch (error) {
      if (signal.aborted || error instanceof HandoffAbortedError) {
        // 只写文档这一档在交接期间照常落库，而取消会把交接回合从记忆里截掉（SDK 收尾时做的）：
        // 库里那几条一起撤，两处停在同一份上
        if (kind === "document") this.dropMessagesOutsideMemory(sessionId);
        this.cancel(sessionId);
        return;
      }

      this.finish(sessionId, { error });
    } finally {
      this.aborters.delete(sessionId);
    }
  }

  /**
   * 把库里那几条内存里已经没有的消息删掉，并告诉客户端它们没了。
   *
   * 取消时 SDK 把交接回合从记忆里截回交接前的条数，而只写文档这一档那几条已经落过库：留着它们，
   * 重启之后它们又回来，而这段记忆里从来没有过它们。判据是「内存里没有的那几条」——照记忆那份
   * 真相删，不另记一份这一趟写过什么。
   */
  private dropMessagesOutsideMemory(sessionId: string): void {
    const agent = this.deps.runtime.get(sessionId);
    if (agent === undefined) return;

    const kept = new Set(agent.messages.map((message) => message.id));
    for (const message of this.deps.messages.listBySession(sessionId)) {
      if (kept.has(message.id)) continue;
      this.deps.messages.delete(message.id);
      this.deps.events.emit({ type: "message.removed", sessionId, messageId: message.id });
    }
  }

  /**
   * 自动那一趟：插件越线时发起，不经 `start` 的四条判据。
   *
   * 收口不在这里：成与不成从插件的两个回声里走 {@link finish}（开关只能在那里开）。取消只能
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
    const signal = this.enter(sessionId, "swap");

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

      // Agent 已经关闭：插件对那一格也不叫 `onFailed`（那里没有可收的东西），交接态就没人摘。
      // 留着它，这段会话重新被唤醒之后消息永远不落库，而界面上只是「它不回复」
      if (error instanceof AgentError && error.code === "closed") this.finish(sessionId, { error });
      throw error;
    } finally {
      this.aborters.delete(sessionId);
    }
  }
}
