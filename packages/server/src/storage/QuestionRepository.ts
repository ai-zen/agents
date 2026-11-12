/**
 * `questions` 表仓储：问题对象的持久化（PRD D22：有状态、有生命周期、多端看同一个）。
 *
 * 状态机取值（`state`）与问题种类的具体含义属于上层（QuestionCenter 那一层），存储层
 * 只按调用方给的字符串存取，不解释它、也不替它做转移。
 */

import type { Database } from "./Database.js";
import type { Question, QuestionCreateInput, QuestionRow } from "./types.js";

const COLUMNS =
  "id, conversationId, kind, payload, state, answer, createdAt, updatedAt, answeredAt";

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    payload: parseJson(row.payload),
    state: row.state,
    answer: parseJson(row.answer),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    answeredAt: row.answeredAt,
  };
}

/** 要更新的字段；只给想改的那几项 */
export interface QuestionPatch {
  state?: string;
  /** 回答内容（会被 JSON 序列化）；显式传 `null` 表示清空 */
  answer?: unknown;
  answeredAt?: number | null;
  updatedAt: number;
}

export class QuestionRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: QuestionCreateInput): Promise<void> {
    await this.db.run(
      `INSERT INTO questions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      [
        input.id,
        input.conversationId ?? null,
        input.kind,
        JSON.stringify(input.payload ?? null),
        input.state,
        input.createdAt,
        input.createdAt,
      ],
    );
  }

  async get(id: string): Promise<Question | undefined> {
    const row = await this.db.get<QuestionRow>(
      `SELECT ${COLUMNS} FROM questions WHERE id = ?`,
      [id],
    );
    return row ? toQuestion(row) : undefined;
  }

  /** 某段对话下的问题，按创建时间升序；给了 `state` 就只取这个状态 */
  async listByConversation(conversationId: string, state?: string): Promise<Question[]> {
    const rows =
      state === undefined
        ? await this.db.all<QuestionRow>(
            `SELECT ${COLUMNS} FROM questions WHERE conversationId = ? ORDER BY createdAt ASC, id ASC`,
            [conversationId],
          )
        : await this.db.all<QuestionRow>(
            `SELECT ${COLUMNS} FROM questions
             WHERE conversationId = ? AND state = ?
             ORDER BY createdAt ASC, id ASC`,
            [conversationId, state],
          );
    return rows.map(toQuestion);
  }

  /**
   * 全库的问题，按创建时间升序（R61：`question.list` 不要求给对话）。
   *
   * 不按对话筛时，`conversationId` 为 NULL 的那些（例如「要不要把目录登记成项目」）也在结果里
   * —— 它们本来就与某段对话无关，用「按对话取」的查询永远看不到它们。
   */
  async listAll(state?: string): Promise<Question[]> {
    const rows =
      state === undefined
        ? await this.db.all<QuestionRow>(
            `SELECT ${COLUMNS} FROM questions ORDER BY createdAt ASC, id ASC`,
          )
        : await this.db.all<QuestionRow>(
            `SELECT ${COLUMNS} FROM questions WHERE state = ? ORDER BY createdAt ASC, id ASC`,
            [state],
          );
    return rows.map(toQuestion);
  }

  /**
   * 更新状态 / 回答。只拼出真正要改的列，没给的列保持不变
   * （例如只改 state 时不会把已有的 answer 抹掉）。
   */
  async update(id: string, patch: QuestionPatch): Promise<number> {
    const assignments: string[] = ["updatedAt = ?"];
    const params: (string | number | null)[] = [patch.updatedAt];

    if (patch.state !== undefined) {
      assignments.push("state = ?");
      params.push(patch.state);
    }
    if ("answer" in patch) {
      assignments.push("answer = ?");
      params.push(patch.answer === undefined ? null : JSON.stringify(patch.answer));
    }
    if (patch.answeredAt !== undefined) {
      assignments.push("answeredAt = ?");
      params.push(patch.answeredAt);
    }

    params.push(id);
    const result = await this.db.run(
      `UPDATE questions SET ${assignments.join(", ")} WHERE id = ?`,
      params,
    );
    return result.changes;
  }

  async delete(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM questions WHERE id = ?", [id]);
    return result.changes;
  }
}
