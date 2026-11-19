/**
 * `inbox` 表仓储：队列里**还没被取走**的那些条目（PRD 1.2 / 4.12）。
 *
 * 一行 = 一条还在等的条目。它由 core 的三条事件驱动着**逐条实时**增减
 * （`inboxAdded` → 插一行、`inboxTaken` → 删那一行、`inboxCleared` → 清掉这段会话的行），
 * 装配出一条新 agent 时按 `seq` 原样读回来（`ChatRunner` 恢复那一跳）。
 *
 * ## 存什么
 *
 * **条目上有什么就存什么**，一个字段都不重算、内容一个字都不清理：
 *
 *   - `source` / `content` 存的是 core 那两个值的 **JSON 原文**，读回来反序列化成同一个形状
 *     （与 `messages` 的 `content` / `source` 列同一个口径）；
 *   - `createdAt` 是条目自带的那个 ISO 串，**原样**进出 —— 它是给模型判断时效用的
 *     （`CORE.md` §3），换成「读库那一刻」等于把一条陈年通知说成刚发生的；
 *   - `seq` 是入队顺序（一段会话内递增）。为什么不能只靠 `createdAt`：它只到毫秒，同一毫秒
 *     进来的两条会撞在一起，那样就还原不回它们本来的先后。
 *
 * ## 不存什么
 *
 * **钥匙（没有正文的条目）不入库**：它没有 `messageId`（主键），也没有 `source` 与正文 ——
 * 重启之后无从重建，而且它只是「把这一回叫起来」，没有任何要在重启之后接着等的内容。
 * （一次性 agent 的 inbox 整个都不持久化，`CORE.md` §3：它的寿命在调用栈里。）
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type { Database } from "./Database.js";

/** 库里那一行的原样形状（`source` / `content` 还是 JSON 字符串） */
export interface InboxRow {
  messageId: string;
  sessionId: string;
  /** JSON：core 的 `AgentNS.MessageSource` 判别结构 */
  source: string;
  /** JSON：core 的 `AgentNS.MessageContent`（字符串或多模态段数组） */
  content: string;
  /** 入队那一刻的 ISO 串，原样 */
  createdAt: string;
  /** 这一段会话内的入队顺序 */
  seq: number;
}

/**
 * 读回来的一个条目：除了表里那几格以外**什么都没补**。
 *
 * 没有 `priority`：宿主推的每一条都是 `high`（`ChatRunner.deliver` 写死的那一格），
 * 恢复时由调用方按它放回 —— 表里不存这一格，也就不会伪造出一份「存下来的优先级」。
 */
export interface StoredInboxEntry {
  messageId: string;
  createdAt: string;
  source: AgentNS.MessageSource;
  content: AgentNS.MessageContent;
}

export interface InboxInsertInput {
  /** 落地成 User 消息时用的那个 id（投递方定死）：主键，也是恢复时的去重键 */
  messageId: string;
  sessionId: string;
  /** core 的判别结构；原样序列化 */
  source: AgentNS.MessageSource;
  /** 正文原样序列化（不做任何清理、不转纯文本） */
  content: AgentNS.MessageContent;
  /** 条目自己的 ISO 串，原样 */
  createdAt: string;
}

const COLUMNS = "messageId, sessionId, source, content, createdAt, seq";

export class InboxRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 落一行（一条刚进队的条目）。
   *
   * `seq` 由这条语句自己算（这一段会话当前最大值 + 1）：插入是串行的，所以「先读最大再写」
   * 不会插进两条一样的顺序；而把它放进同一条语句里，就没有「读完了、写之前别人又插了一条」
   * 那道缝。
   */
  async insert(input: InboxInsertInput): Promise<void> {
    await this.db.run(
      `INSERT INTO inbox (${COLUMNS})
       VALUES (?, ?, ?, ?, ?,
               (SELECT COALESCE(MAX(seq), 0) + 1 FROM inbox WHERE sessionId = ?))`,
      [
        input.messageId,
        input.sessionId,
        JSON.stringify(input.source),
        JSON.stringify(input.content),
        input.createdAt,
        input.sessionId,
      ],
    );
  }

  /**
   * 一段会话里还等着的条目，**按 `seq` 升序**（顺序即取件顺序）。
   *
   * 反序列化只做「JSON 文本 → 值」这一件事：存进去是什么形状，读回来就是什么形状。
   */
  async listBySession(sessionId: string): Promise<StoredInboxEntry[]> {
    const rows = await this.db.all<InboxRow>(
      `SELECT ${COLUMNS} FROM inbox WHERE sessionId = ? ORDER BY seq ASC`,
      [sessionId],
    );
    return rows.map(toEntry);
  }

  /** 按 id 删几行（`inboxTaken` 的落点：这些条目被取走了）。返回真的删掉几条 */
  async deleteMany(messageIds: readonly string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => "?").join(", ");
    const result = await this.db.run(
      `DELETE FROM inbox WHERE messageId IN (${placeholders})`,
      [...messageIds],
    );
    return result.changes;
  }

  /** 清掉一段会话 inbox 里的全部条目（`inboxCleared` 的落点）。返回真的删掉几条 */
  async clearBySession(sessionId: string): Promise<number> {
    const result = await this.db.run("DELETE FROM inbox WHERE sessionId = ?", [sessionId]);
    return result.changes;
  }
}

/**
 * 一行 → 一个条目。`JSON.parse` 之外什么都不做：内容不清理、来源不推导、时间不换算。
 */
function toEntry(row: InboxRow): StoredInboxEntry {
  return {
    messageId: row.messageId,
    createdAt: row.createdAt,
    source: JSON.parse(row.source) as AgentNS.MessageSource,
    content: JSON.parse(row.content) as AgentNS.MessageContent,
  };
}
