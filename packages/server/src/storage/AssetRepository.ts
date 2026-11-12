/**
 * 素材的三张表：`assets`（资源的唯一真相）、`conversation_assets`（谁引用了它）与
 * `asset_vendor_files`（它的一部分可失效缓存）。
 *
 * 三张表的 SQL 放在同一个文件里，是因为它们的生命周期绑在一起，而另外两张都没有独立含义：
 *
 *   - `assets` 一行 = 数据根下一份文件 + 它的类型、大小、摘要、像素尺寸。`sha256` 全库唯一：
 *     同一份字节在整台机器上只有一行、一份磁盘，所以这一行是「这张图是什么」的唯一答案。
 *     它不记「属于哪段对话」——一张图可以同时被好几段对话引用。
 *   - `conversation_assets` 一行 = 「某条消息引用了某份素材」。归属与「几张会话引用了它」都从
 *     这张表算；消息被删（撤回 / 删对话）时关系行跟着级联消失，不需要谁去减计数。
 *     `assetId` 用 `ON DELETE RESTRICT`：还有引用时素材行在库里删不掉（护栏）。
 *   - `asset_vendor_files` 一行 = 「这个素材在这个端点上对应厂商的哪个 file_id」。厂商的
 *     `file_id` 是端点维度资源，所以它只当缓存：删光也能从 `assets` 重建（下次发送时
 *     重新上传一遍），`ON DELETE CASCADE` 让它跟着素材走。
 *
 * 存储层只做 SQL：不判断文件在不在、不上传、不决定「缓存能不能用」，也不判「该不该删字节」
 * （那是素材服务的事：它按 {@link AssetRepository.countReferences} 的结果决定）。
 */

import type { Database } from "./Database.js";
import type {
  AssetCreateInput,
  AssetRow,
  AssetVendorFileRow,
  AssetVendorFileUpsertInput,
  ConversationAssetRow,
} from "./types.js";

const COLUMNS = "id, name, path, mime, bytes, sha256, width, height, createdAt";

const VENDOR_COLUMNS = "assetId, endpointId, vendorFileId, createdAt";

/** 插入一个素材行的结果：`created` 为 false 说明库里已经有同摘要的那一行（全局去重命中） */
export interface AssetUpsertOutcome {
  row: AssetRow;
  created: boolean;
}

/** 一个素材的缓存行分布（`describeVendorFiles` 的出参） */
export interface AssetVendorFilePresence {
  /** 这个端点上已经有缓存行 */
  onEndpoint: boolean;
  /** 别的端点上有 */
  elsewhere: boolean;
}

