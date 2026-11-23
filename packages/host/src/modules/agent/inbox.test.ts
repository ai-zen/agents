/**
 * `inbox` 表的写那一格。
 *
 * 这张表有两个写入口（投递那条路先落库、观察者听 `inboxAdded` 再写一次同一个 id），所以
 * 「同一个 id 写两次」不是异常处境，而是每投一句都会发生的事。三件事要钉住：
 *
 * - 第二次写不留下第二行，也不更动第一次写下的载荷与 `seq`（`seq` 是排队顺序，重写一遍不该
 *   把这一条挪到队尾）；
 * - 另一个 id 照旧排在这一条后面，第二次写没有把 `seq` 的天花板抬起来；
 * - 真正没落进库的那几种失败（这里用「`sessionId` 指不到会话」的外键）仍然是一次抛错。
 */

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { inboxTable } from "./inbox.js";

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const db = openDatabase(":memory:");
  closers.push(() => db.close());

  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  sessionTable(db).put({
    id: "s-1",
    workspaceId: "ws-1",
    name: "1712345678000",
    nameIsAuto: true,
    pinned: false,
    agentId: "agent-1",
    modelId: "model-1",
    thinkingLevel: null,
    autoHandoff: false,
    lineage: null,
    handoffThreshold: null,
    guardThreshold: null,
    createdAt: 1,
    updatedAt: 1,
  });

  const inbox = inboxTable(db);
  const seqOf = (id: string): number => {
    const row = db.prepare("SELECT seq FROM inbox WHERE id = ?").get(id);
    return Number(row?.seq);
  };

  return { db, inbox, seqOf };
}

/** 投递那一路写下去的那一条（宿主自己投的 InboxEntry 都带 `messageId`） */
function entry(messageId: string, content: string, createdAt: string) {
  return {
    messageId,
    createdAt,
    priority: "high" as const,
    source: { kind: "user" as const },
    content,
  };
}

describe("inbox 表的写", () => {
  it("同一个 id 写两次：只有一行，`seq` 与先写下的载荷都不变", () => {
    const { inbox, seqOf } = setup();
    const first = entry("m-1", "这句话还在等", "2026-01-01T00:00:00.000Z");
    inbox.insert("s-1", first);
    const seqBefore = seqOf("m-1");

    // 第二次与第一次逐字相同：这就是「先落库再入队」之后 `inboxAdded` 又写一遍的那一次
    expect(() => inbox.insert("s-1", first)).not.toThrow();

    const rows = inbox.listBySession("s-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(first);
    expect(seqOf("m-1")).toBe(seqBefore);
  });

  it("同一个 id 的第二次写带的是另一份载荷：库里留的是先写的那一份", () => {
    const { inbox } = setup();
    inbox.insert("s-1", entry("m-1", "先写下的那一份", "2026-01-01T00:00:00.000Z"));
    inbox.insert("s-1", entry("m-1", "后写下的那一份", "2026-01-01T00:00:09.000Z"));

    const rows = inbox.listBySession("s-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("先写下的那一份");
    expect(rows[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("重复写没有抬走 `seq`：后进来那一条排在前一条之后", () => {
    const { inbox, seqOf } = setup();
    inbox.insert("s-1", entry("m-1", "第一句", "2026-01-01T00:00:00.000Z"));
    inbox.insert("s-1", entry("m-1", "第一句", "2026-01-01T00:00:00.000Z"));
    inbox.insert("s-1", entry("m-2", "第二句", "2026-01-01T00:00:01.000Z"));

    expect(seqOf("m-1")).toBe(1);
    expect(seqOf("m-2")).toBe(2);
    expect(inbox.listBySession("s-1").map((row) => row.messageId)).toEqual(["m-1", "m-2"]);
  });

  it("`sessionId` 指不到会话时照旧抛错：外键失败不是可以咽掉的那一种", () => {
    const { inbox } = setup();

    expect(() =>
      inbox.insert("no-such-session", entry("m-1", "没处安放", "2026-01-01T00:00:00Z")),
    ).toThrow();
    expect(inbox.listBySession("no-such-session")).toEqual([]);
  });
});
