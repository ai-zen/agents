import type { LogSink } from "@ai-zen/agents-logger";

import type { Bus } from "../../infra/bus.js";
import type { HostEvent } from "../events.js";
import type { noticeTable } from "./table.js";
import type { Notice } from "./types.js";

export interface NoticeDeps {
  readonly notices: ReturnType<typeof noticeTable>;
  readonly events: Bus<HostEvent>;
  /**
   * 宿主日志。由装配根递进来（与运行时、MCP 那几处用的是同一个实例），这里不另造一个：
   * 两个 `FileLogger` 写同一个文件，轮转时会互相把对方正在写的那一份改名。
   */
  readonly log: LogSink;
}

export class NoticeService {
  constructor(private readonly deps: NoticeDeps) {}

  /** `message` 由调用方按当前语言渲染好：文案只有一个产生点，服务层不碰文字 */
  push(input: Omit<Notice, "id" | "createdAt">): Notice {
    const notice: Notice = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: Date.now(),
    };
    this.deps.notices.put(notice);
    this.deps.events.emit({ type: "notice", notice });
    this.report(notice);
    return notice;
  }

  /**
   * 警告与错误两档同时进宿主日志：界面被占着的时候，日志必须另有去处。信息与成功两档不进 ——
   * 它们只对界面上的人有意义，进了日志只是噪声。
   *
   * 只记码、档位、会话 id 这些结构化事实，**不记 `message`**：那是产生那一刻渲染好的用户可见
   * 句子，而宿主自己的日志一律英文、面向开发者与日志聚合 —— 按语言分叉的句子在日志里既筛不
   * 出来，也没法聚合。
   */
  private report(notice: Notice): void {
    if (notice.level !== "warning" && notice.level !== "error") return;
    const detail = {
      id: notice.id,
      level: notice.level,
      code: notice.code,
      sessionId: notice.sessionId,
    };
    if (notice.level === "error") this.deps.log.error("Notice", detail);
    else this.deps.log.warn("Notice", detail);
  }

  list(): Notice[] {
    return this.deps.notices.list();
  }

  listBySession(sessionId: string): Notice[] {
    return this.deps.notices.listBySession(sessionId);
  }

  clear(): void {
    this.deps.notices.clear();
    this.deps.events.emit({ type: "notice.cleared" });
  }

  clearBySession(sessionId: string): void {
    this.deps.notices.clearBySession(sessionId);
    this.deps.events.emit({ type: "notice.cleared", sessionId });
  }

  /**
   * 清一条：回删掉的那一条，不存在的 id 回 `undefined`。不存在不是错误 —— 两个客户端同时清同一条，
   * 后到的那个本来就该拿到「没改动」。
   */
  clearOne(id: string): Notice | undefined {
    const notice = this.deps.notices.removeOne(id);
    if (notice === undefined) return undefined;
    // 事件带上会话 id：别的客户端据此只动那一段的通知栏；全局那一条不属于任何一段，每段的栏位都得动。
    this.deps.events.emit({
      type: "notice.cleared",
      id,
      sessionId: notice.sessionId ?? undefined,
    });
    return notice;
  }

  sweep(now: number): void {
    this.deps.notices.deleteExpired(now);
  }
}
