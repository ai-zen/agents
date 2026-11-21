import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import type { sessionTable } from "./table.js";
import type { NewSession, Session } from "./types.js";

export interface SessionDeps {
  readonly sessions: ReturnType<typeof sessionTable>;
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
}

/**
 * 会话行上的写入口只有 `update` 一个：需要改哪一格就合并哪一格，不按字段各开一个方法
 * —— 每多一个单列方法，行上的字段就在两处各有一份定义。
 *
 * 建行与改行都在落库之后推 `session.changed`：订阅者收到这条时会按 id 回读那一行，
 * 推在前面就读不到自己刚被通知的那个值。
 */
export class SessionService {
  constructor(private readonly deps: SessionDeps) {}

  create(input: NewSession): Session {
    const now = Date.now();
    const session: Session = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      nameIsAuto: input.nameIsAuto,
      pinned: false,
      agentId: input.agentId,
      modelId: input.modelId,
      thinkingLevel: null,
      autoHandoff: input.autoHandoff,
      lineage: input.lineage,
      handoffThreshold: null,
      guardThreshold: null,
      pendingHandoff: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.sessions.put(session);
    this.deps.events.emit({ type: "session.changed", session });
    return session;
  }

  get(id: string): Session | undefined {
    return this.deps.sessions.get(id);
  }

  list(workspaceId: string): Session[] {
    return this.deps.sessions.listByWorkspace(workspaceId);
  }

  update(id: string, patch: Partial<Omit<Session, "id" | "createdAt">>): Session {
    const current = this.deps.sessions.get(id);
    if (current === undefined) {
      throw new HostError("not_found", this.deps.t("找不到 id 为 {sessionId} 的会话", { sessionId: id }), {
        entity: "session",
        sessionId: id,
      });
    }

    const next: Session = { ...current, ...patch, updatedAt: Date.now() };
    this.deps.sessions.put(next);
    this.deps.events.emit({ type: "session.changed", session: next });
    return next;
  }

  /** 换模型必须清掉 `thinkingLevel`：档位是模型的参数，把一家的 thinking 参数带到另一家会被直接拒 */
  setModel(id: string, modelId: string | null): Session {
    return this.update(id, { modelId, thinkingLevel: null });
  }

  remove(id: string): void {
    // 消息靠外键 `ON DELETE CASCADE` 跟着走，这里不再删一遍。
    this.deps.sessions.delete(id);
  }
}
