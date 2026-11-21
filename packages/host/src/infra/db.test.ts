/**
 * 三条验收：按旧 schema 建出来的库开出来之后 `searchText` 与 `hidden` 都在，版本推到了当前这一级；
 * 空库开出来仍然一张表都没有，版本同样是当前这一级；已经是新形状、版本号还停在 0 的库开得出来，
 * 既不会被再补一次列，索引也会按已有的行重建。
 *
 * 第二条守的是「迁移不建表」：`*Table(db)` 在 `openDatabase` 之后才跑，哪一级要是顺手建一张表，
 * 新库的建表语句就有了第二份真相。第三条守的是生成列在 `PRAGMA table_info` 里看不见这件事 ——
 * 照 `table_info` 判断缺列，前两条都还是绿的，只有这一条会红。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AgentNS, Message } from "@ai-zen/agents-core";
import { afterEach, describe, expect, it } from "vitest";

import { searchTable } from "../modules/search/table.js";
import { messageTable } from "../modules/session/messages.js";
import { openDatabase } from "./db.js";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

/** 落在磁盘上的库：旧形状得先建出来才能交给 `openDatabase`，`:memory:` 没有这个先建的机会 */
function databaseFile(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-db-"));
  dataRoots.push(dataRoot);
  return join(dataRoot, "ai-zen.db");
}

/** `hidden` 是生成列，`PRAGMA table_info` 里不出现，看列只能走 `table_xinfo` */
function columnNames(db: DatabaseSync): string[] {
  return db
    .prepare("PRAGMA table_xinfo(messages)")
    .all()
    .map((row) => String(row.name));
}

function userVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

describe("开库", () => {
  it("旧 schema 的库补上 searchText 与 hidden，版本推到 1", () => {
    const file = databaseFile();
    const legacy = new DatabaseSync(file);
    // 这两列进建表语句之前的那份形状：`CREATE TABLE IF NOT EXISTS` 对它是空操作，只能靠迁移补
    legacy.exec(`
      CREATE TABLE messages (
        id        TEXT PRIMARY KEY,
        payload   TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        createdAt INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED
      )
    `);
    legacy
      .prepare("INSERT INTO messages (id, payload, sessionId, seq) VALUES (?, ?, ?, ?)")
      .run(
        "m-1",
        JSON.stringify({ id: "m-1", content: "旧库里的一条", hidden: true, createdAt: 1 }),
        "s-1",
        1,
      );
    legacy.close();

    const db = openDatabase(file);

    expect(columnNames(db)).toEqual(expect.arrayContaining(["searchText", "hidden"]));
    expect(userVersion(db)).toBe(1);
    // 这个库里没有 `messages_fts`（旧库上那张虚拟表可能从来没建过），重建索引那一步要让开，
    // 而且旧行拿到的是空的索引文本与按 `payload` 现算的 `hidden`：补列不重写数据
    const row = db.prepare("SELECT searchText, hidden FROM messages WHERE id = 'm-1'").get();
    expect(row?.searchText).toBe("");
    expect(row?.hidden).toBe(1);
    db.close();
  });

  it("新库开出来是空的，版本同样是 1", () => {
    const db = openDatabase(":memory:");

    expect(userVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    db.close();
  });

  it("已经是新形状、版本号还停在 0 的库开得出来，索引按已有的行重建", () => {
    const file = databaseFile();
    // 当前代码建出来的那份形状：两列本来就在，版本号却还是 0 —— `user_version` 是这次才有的，
    // 所以每一台跑过当前代码的机器都落在这一条上
    const current = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    messageTable(current).upsert(
      "s-1",
      new Message({
        id: "m-1",
        role: AgentNS.Role.User,
        status: AgentNS.MessageStatus.Completed,
        content: "迁移之前写进去的一句",
      }),
    );
    // 索引在那一行之后才建：不重建的话它永远搜不到这一行
    searchTable(current);
    current.close();

    const db = openDatabase(file);

    expect(userVersion(db)).toBe(1);
    expect(db.prepare("SELECT searchText FROM messages WHERE id = 'm-1'").get()?.searchText).toBe(
      "迁移之前写进去的一句",
    );
    const hits = db
      .prepare("SELECT count(*) AS hits FROM messages_fts WHERE messages_fts MATCH ?")
      .get('"迁移之前"');
    expect(hits?.hits).toBe(1);
    db.close();
  });
});
