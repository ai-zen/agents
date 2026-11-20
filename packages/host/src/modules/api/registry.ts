import type { Agent } from "@ai-zen/agents-core";

import type { AgentSubscription } from "../agent/subscription.js";
import type { SessionService } from "../session/service.js";
import type { WorkspaceService } from "../workspace/service.js";

export interface AgentRegistryDeps {
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
}

interface AliveAgent {
  readonly agent: Agent;
  readonly subscription: AgentSubscription;
}

/**
 * 活着的执行体，一段会话最多一条。执行体与它那条 `AgentSubscription` 合成一条登记项：两者的
 * 寿命完全相同，分成两张表就会出现「执行体还在、订阅已经解了」这种没人会检查的中间态。
 *
 * 这是全仓唯一一份这样的登记表。`ScopeRegistry` 拆容器前问「这个目录上还有哪几段会话活着」，
 * 也问它 —— 各处自己记一份，迟早有一处先过期。
 */
export class AgentRegistry {
  private readonly alive = new Map<string, AliveAgent>();

  constructor(private readonly deps: AgentRegistryDeps) {}

  get(sessionId: string): Agent | undefined {
    return this.alive.get(sessionId)?.agent;
  }

  /**
   * 登记一个刚造好的执行体，并让它开始跑。
   *
   * 起来放在这里，是因为一条永远不取件的执行体在登记表里毫无意义：外面看得见它活着，
   * 投进去的话却没人取。
   */
  add(sessionId: string, agent: Agent, subscription: AgentSubscription): void {
    this.alive.set(sessionId, { agent, subscription });
    void agent.start();
  }

  /**
   * 杀死：执行体销毁、它那条订阅解绑。会话行与历史保留（PRD 4.4）。
   *
   * 解绑排在杀死之后：收尾那几条事件说的还是事实，订阅该照常落库、照常推。留下的订阅才是
   * 问题 —— 执行体已经不在了，它还会因为别处的事件继续写这段会话的库。
   */
  kill(sessionId: string): void {
    const entry = this.alive.get(sessionId);
    if (entry === undefined) return;

    this.alive.delete(sessionId);
    entry.agent.kill();
    entry.subscription.detach();
  }

  killAll(): void {
    for (const sessionId of [...this.alive.keys()]) this.kill(sessionId);
  }

  /** 这个目录上还活着哪几段会话：`cwd` 不在执行体身上，只能经由会话行与项目行现算 */
  aliveSessions(cwd: string): string[] {
    const sessionIds: string[] = [];
    for (const sessionId of this.alive.keys()) {
      const session = this.deps.sessions.get(sessionId);
      if (session === undefined) continue;
      if (this.deps.workspaces.get(session.workspaceId)?.cwd === cwd) sessionIds.push(sessionId);
    }
    return sessionIds;
  }
}