export class AssetRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: AssetCreateInput): Promise<void> {
    await this.db.run(`INSERT INTO assets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.id,
      input.name ?? null,
      input.path,
      input.mime,
      input.bytes,
      input.sha256,
      input.width ?? null,
      input.height ?? null,
      input.createdAt,
    ]);
  }

  /**
   * 插入，但「库里已经有同摘要的那一行」时不报错、把既有行返回。
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
        `INSERT INTO assets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sha256) DO NOTHING`,
        [
          input.id,
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
      tx.get<AssetRow>(`SELECT ${COLUMNS} FROM assets WHERE sha256 = ?`, [input.sha256]),
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

  /** 按内容摘要找：全局去重（`asset.begin` 带 sha256 时走这一条） */
  async findByDigest(sha256: string): Promise<AssetRow | undefined> {
    return this.db.get<AssetRow>(`SELECT ${COLUMNS} FROM assets WHERE sha256 = ?`, [sha256]);
  }

  /** 一段对话引用的全部素材（同一份素材被这段对话里两条消息引用时只出现一次） */
  async listByConversation(conversationId: string): Promise<AssetRow[]> {
    return this.db.all<AssetRow>(
      `SELECT DISTINCT ${columnList("a")}
         FROM assets a
         JOIN conversation_assets ca ON ca.assetId = a.id
        WHERE ca.conversationId = ?
        ORDER BY a.createdAt ASC, a.id ASC`,
      [conversationId],
    );
  }

  /** 一条消息引用的全部素材 */
  async listByMessage(messageId: string): Promise<AssetRow[]> {
    return this.db.all<AssetRow>(
      `SELECT DISTINCT ${columnList("a")}
         FROM assets a
         JOIN conversation_assets ca ON ca.assetId = a.id
        WHERE ca.messageId = ?
        ORDER BY a.createdAt ASC, a.id ASC`,
      [messageId],
    );
  }

  /**
   * 记一行「这条消息引用了这份素材」。已经记过（同一 message + asset）时返回 0，
   * 否则返回 1：消息落库那一刻扫 `content` 里的 `__asset_id` 写行，重复写是常态。
   */
  async linkAsset(input: ConversationAssetRow): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO conversation_assets (conversationId, messageId, assetId, createdAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (messageId, assetId) DO NOTHING`,
      [input.conversationId, input.messageId, input.assetId, input.createdAt],
    );
    return result.changes;
  }

  /** 这份素材被几行引用（含同一段对话里的多条消息） */
  async countReferences(assetId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM conversation_assets WHERE assetId = ?",
      [assetId],
    );
    return row?.n ?? 0;
  }

  /** 「几张会话引用了它」：`COUNT(DISTINCT conversationId)` */
  async countConversations(assetId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      "SELECT COUNT(DISTINCT conversationId) AS n FROM conversation_assets WHERE assetId = ?",
      [assetId],
    );
    return row?.n ?? 0;
  }

  /** 一份素材被哪些对话引用（「贴到过哪几个项目」） */
  async listConversationIds(assetId: string): Promise<string[]> {
    const rows = await this.db.all<{ conversationId: string }>(
      `SELECT DISTINCT conversationId FROM conversation_assets
        WHERE assetId = ?
        ORDER BY conversationId ASC`,
      [assetId],
    );
    return rows.map((row) => row.conversationId);
  }

  /** 一条消息引用了哪些素材 id（撤回要回填输入框时用；关系行随消息级联删除，先读一次） */
  async listAssetIdsByMessage(messageId: string): Promise<string[]> {
    const rows = await this.db.all<{ assetId: string }>(
      `SELECT DISTINCT assetId FROM conversation_assets
        WHERE messageId = ?
        ORDER BY assetId ASC`,
      [messageId],
    );
    return rows.map((row) => row.assetId);
  }

  /** 一段对话引用过哪些素材 id（删对话前先读一次：删完之后关系行就没了） */
  async listAssetIdsByConversation(conversationId: string): Promise<string[]> {
    const rows = await this.db.all<{ assetId: string }>(
      `SELECT DISTINCT assetId FROM conversation_assets
        WHERE conversationId = ?
        ORDER BY assetId ASC`,
      [conversationId],
    );
    return rows.map((row) => row.assetId);
  }

  async delete(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM assets WHERE id = ?", [id]);
    return result.changes;
  }

  /**
   * 归零才删：关系行还在时这条语句删不掉（`NOT EXISTS` 与 `ON DELETE RESTRICT` 是同一件事的
   * 两道写法，前者让调用方拿到 0 行、后者保证真要删也不会带走别人的引用）。
   */
  async deleteIfUnreferenced(id: string): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM assets
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM conversation_assets WHERE assetId = ?)`,
      [id, id],
    );
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
      `INSERT INTO asset_vendor_files (${VENDOR_COLUMNS}) VALUES (?, ?, ?, ?)
       ON CONFLICT (assetId, endpointId) DO UPDATE SET
         vendorFileId = excluded.vendorFileId`,
      [input.assetId, input.endpointId, input.vendorFileId, input.createdAt],
    );
  }

  /**
   * 这个素材的缓存行分布：这个端点上有没有、别的端点上有没有。
   *
   * 两个事实一次查完，是因为它们要一起看才说得清该走哪条路：这个端点上有就是命中复用，
   * 只有别的端点上有就是换过端点（不重传、走内联），都没有才上传。
   */
  async describeVendorFiles(assetId: string, endpointId: string): Promise<AssetVendorFilePresence> {
    const row = await this.db.get<{ onEndpoint: number; elsewhere: number }>(
      `SELECT
         EXISTS (SELECT 1 FROM asset_vendor_files WHERE assetId = ? AND endpointId = ?) AS onEndpoint,
         EXISTS (SELECT 1 FROM asset_vendor_files WHERE assetId = ? AND endpointId <> ?) AS elsewhere`,
      [assetId, endpointId, assetId, endpointId],
    );
    return { onEndpoint: row?.onEndpoint === 1, elsewhere: row?.elsewhere === 1 };
  }
}

/** 给某个表别名拼一份带前缀的列名（join 时不能直接复用裸列名） */
function columnList(alias: string): string {
  return COLUMNS.split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}
