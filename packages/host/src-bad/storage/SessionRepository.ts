/**
 * `sessions` 表仓储：只做 SQL，不含业务判断。
 *
 * 排序口径照 PRD D13：置顶优先，其次创建时间倒序。改名、活动、打开都不改变顺序，
 * 所以 `ORDER_BY` 里没有 `updatedAt`。
 *
 * 唯一一处跨表的语句是 {@link SessionRepository.replaceMemory}：交接换记忆时「插存档会话行 +
 * 搬消息行 + 写两条占位消息」必须在同一个事务里，拆到两个仓储就只能是两个事务。
 */

import type { HandoffMode } from "../wire/methods.js";
import type { CompactionMode } from "../wire/states.js";
import type { Database, RunResult, TxClient, TxStatement } from "./Database.js";
import { registerMessageUpsert } from "./MessageRepository.js";
import type { Session, SessionCreateInput, SessionMemorySwap, SessionRow } from "./types.js";

/** 读写路径共用的列清单（顺序与 `toSession` 的形状一致） */
const COLUMNS =
  "id, workspaceId, name, nameIsAuto, pinned, agentId, modelId, thinkingLevel, compactedAt, compactionMode, handoffThreshold, guardThreshold, pendingHandoff, autoHandoff, lineage, createdAt, updatedAt";

/**
 * 新建会话时显式写的那几列。
 *
 * 不复用 `COLUMNS`：压缩那两列在新建时一定是 NULL（新会话没压过），把 NULL 写进列清单只会
 * 让占位符与入参两处各自多两项、还得对着数，让它们走表的缺省值更省事。
 *
 * 两条阈值同样给 `null`（= 跟模型走），但它们在列表里：这两格与自动交接开关、血缘一样显式写。
 */
const INSERT_COLUMNS =
  "id, workspaceId, name, nameIsAuto, pinned, agentId, modelId, thinkingLevel, handoffThreshold, guardThreshold, autoHandoff, lineage, createdAt, updatedAt";

/** 列表/搜索统一用这个顺序：置顶在前，再按创建时间倒序 */
const ORDER_BY = "ORDER BY pinned DESC, createdAt DESC, id DESC";

/**
 * 登记一条「新建会话」语句：`nameIsAuto` 落 1（名字是创建时起的原名）、`pinned` 落 0。
 *
 * 自动交接开关与血缘由入参定（创建那一刻写死）：用户建 = 0 + NULL 血缘，平级会话 = 1 +
 * 父会话 id。两条阈值落 `null`（跟模型走）。
 *
 * 导出的理由与 `registerMessageUpsert` 同一个：交接换记忆那一批要把这条与消息的两条塞进同一个事务。
 */
