/**
 * `assets` 表仓储：二进制素材的**引用**（PRD L2：文件落数据根下的 `assets/`，库里只存引用）。
 *
 * 存储层只记「哪个对话、哪条消息、哪个相对路径、多大、什么类型」，
 * 文件本身读写在别的层；这里判断不了也不判断「引用还在不在」。
 */

import type { Database } from "./Database.js";
import type { AssetCreateInput, AssetRow } from "./types.js";

const COLUMNS = "id, conversationId, messageId, name, path, mime, bytes, sha256, createdAt";

export class AssetRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: AssetCreateInput): Promise<void> {
    await this.db.run(
      `INSERT INTO assets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.conversationId,
        input.messageId ?? null,
        input.name ?? null,
        input.path,
        input.mime,
        input.bytes,
        input.sha256 ?? null,
        input.createdAt,
      ],
    );
  }

  async get(id: string): Promise<AssetRow | undefined> {
    return this.db.get<AssetRow>(`SELECT ${COLUMNS} FROM assets WHERE id = ?`, [id]);
  }

  async listByConversation(conversationId: string): Promise<AssetRow[]> {
    return this.db.all<AssetRow>(
      `SELECT ${COLUMNS} FROM assets WHERE conversationId = ? ORDER BY createdAt ASC, id ASC`,
      [conversationId],
    );
  }

  async listByMessage(messageId: string): Promise<AssetRow[]> {
    return this.db.all<AssetRow>(
      `SELECT ${COLUMNS} FROM assets WHERE messageId = ? ORDER BY createdAt ASC, id ASC`,
      [messageId],
    );
  }

  /** 把上传完的素材挂到消息上（上传早于消息落库，PRD D5 / F-H8） */
  async linkToMessage(id: string, messageId: string): Promise<number> {
    const result = await this.db.run("UPDATE assets SET messageId = ? WHERE id = ?", [
      messageId,
      id,
    ]);
    return result.changes;
  }

  async delete(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM assets WHERE id = ?", [id]);
    return result.changes;
  }
}
