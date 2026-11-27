import type { DatabaseSync } from "node:sqlite";

import type { AgentNS } from "@ai-zen/agents-core";

import type { SessionRecord } from "../session/types.js";
import type { MessageSearchScope, SearchHit } from "./types.js";

/**
 * trigram 分词器能匹配的最小查询长度（按字符算，不是字节）：两字中文这类更短的词组在
 * trigram 下必然搜不到，一律退回 `LIKE` 子串匹配。
 */
const TRIGRAM_MIN_LENGTH = 3;

const SNIPPET_LENGTH = 160;

/** 命中位置之前保留的字数：让人看得出命中落在什么上下文里 */
const SNIPPET_LEAD = 40;

/**
 * 全文索引。`messages_fts` 是 `messages.searchText` 的索引，不是第二份消息：它是 external
 * content 表，正文仍然读 `messages`，这里只存分词结果。
 *
 * 同步只有触发器这一条实现：写消息的入口只有 `messages` 表，所以不存在「某条写路径忘了同步」
 * 的处境。反过来，那种「记得同时写索引」的函数一旦被绕过就是安静地少索引。
 *
 * 触发器指向 `messages`，这张表因此必须在 `messageTable` 之后建。
 */
export function searchTable(db: DatabaseSync) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
      searchText,
      content='messages',
      content_rowid='rowid',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_after_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, searchText) VALUES (new.rowid, new.searchText);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, searchText)
        VALUES ('delete', old.rowid, old.searchText);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_after_update AFTER UPDATE OF searchText ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, searchText)
        VALUES ('delete', old.rowid, old.searchText);
      INSERT INTO messages_fts (rowid, searchText) VALUES (new.rowid, new.searchText);
    END;
  `);

  /**
   * 片段在 SQL 里截：把整条 `payload` 拉回来再切，等于为一次搜索把全库正文读进 JS。
   *
   * 三处都写成 `m.searchText`：FTS 分支里两张表都有这一列，不限定就是歧义列。
   */
  const snippet = `CASE
      WHEN instr(m.searchText, ?) > 0
        THEN substr(m.searchText, max(1, instr(m.searchText, ?) - ${SNIPPET_LEAD}), ${SNIPPET_LENGTH})
      ELSE substr(m.searchText, 1, ${SNIPPET_LENGTH})
    END AS snippet`;

  return {
    messages(keyword: string, scope: MessageSearchScope, limit: number): SearchHit[] {
      const useFts = [...keyword].length >= TRIGRAM_MIN_LENGTH;
      const conditions: string[] = [];
      // 隐藏消息（注入的 cwd、交接断点）模型得看、但从不给人看；搜索结果里出现它们，
      // 用户会搜到一段自己从没见过的正文。
      conditions.push("m.hidden = 0");
      // 片段那两格先用掉，顺序与 SQL 里占位符的先后一致
      const params: string[] = [keyword, keyword];

      if (useFts) {
        conditions.push("messages_fts MATCH ?");
        // 整体加引号当短语：关键词里的符号就不会被当成 FTS 的查询语法
        params.push(`"${keyword.replace(/"/g, '""')}"`);
      } else {
        conditions.push("m.searchText LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(keyword)}%`);
      }

      if (scope !== undefined && "sessionId" in scope) {
        conditions.push("m.sessionId = ?");
        params.push(scope.sessionId);
      } else if (scope !== undefined) {
        conditions.push("s.workspaceId = ?");
        params.push(scope.workspaceId);
      }

      const from = useFts
        ? "messages_fts JOIN messages m ON m.rowid = messages_fts.rowid"
        : "messages m";

      // 会话名在 `sessions` 上没有生成列，只能从它的 `payload` 里取；消息自己的字段则整列
      // 带回，不在 SQL 里拆。
      return db
        .prepare(
          `SELECT m.id AS messageId, m.sessionId AS sessionId,
                  json_extract(s.payload, '$.name') AS sessionName,
                  m.payload AS payload, ${snippet}
             FROM ${from}
             JOIN sessions s ON s.id = m.sessionId
            WHERE ${conditions.join(" AND ")}
            ORDER BY m.createdAt DESC, m.seq DESC
            LIMIT ?`,
        )
        .all(...params, limit)
        .map((row) => ({
          messageId: String(row.messageId),
          sessionId: String(row.sessionId),
          sessionName: String(row.sessionName),
          snippet: String(row.snippet),
          message: JSON.parse(String(row.payload)) as AgentNS.Message,
        }));
    },

    /**
     * 按名字搜会话。名字在 `payload` 里，表上没有它的列：它不进索引，一条 `LIKE` 扫全表
     * 就是这个名字该有的规模。
     */
    sessions(keyword: string, workspaceId: string | undefined, limit: number): SessionRecord[] {
      const conditions = ["json_extract(payload, '$.name') LIKE ? ESCAPE '\\'"];
      const params: string[] = [`%${escapeLike(keyword)}%`];

      if (workspaceId !== undefined) {
        conditions.push("workspaceId = ?");
        params.push(workspaceId);
      }

      return db
        .prepare(
          `SELECT payload FROM sessions
            WHERE ${conditions.join(" AND ")}
            ORDER BY pinned DESC, createdAt DESC
            LIMIT ?`,
        )
        .all(...params, limit)
        .map((row) => JSON.parse(String(row.payload)) as SessionRecord);
    },
  };
}

/** `\`、`%`、`_` 在关键词里是真的字符：不转义就会被 `LIKE` 当成通配 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (character) => `\\${character}`);
}
