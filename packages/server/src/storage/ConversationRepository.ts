/**
 * `conversations` 表仓储：只做 SQL，不含业务判断。
 *
 * 排序口径照 PRD D13：置顶优先，其次创建时间倒序。改名、活动、打开都**不**改变顺序，
 * 所以 `orderBy` 里没有 `updatedAt`。
 */

import type { Database } from "./Database.js";
import type { Conversation, ConversationCreateInput, ConversationRow } from "./types.js";

const COLUMNS =
  "id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt";

/** 列表/搜索统一用这个顺序：置顶在前，再按创建时间倒序（PRD D13） */
const ORDER_BY = "ORDER BY pinned DESC, createdAt DESC, id DESC";

function toConversation(row: ConversationRow): Conversation {
  return { ...row, pinned: row.pinned !== 0 };
}

/** LIKE 的通配符要转义，否则用户搜 "100%" 会变成任意匹配 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class ConversationRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: ConversationCreateInput): Promise<void> {
    const updatedAt = input.updatedAt ?? input.createdAt;
    await this.db.run(
      `INSERT INTO conversations (${COLUMNS}) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        input.id,
        input.workspaceId,
        input.name,
        input.agentId ?? null,
        input.modelId ?? null,
        input.createdAt,
        updatedAt,
      ],
    );
  }

  async get(id: string): Promise<Conversation | undefined> {
    const row = await this.db.get<ConversationRow>(
      `SELECT ${COLUMNS} FROM conversations WHERE id = ?`,
      [id],
    );
    return row ? toConversation(row) : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<Conversation[]> {
    const rows = await this.db.all<ConversationRow>(
      `SELECT ${COLUMNS} FROM conversations WHERE workspaceId = ? ${ORDER_BY}`,
      [workspaceId],
    );
    return rows.map(toConversation);
  }

  /** 全部对话（跨 Workspace），排序口径同上 */
  async list(): Promise<Conversation[]> {
    const rows = await this.db.all<ConversationRow>(`SELECT ${COLUMNS} FROM conversations ${ORDER_BY}`);
    return rows.map(toConversation);
  }

  /** 改名：身份与顺序都不受影响（PRD D1 / D13），只记一次修改时间 */
  async rename(id: string, name: string, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET name = ?, updatedAt = ? WHERE id = ?",
      [name, updatedAt, id],
    );
    return result.changes;
  }

  async setPinned(id: string, pinned: boolean, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET pinned = ?, updatedAt = ? WHERE id = ?",
      [pinned ? 1 : 0, updatedAt, id],
    );
    return result.changes;
  }

  /** 只推进修改时间（新增消息等结构变化后调用） */
  async touch(id: string, updatedAt: number): Promise<number> {
    const result = await this.db.run("UPDATE conversations SET updatedAt = ? WHERE id = ?", [
      updatedAt,
      id,
    ]);
    return result.changes;
  }

  /** 硬删对话（PRD D17），消息与素材行随之级联删除 */
  async delete(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
    return result.changes;
  }

  /**
   * 按名字搜索（PRD D16 的「按名称」）。
   *
   * 名字搜索不走 FTS：名字短、还要支持只有一两个字的查询，`LIKE` 的子串语义正好对得上，
   * 也省掉维护第二张 FTS 表。
   */
  async searchByName(
    keyword: string,
    workspaceId: string | undefined,
    limit: number,
  ): Promise<Conversation[]> {
    const pattern = `%${escapeLike(keyword)}%`;
    if (workspaceId === undefined) {
      const rows = await this.db.all<ConversationRow>(
        `SELECT ${COLUMNS} FROM conversations
         WHERE name LIKE ? ESCAPE '\\'
         ${ORDER_BY}
         LIMIT ?`,
        [pattern, limit],
      );
      return rows.map(toConversation);
    }
    const rows = await this.db.all<ConversationRow>(
      `SELECT ${COLUMNS} FROM conversations
       WHERE workspaceId = ? AND name LIKE ? ESCAPE '\\'
       ${ORDER_BY}
       LIMIT ?`,
      [workspaceId, pattern, limit],
    );
    return rows.map(toConversation);
  }

  async countByWorkspace(workspaceId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM conversations WHERE workspaceId = ?",
      [workspaceId],
    );
    return row?.n ?? 0;
  }
}
