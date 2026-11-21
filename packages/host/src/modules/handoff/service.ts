import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { AgentNS } from "@ai-zen/agents-core";
import { HandoffAbortedError, HandoffService as SdkHandoffService } from "@ai-zen/agents-sdk";
import type { HandoffContext, HandoffMode, MemoryCommit, SdkAgent } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { AgentRegistry } from "../api/registry.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import type { NoticeService } from "../notice/service.js";
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
 * 宿主用到的那一面。返回值只取 `mode`：记忆走 `commitMemory`，交接上下文别的格宿主没有要看的东西
 * —— 只有「这一趟实际是谁写的」必须宿主自己看一眼，降级了得说出来。
 */
export interface SdkHandoff {
  migrate(params: { agent: SdkAgent; signal: AbortSignal }): Promise<Pick<HandoffContext, "mode">>;
}

export type CreateSdkHandoff = (options: SdkHandoffOptions) => SdkHandoff;

/**
 * 这一趟申请的交接执行者。
 *
 * 宿主不给 SDK 传 `mode`（{@link SdkHandoffOptions} 里也没有这一格），所以申请的就是 SDK 的
 * 默认执行者 —— 自交接。写死在宿主这一侧而不是读 `HandoffContext.requestedMode`：那一格是 SDK
 * 的回话，「我问了什么」该由问的人自己记着。两边取同一个来源的话，SDK 哪天把默认换成摘要，这里
 * 就一声不响地跟着变，降级通知也就永远不推了。
 */
const REQUESTED_MODE: HandoffMode = "self";

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
  readonly agents: AgentRegistry;
  /** 失败那条路上没有别的出口：`start` 早就返回了，用户只能从通知里知道 */
  readonly notices: NoticeService;
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
  /** 这一趟的取消口，按会话。`cancel` 掐它，一趟结束在 `finally` 里摘掉 */
  private readonly aborters = new Map<string, AbortController>();

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
   * 一开跑就撞上 `runSelfHandoff` 的第一句 `if (agent.isOutputPaused) return false;`（不收件就
   * 不取件），拿到 `false` 之后单向降级成摘要 —— 于是每一趟交接都静默降级，而界面上一切正常。
   *
   * 四条判据的顺序不能换。没有活执行体时其余三格都无从谈起；已经在这一趟里的那一段，它自己
   * 正在写文档、输出闸也是关着的 —— 把这一条排到后面，用户拿到的就是 `working` 或
   * `output_paused`，而真实原因是「已经在交接了」。
   */
  start(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }),
        { entity: "session", sessionId },
      );
    }

    const agent = this.deps.agents.get(sessionId);
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

    const workspace = this.deps.workspaces.get(session.workspaceId);
    if (workspace === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {workspaceId} 的项目", { workspaceId: session.workspaceId }),
        { entity: "workspace", workspaceId: session.workspaceId },
      );
    }

    const abort = new AbortController();
    this.aborters.set(sessionId, abort);
    this.handingOff.add(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: true });

    void this.run({
      sessionId,
      agent,
      handoffDir: join(workspace.cwd, ".ai-zen", "handoffs"),
      signal: abort.signal,
    });
  }

  /**
   * 正常收口：退出交接态，把输出闸开回来。
   *
   * 开闸只能在这里，不能更早：SDK 那边关闸之后还要写文档，而记忆换成新的那一拍在宿主这一侧
   * （{@link commit}）。在写文档那一刻开闸，这期间落进来的话就会随旧记忆一起进存档。
   *
   * 不在交接态时是空操作：第二次到这里事实没有变化，不再推事件。
   */
  finish(sessionId: string): void {
    if (!this.handingOff.delete(sessionId)) return;
    this.deps.agents.resumeOutput(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });
  }

  /**
   * 用户按了停：掐断那一趟，关闸，退出交接态，**不开闸** —— 回滚之后就该停在那一段，开闸等于替
   * 用户按了「继续」。
   *
   * 「不开闸」现在得**显式关一次**：闸已经不再由 {@link start} 关（那一手会把自交接降级成摘要），
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
    this.deps.agents.pauseOutput(sessionId);
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
  commit(sessionId: string, memory: readonly AgentNS.Message[]): void {
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

    replaceMemory(this.deps.db, { sessionId, archived, memory });
    // 落库在前、换内存在后：`replaceMemory` 是一个事务，它失败时整批退回、内存这时还没动，
    // 两处一致地停在交接前。反过来先换内存，落库一旦失败就留下「内存是新的、库是旧的」，
    // 而进程重启读回来的是库那一份 —— 用户看到的是记忆复活。
    this.deps.agents.replaceMessages(sessionId, memory);

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
   * 后台那一趟：造一个只为这一趟服务的 SDK 实例，跑 `migrate`，成败都在这里收口。
   *
   * 失败与成功各走一条，但两条都必须退出交接态：留在交接态的那一段既不再落库，也不再取件。
   * 失败还要把闸开回来（只有取消不开）并推一条通知 —— `start` 早就返回了，这条通知是用户
   * 唯一能拿到「为什么没换」的地方。开闸漏一次，这一段就再也不取件，而界面上只是「它不理我」。
   *
   * 成功那条路只看一件事：拿回来的 `mode` 与申请的那一个（{@link REQUESTED_MODE}）是不是同一个。
   * 不是就是降级 —— 记忆照换、闸照开，但文档是摘要写的，这回事得有一条通知说出来。
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
  }): Promise<void> {
    const { sessionId, agent, handoffDir, signal } = run;

    try {
      const sdk = this.deps.createSdk({
        handoffDir,
        strategy: "prune",
        commitMemory: (commit) => this.commit(sessionId, commit.memory),
      });
      const { mode } = await sdk.migrate({ agent, signal });
      this.finish(sessionId);

      // 申请的是自交接、拿回来的是摘要 = 降级了。这一趟的文档是独立摘要写的，保真度低了一档，
      // 而界面上一切正常 —— 不说出来用户永远不会知道（`PRD.md` 3.6）。
      // 排在收口之后：开闸与摘牌先落地，这条通知晚一步也不会让闸停在关着的那一边。
      // 会话可能已经被删掉（这一趟正好撞上）：那条通知挂在它名下会撞外键，与失败那条同理。
      if (mode !== REQUESTED_MODE && this.deps.sessions.get(sessionId) !== undefined) {
        this.deps.notices.push({
          level: "warning",
          code: "handoff_degraded",
          sessionId,
          // 永久留到用户自己清：降级是个事实，不是一闪而过的事件
          durationMs: null,
          message: this.deps.t("交接降级为摘要：这一趟没能由原会话自己写交接文档"),
        });
      }
    } catch (error) {
      if (signal.aborted || error instanceof HandoffAbortedError) {
        this.cancel(sessionId);
        return;
      }

      this.finish(sessionId);
      // 会话可能已经被删掉（这一趟正好撞上）：那条通知挂在它名下会撞外键，而那段会话已经不
      // 在了，也就没有要告知的人
      if (this.deps.sessions.get(sessionId) !== undefined) {
        this.deps.notices.push({
          level: "error",
          code: "handoff_failed",
          sessionId,
          // 永久留到用户自己清：失败的原因得有机会读到，一闪而过的错误档等于没说
          durationMs: null,
          message: this.deps.t("交接失败：{reason}", {
            reason: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    } finally {
      this.aborters.delete(sessionId);
    }
  }
}
