import type { DatabaseSync } from "node:sqlite";

import type { AgentNS } from "@ai-zen/agents-core";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { AgentRegistry } from "../api/registry.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import { replaceMemory } from "../session/memory.js";
import type { SessionService } from "../session/service.js";
import type { Session } from "../session/types.js";

export interface HandoffDeps {
  /** 换记忆要一批跨两张表的写，`replaceMemory` 拿的就是它 */
  readonly db: DatabaseSync;
  readonly sessions: SessionService;
  readonly agents: AgentRegistry;
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
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

  constructor(private readonly deps: HandoffDeps) {}

  /**
   * 进入交接态：关掉输出闸，此后这一段的消息不再落库。
   *
   * 四条判据的顺序不能换。没有活执行体时其余三格都无从谈起；已经在这一趟里的那一段，它自己
   * 正在写文档、输出闸也是关着的 —— 把这一条排到后面，用户拿到的就是 `working` 或
   * `output_paused`，而真实原因是「已经在交接了」。
   */
  start(sessionId: string): void {
    if (this.deps.sessions.get(sessionId) === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }),
        { entity: "session", sessionId },
      );
    }

    const live = this.deps.agents.liveState(sessionId);
    if (live === null) {
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

    if (live.status === "working") {
      throw new HostError(
        "conflict",
        this.deps.t("会话 {sessionId} 还在回答，等它答完再交接", { sessionId }),
        { entity: "session", sessionId, reason: "working" },
      );
    }

    if (live.outputPaused) {
      throw new HostError(
        "conflict",
        this.deps.t("会话 {sessionId} 的输出已暂停，先恢复再交接", { sessionId }),
        { entity: "session", sessionId, reason: "output_paused" },
      );
    }

    this.handingOff.add(sessionId);
    this.deps.agents.pauseOutput(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: true });
  }

  /**
   * 正常收口：退出交接态，把输出闸开回来。
   *
   * 不在交接态时是空操作：第二次到这里事实没有变化，不再推事件。
   */
  finish(sessionId: string): void {
    if (!this.handingOff.delete(sessionId)) return;
    this.deps.agents.resumeOutput(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });
  }

  /**
   * 用户按了停：退出交接态，**不开闸** —— 回滚之后就该停在那一段，开闸等于替用户按了「继续」。
   *
   * 不在交接态时是空操作，与 {@link finish} 同。
   */
  cancel(sessionId: string): void {
    if (!this.handingOff.delete(sessionId)) return;
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });
  }

  /**
   * 把 SDK 算好的那份记忆落到库，记忆长什么样不在这里算。
   *
   * 这份记忆的来处是 SDK 的 `commitMemory` 接缝：下一波由 `migrate()` 算好递进来，
   * 这一波没有外部调用者 —— 与 `McpConfig.save` 一样，它是这个域公开的出口。
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

    this.deps.events.emit({ type: "session.changed", session: archived });
    // 原会话这一行只有更新时间会动（记忆不在一行里），所以补丁是空的；`session.changed`
    // 由 `update` 自己那条推出去
    this.deps.sessions.update(sessionId, {});
  }

  /** 写库那条路动手之前问这一格：交接期间这段会话的消息照样推事件，但不落库 */
  isHandingOff(sessionId: string): boolean {
    return this.handingOff.has(sessionId);
  }
}
