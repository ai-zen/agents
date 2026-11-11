/**
 * `credentials` 表仓储：凭证的多串管理（PRD L11：可多串、带备注、可单独吊销）。
 *
 * 只存 sha256 摘要：明文只存在于生成它的那一层（创建时返回一次给用户），
 * 存储层既不生成明文、也不还原明文。
 */

import { createHash } from "node:crypto";
import type { Database } from "./Database.js";
import type {
  CredentialCreateInput,
  CredentialInfo,
  CredentialRow,
} from "./types.js";

const COLUMNS = "id, note, hash, createdAt, revokedAt";
const INFO_COLUMNS = "id, note, createdAt, revokedAt";

/**
 * 凭证摘要：sha256 十六进制。
 *
 * 上下游都按同一个口径算，所以这函数放在存储层旁边 —— 校验方（接线的鉴权）与写入方
 * 用同一份实现，不会出现一边加盐一边不加这种对不上的情况。
 */
export function hashCredential(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class CredentialRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: CredentialCreateInput): Promise<void> {
    await this.db.run(
      `INSERT INTO credentials (${COLUMNS}) VALUES (?, ?, ?, ?, NULL)`,
      [input.id, input.note, input.hash, input.createdAt],
    );
  }

  async get(id: string): Promise<CredentialRow | undefined> {
    return this.db.get<CredentialRow>(`SELECT ${COLUMNS} FROM credentials WHERE id = ?`, [id]);
  }

  /** 列出全部凭证（含已吊销的），不含 hash —— 展示层不需要它 */
  async list(): Promise<CredentialInfo[]> {
    return this.db.all<CredentialInfo>(
      `SELECT ${INFO_COLUMNS} FROM credentials ORDER BY createdAt ASC, id ASC`,
    );
  }

  /** 按摘要找一串仍然有效的凭证（鉴权用） */
  async findActiveByHash(hash: string): Promise<CredentialRow | undefined> {
    return this.db.get<CredentialRow>(
      `SELECT ${COLUMNS} FROM credentials WHERE hash = ? AND revokedAt IS NULL`,
      [hash],
    );
  }

  /** 吊销（不删行：留着能看出「这串曾经存在过」） */
  async revoke(id: string, revokedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE credentials SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL",
      [revokedAt, id],
    );
    return result.changes;
  }

  async countActive(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM credentials WHERE revokedAt IS NULL",
    );
    return row?.n ?? 0;
  }
}
