/**
 * `conversations` 表仓储：只做 SQL，不含业务判断。
 *
 * 排序口径照 PRD D13：置顶优先，其次创建时间倒序。改名、活动、打开都**不**改变顺序，
 * 所以 `orderBy` 里没有 `updatedAt`。
 *
 * 唯一一处跨表的语句是 {@link ConversationRepository.replaceMemory}：交接换记忆时「插存档会话行 +
 * 搬消息行 + 写两条占位消息」必须在同一个事务里（PRD 4.5），拆到两个仓储就只能是两个事务。
 */

import type { CompactionMode } from "../wire/states.js";
import type { Database, RunResult, TxClient, TxStatement } from "./Database.js";
import { registerMessageUpsert } from "./MessageRepository.js";
import type {
  Conversation,
  ConversationCreateInput,
  ConversationMemorySwap,
  ConversationRow,
} from "./types.js";

/** 读写路径共用的列清单（顺序与 `toConversation` 的形状一致） */
const COLUMNS =
  "id, workspaceId, name, nameIsAuto, pinned, agentId, modelId, thinkingLevel, compactedAt, compactionMode, createdAt, updatedAt";

/**
 * 新建对话时显式写的那几列。
 *
 * 不复用 `COLUMNS`：压缩那两列（v2 加的）在新建时一定是 NULL（新会话没压过），把 NULL 写进
 * 列清单只会让占位符与入参两处各自多两项、还得对着数。让它们走表的缺省值更省事，也更准。
 */
const INSERT_COLUMNS =
  "id, workspaceId, name, nameIsAuto, pinned, agentId, modelId, thinkingLevel, createdAt, updatedAt";

/** 列表/搜索统一用这个顺序：置顶在前，再按创建时间倒序（PRD D13） */
const ORDER_BY = "ORDER BY pinned DESC, createdAt DESC, id DESC";

/**
 * 登记一条「新建对话」语句：`nameIsAuto` 落 1（名字是创建时起的原名）、`pinned` 落 0。
 *
 * 导出的理由与 `registerMessageUpsert` 同一个：交接换记忆那一批要把这条与消息的两条塞进同一个事务。
 */
export function registerConversationInsert(
  tx: TxClient,
  input: ConversationCreateInput,
): TxStatement<RunResult> {
  const updatedAt = input.updatedAt ?? input.createdAt;
  return tx.run(
    `INSERT INTO conversations (${INSERT_COLUMNS}) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
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
    await this.db.tx((tx) => registerConversationInsert(tx, input));
  }

  /**
   * 交接换记忆（PRD 4.5）：旧记忆成为另一段会话，原会话腾空之后换上「cwd + 断点」两条消息。
   *
   * 五条语句一批提交，顺序不能换：
   *   1. 插存档会话行（身份照抄原会话，只有 id / 名字 / 创建时刻是新的）；
   *   2. 把原会话的**全部消息行**改挂到存档名下 —— `seq` / `createdAt` 一个字都不动，搬的是归属；
   *   3. 消息的素材关系行跟着搬（`conversation_assets.conversationId` 也是「这条消息属于哪段
   *      会话」的一份记录，不搬的话删原会话会把它名下那些素材引用一起级联删掉，而消息其实在存档里）；
   *   4. 在原会话里写 cwd 消息（此时它已经腾空，`seq` 自然从 1 开始）；
   *   5. 再写断点消息。
   *
   * 4 一定要登记在 5 之前：`seq` 是写的时候现算的，先登记的那条先拿到号 —— 换完记忆这一段
   * 仍然是「cwd 消息在前、断点在后」，与创建时的口径一致（PRD 4.8）。
   *
   * 为什么这五条必须同一个事务：只成前几条就留下「旧记忆已经存档、原会话却空着」的第三种状态 ——
   * 那正是交接要防的（崩溃安全）。失败整批回滚，库里回到交接前，一段存档会话都不会留下。
   */
  async replaceMemory(input: ConversationMemorySwap): Promise<void> {
    await this.db.tx((tx) => {
      registerConversationInsert(tx, input.archived);
      tx.run("UPDATE messages SET conversationId = ? WHERE conversationId = ?", [
        input.archived.id,
        input.conversationId,
      ]);
      tx.run("UPDATE conversation_assets SET conversationId = ? WHERE conversationId = ?", [
        input.archived.id,
        input.conversationId,
      ]);
      registerMessageUpsert(tx, input.cwdContext);
      registerMessageUpsert(tx, input.breakpoint);
    });
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

  /**
   * 记一次压缩（两条压缩路径各自写，不互相覆盖别的列）。
   *
   * 为什么不动 `updatedAt`：那一列是「最后一次结构性变化」的时间（改名 / 换模型 / 改档位），
   * 压缩是上下文层的事，而且它总是紧跟着一轮跑完发生 —— 写进去只会让「最后修改」变成
   * 「最后一次说话」，那不是这一列的意思。
   *
   * @returns 改动的行数（对话已经不存在时是 0，不是错）
   */
  async markCompacted(
    id: string,
    mode: CompactionMode,
    compactedAt: number,
  ): Promise<number> {
    const result = await this.db.run(
      "UPDATE conversations SET compactedAt = ?, compactionMode = ? WHERE id = ?",
      [compactedAt, mode, id],
    );
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
}
