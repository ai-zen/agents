import type { Bus } from "../../infra/bus.js";
import type { HostEvent } from "../events.js";
import type { noticeTable } from "./table.js";
import type { Notice } from "./types.js";

export interface NoticeDeps {
  readonly notices: ReturnType<typeof noticeTable>;
  readonly events: Bus<HostEvent>;
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
    return notice;
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

  sweep(now: number): void {
    this.deps.notices.deleteExpired(now);
  }
}