export function registerSessionInsert(
  tx: TxClient,
  input: SessionCreateInput,
): TxStatement<RunResult> {
  const updatedAt = input.updatedAt ?? input.createdAt;
  return tx.run(
    `INSERT INTO sessions (${INSERT_COLUMNS})
     VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.workspaceId,
      input.name,
      input.agentId,
      input.modelId,
      input.thinkingLevel ?? null,
      input.handoffThreshold ?? null,
      input.guardThreshold ?? null,
      input.autoHandoff === true ? 1 : 0,
      input.lineage ?? null,
      input.createdAt,
      updatedAt,
    ],
  );
}

function toSession(row: SessionRow): Session {
  return {
    ...row,
    pinned: row.pinned !== 0,
    nameIsAuto: row.nameIsAuto !== 0,
    autoHandoff: row.autoHandoff !== 0,
    // 列上是自由字符串（库里没有枚举类型），认不出来的值按「没有待交接」算：它是宿主自己写的
    // 一格，读到一个说不清的值只可能意味着有人手改过库，那种行不该让整段会话读不出来
    pendingHandoff: toHandoffMode(row.pendingHandoff),
  };
}

/** 列上的待交接 mode；只认那两个值，其余（NULL / 认不出来）都是「没有待交接」 */
function toHandoffMode(value: string | null): HandoffMode | null {
  if (value === "self" || value === "summary") return value;
  return null;
}

/** LIKE 的通配符要转义，否则用户搜 "100%" 会变成任意匹配 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class SessionRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 新建会话：名字是创建时按时间起的原名，所以 `nameIsAuto` 落 1。
   * 用户改名与自动命名各有自己的方法，不从这条路径走。
   */
  async create(input: SessionCreateInput): Promise<void> {
    await this.db.tx((tx) => registerSessionInsert(tx, input));
  }

  /**
   * 交接换记忆：旧记忆成为另一段会话，原会话腾空之后换上 SDK 算好的那几条消息。
   *
   * 四步一批提交，顺序不能换：
   *   1. 插存档会话行（身份照抄原会话，只有 id / 名字 / 创建时刻是新的）；
   *   2. 把原会话的**全部消息行**改挂到存档名下 —— `seq` / `createdAt` 一个字都不动，搬的是归属；
   *   3. 消息的素材关系行跟着搬（`session_assets.sessionId` 也是「这条消息属于哪段
   *      会话」的一份记录，不搬的话删原会话会把它名下那些素材引用一起级联删掉，而消息其实在存档里）；
   *   4. 按顺序写回新记忆的那几条行（此时原会话已经腾空，`seq` 自然从 1 开始）。
   *
   * 4 里那条断点消息就是 **SDK 算出来的那一条**（`role: system` + `hidden` + 只带路径）：
   * 仓储不拼消息，它只把给它的行写下去，几条的顺序就按数组顺序。
   *
   * 整个交接的分工见 PLAN §5.3；这里的关键是四步必须同一个事务：只成前几步就留下「旧记忆
   * 已经存档、原会话却空着」的第三种状态，而失败时整批回滚不会留下一段存档会话。
   */
  async replaceMemory(input: SessionMemorySwap): Promise<void> {
    await this.db.tx((tx) => {
      registerSessionInsert(tx, input.archived);
      tx.run("UPDATE messages SET sessionId = ? WHERE sessionId = ?", [
        input.archived.id,
        input.sessionId,
      ]);
      tx.run("UPDATE session_assets SET sessionId = ? WHERE sessionId = ?", [
        input.archived.id,
        input.sessionId,
      ]);
      for (const row of input.memory) registerMessageUpsert(tx, row);
    });
  }

  async get(id: string): Promise<Session | undefined> {
    const row = await this.db.get<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`, [id]);
    return row ? toSession(row) : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<Session[]> {
    const rows = await this.db.all<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE workspaceId = ? ${ORDER_BY}`,
      [workspaceId],
    );
    return rows.map(toSession);
  }

  /**
   * 谁由这段会话开的（血缘列反查）：平级会话的并发限额要数「我手头有几个还忙着」。
   *
   * 血缘列没有索引：这张表小，而这条查询只在开平级会话那一刻走一次。
   */
  async listByLineage(lineage: string): Promise<Session[]> {
    const rows = await this.db.all<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE lineage = ? ${ORDER_BY}`,
      [lineage],
    );
    return rows.map(toSession);
  }

  /** 全部会话（跨 Workspace），排序口径同上 */
  async list(): Promise<Session[]> {
    const rows = await this.db.all<SessionRow>(`SELECT ${COLUMNS} FROM sessions ${ORDER_BY}`);
    return rows.map(toSession);
  }

  /**
   * 用户改名：名字归用户，`nameIsAuto` 置 0。
   * 身份与顺序都不受影响，只记一次修改时间。
   */
  async renameByUser(id: string, name: string, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE sessions SET name = ?, nameIsAuto = 0, updatedAt = ? WHERE id = ?",
      [name, updatedAt, id],
    );
    return result.changes;
  }

  /**
   * 自动命名：写入起好的名字，并把它标成自动起的那一个（`nameIsAuto` = 1）。
   *
   * 与用户改名分开成两个方法：两者的差别只在 `nameIsAuto` 这一列，靠调用方选方法来表达
   * 语义，读侧不必再猜名字是谁改的。
   */
  async applyAutoName(id: string, name: string, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE sessions SET name = ?, nameIsAuto = 1, updatedAt = ? WHERE id = ?",
      [name, updatedAt, id],
    );
    return result.changes;
  }

  async setPinned(id: string, pinned: boolean, updatedAt: number): Promise<number> {
    const result = await this.db.run("UPDATE sessions SET pinned = ?, updatedAt = ? WHERE id = ?", [
      pinned ? 1 : 0,
      updatedAt,
      id,
    ]);
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
      "UPDATE sessions SET modelId = ?, thinkingLevel = NULL, updatedAt = ? WHERE id = ?",
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
      "UPDATE sessions SET thinkingLevel = ?, updatedAt = ? WHERE id = ?",
      [thinkingLevel, updatedAt, id],
    );
    return result.changes;
  }

  /**
   * 写这段会话自己的两条阈值（会话行上的覆盖层）；`null` = 回到跟模型走。
   *
   * **只写入参里真的给了的那几格**：省略的那一列一个字节都不动 —— 「不给」与「显式给 `null`」
   * 是两件事，前者是「别碰它」，后者是「回到跟模型走」。
   *
   * 那两列不进 agent 的出厂配置（出厂配置 = 模型 + 它的参数），由宿主现读，所以写它们不牵动
   * 任何别的东西：不改 `modelId`、不清 `thinkingLevel`、不碰消息。
   *
   * @returns 改动的行数（会话已经不存在时是 0，不是错）
   */
  async setThresholds(
    id: string,
    patch: { handoffThreshold?: number | null; guardThreshold?: number | null },
    updatedAt: number,
  ): Promise<number> {
    const assignments: string[] = [];
    const values: (number | null)[] = [];
    if (patch.handoffThreshold !== undefined) {
      assignments.push("handoffThreshold = ?");
      values.push(patch.handoffThreshold);
    }
    if (patch.guardThreshold !== undefined) {
      assignments.push("guardThreshold = ?");
      values.push(patch.guardThreshold);
    }
    // 两格都没给就不发语句：空 UPDATE 只会白写一次 `updatedAt`
    if (assignments.length === 0) return 0;
    const result = await this.db.run(
      `UPDATE sessions SET ${assignments.join(", ")}, updatedAt = ? WHERE id = ?`,
      [...values, updatedAt, id],
    );
    return result.changes;
  }

  /**
   * 记一次压缩（两条压缩路径各自写，不互相覆盖别的列）。
   *
   * 为什么不动 `updatedAt`：那一列是「最后一次结构性变化」的时间（改名 / 换模型 / 改档位），
   * 压缩是上下文层的事，而且总是紧跟着一次回答跑完发生 —— 写进去只会让那一列变成
   * 「最后一次说话」。
   *
   * @returns 改动的行数（会话已经不存在时是 0，不是错）
   */
  async markCompacted(id: string, mode: CompactionMode, compactedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE sessions SET compactedAt = ?, compactionMode = ? WHERE id = ?",
      [compactedAt, mode, id],
    );
    return result.changes;
  }

  /**
   * 写会话行上的待交接标记（PLAN §5.2 的 `pendingHandoff`）：`"self"` / `"summary"` / `null`。
   *
   * 不动 `updatedAt`：那一列是「最后一次结构性变化」（改名 / 换模型 / 改档位），待交接是一段
   * 会话自己的进度，不是它的身份变了，客户端也不该因为它变而重排。
   *
   * @returns 改动的行数（会话已经不在了就是 0，不是错）
   */
  async setPendingHandoff(id: string, mode: HandoffMode | null): Promise<number> {
    const result = await this.db.run("UPDATE sessions SET pendingHandoff = ? WHERE id = ?", [
      mode,
      id,
    ]);
    return result.changes;
  }

  /**
   * 自动交接开关，写会话行上那一格。
   *
   * 调用方只有一处：用户答完交接题选了「不交接」（PRD 4.10 的「答案的后果要落」）——
   * 关掉之后下一次撞线不再问。创建那一刻的初值不走这里（见 `registerSessionInsert`）。
   *
   * 它是一格会话设置，所以照别处的口径记一次修改时间（同 `setPinned` / `setThresholds`）。
   *
   * @returns 改动的行数（会话已经不存在时是 0，不是错）
   */
  async setAutoHandoff(id: string, autoHandoff: boolean, updatedAt: number): Promise<number> {
    const result = await this.db.run(
      "UPDATE sessions SET autoHandoff = ?, updatedAt = ? WHERE id = ?",
      [autoHandoff ? 1 : 0, updatedAt, id],
    );
    return result.changes;
  }

  /** 硬删会话，消息、关系行与 inbox 行随之级联删除 */
  async delete(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    return result.changes;
  }

  /**
   * 按名字搜索。
   *
   * 名字搜索不走 FTS：名字短、还要支持只有一两个字的查询，`LIKE` 的子串语义正好对得上，
   * 也省掉维护第二张 FTS 表。
   */
  async searchByName(
    keyword: string,
    workspaceId: string | undefined,
    limit: number,
  ): Promise<Session[]> {
    const pattern = `%${escapeLike(keyword)}%`;
    if (workspaceId === undefined) {
      const rows = await this.db.all<SessionRow>(
        `SELECT ${COLUMNS} FROM sessions
         WHERE name LIKE ? ESCAPE '\\'
         ${ORDER_BY}
         LIMIT ?`,
        [pattern, limit],
      );
      return rows.map(toSession);
    }
    const rows = await this.db.all<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions
       WHERE workspaceId = ? AND name LIKE ? ESCAPE '\\'
       ${ORDER_BY}
       LIMIT ?`,
      [workspaceId, pattern, limit],
    );
    return rows.map(toSession);
  }
}
