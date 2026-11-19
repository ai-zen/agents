/**
 * `workspaces` 表仓储：只做 SQL，不含业务判断。
 *
 * 一个 Workspace 对应一个工作目录，`cwd` 创建后不可变（PRD D9：搬家＝新 Workspace），
 * 所以这里没有改 cwd 的方法 —— 想改只能建新的。
 */

import type { Database } from "./Database.js";
import type { WorkspaceCreateInput, WorkspaceRow } from "./types.js";

const COLUMNS = "id, name, cwd, createdAt";

export class WorkspaceRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: WorkspaceCreateInput): Promise<void> {
    // cwd 在表上唯一：同一个目录重复登记会在这里直接报 UNIQUE 约束错误
    await this.db.run(`INSERT INTO workspaces (${COLUMNS}) VALUES (?, ?, ?, ?)`, [
      input.id,
      input.name,
      input.cwd,
      input.createdAt,
    ]);
  }

  async get(id: string): Promise<WorkspaceRow | undefined> {
    return this.db.get<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE id = ?`, [id]);
  }

  /** 按 cwd 找登记过的 Workspace（PRD D10：普通会话遇到未登记的 cwd 时问一次） */
  async getByCwd(cwd: string): Promise<WorkspaceRow | undefined> {
    return this.db.get<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE cwd = ?`, [cwd]);
  }

  /** 全部 Workspace，新建的排前面 */
  async list(): Promise<WorkspaceRow[]> {
    return this.db.all<WorkspaceRow>(
      `SELECT ${COLUMNS} FROM workspaces ORDER BY createdAt DESC, id DESC`,
    );
  }

  async rename(id: string, name: string): Promise<number> {
    const result = await this.db.run("UPDATE workspaces SET name = ? WHERE id = ?", [name, id]);
    return result.changes;
  }

  /**
   * 删 Workspace：它名下的 sessions / messages / inbox / session_assets / notices 靠外键级联
   * 清掉（PRD D11：删项目连带删它名下的会话）。素材行不跟着走 —— 字节是全局的，删不删由
   * 「还有几张会话引用」决定。目录本身不在存储层职能范围内。
   */
  async delete(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM workspaces WHERE id = ?", [id]);
    return result.changes;
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM workspaces");
    return row?.n ?? 0;
  }
}
