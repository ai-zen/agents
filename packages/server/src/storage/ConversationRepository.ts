/**
 * `conversations` 表仓储：只做 SQL，不含业务判断。
 *
 * 排序口径照 PRD D13：置顶优先，其次创建时间倒序。改名、活动、打开都**不**改变顺序，
 * 所以 `orderBy` 里没有 `updatedAt`。
 */

import type { Database } from "./Database.js";
import type { Conversation, ConversationCreateInput, ConversationRow } from "./types.js";

/** 读写路径共用的列清单（顺序与 `toConversation` 的形状一致） */
const COLUMNS =
  "id, workspaceId, name, nameIsAuto, pinned, agentId, modelId, thinkingLevel, createdAt, updatedAt";

/** 列表/搜索统一用这个顺序：置顶在前，再按创建时间倒序（PRD D13） */
const ORDER_BY = "ORDER BY pinned DESC, createdAt DESC, id DESC";

function toConversation(row: ConversationRow): Conversation {
  return { ...row, pinned: row.pinned !== 0, nameIsAuto: row.nameIsAuto !== 0 };
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

  /**
   * 新建对话：名字是创建时按时间起的原名，所以 `nameIsAuto` 落 1（R35）。
   * 用户改名与自动命名各有自己的方法，不从这条路径走。
   */
  async create(input: ConversationCreateInput): Promise<void> {
    const updatedAt = input.updatedAt ?? input.createdAt;
    await this.db.run(
      `INSERT INTO conversations (${COLUMNS}) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.workspaceId,
        input.name,
        input.agentId,
        input.modelId,
        input.thinkingLevel ?? null,
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

  /**
   * 用户改名（PRD F-C3）：名字归用户，`nameIsAuto` 置 0（R35）。
   * 身份与顺序都不受影响（PRD D1 / D13），只记一次修改时间。
   */
  async renameByUser(id: string, name: string, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET name = ?, nameIsAuto = 0, updatedAt = ? WHERE id = ?",
      [name, updatedAt, id],
    );
    return result.changes;
  }

  /**
   * 自动命名（PRD D2）：写入起好的名字，并把它标成自动起的那一个（`nameIsAuto` = 1）。
   *
   * 与用户改名分开成两个方法：两者的差别只在 `nameIsAuto` 这一列，靠调用方选方法来表达
   * 语义，读侧不必再猜名字是谁改的。
   */
  async applyAutoName(id: string, name: string, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET name = ?, nameIsAuto = 1, updatedAt = ? WHERE id = ?",
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

  /**
   * 换这段会话的模型，并把思考档位清空。
   *
   * 两句合成一条语句是故意的：档位属于模型（同一个档位名在不同模型的策略表里对应不同
   * 参数），只改 `modelId` 不改档位会留下一个在新模型上说得通、参数却属于旧模型的档位。
   */
  async setModel(id: string, modelId: string, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET modelId = ?, thinkingLevel = NULL, updatedAt = ? WHERE id = ?",
      [modelId, updatedAt, id],
    );
    return result.changes;
  }

  /** 写这段会话的思考档位；`null` 表示回到「跟随助手定义」 */
  async setThinkingLevel(
    id: string,
    thinkingLevel: string | null,
    updatedAt: number,
  ): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET thinkingLevel = ?, updatedAt = ? WHERE id = ?",
      [thinkingLevel, updatedAt, id],
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
