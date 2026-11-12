/**
 * 素材的两张表：`assets`（资源的唯一真相）与 `asset_vendor_files`（它的一部分可失效缓存）。
 *
 * 两张表的 SQL 放在同一个文件里，是因为它们的生命周期绑在一起，而缓存表没有任何独立含义：
 *
 *   - `assets` 一行 = 数据根下一份文件 + 它的类型、大小、摘要、像素尺寸。消息里只写
 *     `asset://<id>`，所以这一行是「这张图是什么」的唯一答案；`(conversationId, sha256)` 唯一
 *     —— 同一张图在同一段对话里贴两次只占一份磁盘（去重按对话做，不跨对话）。
 *   - `asset_vendor_files` 一行 = 「这个素材在这个端点上对应厂商的哪个 file_id」。厂商的
 *     `file_id` 是端点维度资源且会过期，所以它只当缓存：删光也能从 `assets` 重建（下次发送时
 *     重新上传一遍），`ON DELETE CASCADE` 让它跟着素材走。
 *
 * 存储层只做 SQL：不判断文件在不在、不上传、不决定「缓存能不能用」。
 */

import type { Database } from "./Database.js";
import type {
  AssetCreateInput,
  AssetRow,
  AssetVendorFileRow,
  AssetVendorFileUpsertInput,
} from "./types.js";

const COLUMNS =
  "id, conversationId, messageId, name, path, mime, bytes, sha256, width, height, createdAt";

const VENDOR_COLUMNS = "assetId, endpointId, vendorFileId, createdAt, lastUsedAt";

/** 插入一个素材行的结果：`created` 为 false 说明库里已经有同摘要的那一行（对话内去重命中） */
export interface AssetUpsertOutcome {
  row: AssetRow;
  created: boolean;
}

export class AssetRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: AssetCreateInput): Promise<void> {
    await this.db.run(
      `INSERT INTO assets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.conversationId,
        input.messageId ?? null,
        input.name ?? null,
        input.path,
        input.mime,
        input.bytes,
        input.sha256,
        input.width ?? null,
        input.height ?? null,
        input.createdAt,
      ],
    );
  }

  /**
   * 插入，但「同一段对话里同摘要的那一行已经存在」时不报错、把既有行返回。
   *
   * 两个并发上传撞在一起（同一张图连传两次）时，唯一约束会挡住第二次插入；这时返回先到的那一行，
   * 让上层把刚写出去的文件删掉即可 —— 而不是抛一个「库里已经有这条」的错误给用户。
   *
   * 两条语句走同一个 `tx`（声明式批次）：插入真正生效与否由第一条的结果决定，第二条只负责把
   * 「现在库里是哪一行」读回来。
   */
  async upsert(input: AssetCreateInput): Promise<AssetUpsertOutcome> {
    const [inserted, found] = await this.db.tx((tx) => [
      tx.run(
        `INSERT INTO assets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversationId, sha256) DO NOTHING`,
        [
          input.id,
          input.conversationId,
          input.messageId ?? null,
          input.name ?? null,
          input.path,
          input.mime,
          input.bytes,
          input.sha256,
          input.width ?? null,
          input.height ?? null,
          input.createdAt,
        ],
      ),
      tx.get<AssetRow>(
        `SELECT ${COLUMNS} FROM assets WHERE conversationId = ? AND sha256 = ?`,
        [input.conversationId, input.sha256],
      ),
    ]);

    if (!found) {
      // 插入没成功又没有既有行：只可能是唯一约束之外的原因被 DO NOTHING 吞掉了，如实报错
      throw new Error("asset upsert produced no row");
    }
    return { row: found, created: inserted.changes > 0 };
  }

  async get(id: string): Promise<AssetRow | undefined> {
    return this.db.get<AssetRow>(`SELECT ${COLUMNS} FROM assets WHERE id = ?`, [id]);
  }

  /** 按内容摘要找：对话内去重（`asset.begin` 带 sha256 时走这一条） */
  async findByDigest(conversationId: string, sha256: string): Promise<AssetRow | undefined> {
    return this.db.get<AssetRow>(
      `SELECT ${COLUMNS} FROM assets WHERE conversationId = ? AND sha256 = ?`,
      [conversationId, sha256],
    );
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

  // -------------------------------------------------------------------------
  // 厂商文件 id 的缓存（asset_vendor_files）
  // -------------------------------------------------------------------------

  /** 缓存命中：这个素材在这个端点上已经有厂商的 file_id */
  async getVendorFile(
    assetId: string,
    endpointId: string,
  ): Promise<AssetVendorFileRow | undefined> {
    return this.db.get<AssetVendorFileRow>(
      `SELECT ${VENDOR_COLUMNS} FROM asset_vendor_files WHERE assetId = ? AND endpointId = ?`,
      [assetId, endpointId],
    );
  }

  /** 写入（或覆盖）一条缓存行：同一对 `(assetId, endpointId)` 只有一行 */
  async upsertVendorFile(input: AssetVendorFileUpsertInput): Promise<void> {
    await this.db.run(
      `INSERT INTO asset_vendor_files (${VENDOR_COLUMNS}) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (assetId, endpointId) DO UPDATE SET
         vendorFileId = excluded.vendorFileId,
         lastUsedAt   = excluded.lastUsedAt`,
      [input.assetId, input.endpointId, input.vendorFileId, input.createdAt, input.lastUsedAt],
    );
  }

  /** 只更新「最后用在什么时候」（命中缓存时调它，不重写 file_id） */
  async touchVendorFile(assetId: string, endpointId: string, lastUsedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE asset_vendor_files SET lastUsedAt = ? WHERE assetId = ? AND endpointId = ?",
      [lastUsedAt, assetId, endpointId],
    );
    return result.changes;
  }

  /** 一段对话在某个端点上的全部缓存行（失效自愈按这个粒度清） */
  async listVendorFiles(conversationId: string, endpointId: string): Promise<AssetVendorFileRow[]> {
    return this.db.all<AssetVendorFileRow>(
      `SELECT v.assetId, v.endpointId, v.vendorFileId, v.createdAt, v.lastUsedAt
         FROM asset_vendor_files v
         JOIN assets a ON a.id = v.assetId
        WHERE a.conversationId = ? AND v.endpointId = ?
        ORDER BY v.lastUsedAt ASC, v.assetId ASC`,
      [conversationId, endpointId],
    );
  }

  /** 删掉一条缓存行（某个 file_id 已经不认了） */
  async deleteVendorFile(assetId: string, endpointId: string): Promise<number> {
    const result = await this.db.run(
      "DELETE FROM asset_vendor_files WHERE assetId = ? AND endpointId = ?",
      [assetId, endpointId],
    );
    return result.changes;
  }

  /**
   * 一整段对话在某个端点上的缓存全部作废（一次请求因「file 不存在/无效」失败时走这一条）。
   *
   * 删的是「这段对话 + 这个端点」这一批：那条请求里可能带了好几张历史图，逐张删要先把它们
   * 从请求体里认出来，而按批删完重传一遍的代价本来就一样。返回删掉的行数。
   */
  async deleteVendorFiles(conversationId: string, endpointId: string): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM asset_vendor_files
        WHERE endpointId = ?
          AND assetId IN (SELECT id FROM assets WHERE conversationId = ?)`,
      [endpointId, conversationId],
    );
    return result.changes;
  }
}
