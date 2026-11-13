/**
 * `meta` 表仓储：库自身的元信息（schema 版本、建库时间）。
 *
 * 表是单行表（`id` 固定 1）。版本号的推进只能由 `migrations.migrate` 在事务里完成，
 * 这里只提供读取 —— 否则「结构没改、版本号先动了」这种状态很容易被别的代码造出来。
 */

import type { Database } from "./Database.js";
import type { MetaRow } from "./types.js";

export class MetaRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 当前 schema 版本。库里还没有 `meta` 表（全新库）时返回 0，
   * 让 `migrate` 从第一级开始跑，而不是先抛一个「表不存在」。
   */
  async getSchemaVersion(): Promise<number> {
    if (!(await this.hasMetaTable())) return 0;
    const row = await this.db.get<MetaRow>(
      "SELECT id, schemaVersion, createdAt FROM meta WHERE id = 1",
    );
    return row?.schemaVersion ?? 0;
  }

  /** 元信息整行；全新库（表或行还不存在）返回 `undefined` */
  async getState(): Promise<MetaRow | undefined> {
    if (!(await this.hasMetaTable())) return undefined;
    return this.db.get<MetaRow>("SELECT id, schemaVersion, createdAt FROM meta WHERE id = 1");
  }

  /** 表存不存在：全新库还没跑过任何迁移，直接查 `meta` 会报「no such table」 */
  private async hasMetaTable(): Promise<boolean> {
    const row = await this.db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    );
    return row !== undefined;
  }
}
