/**
 * `InboxRepository` 的验收：条目**按原样**进去、按原样出来，顺序靠 `seq`（`createdAt` 会撞），
 * 以及「会话 / 工作区被删之后不留孤儿行」（外键级联）。
 *
 * 库与迁移整个文件只建一次（临时目录里，结束后删掉），每个用例只清表并铺一段会话 —
 * 与 `AssetRepository.test.ts` 同一套做法。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentNS } from "@ai-zen/agents-core";
import { Database } from "./Database.js";
import { InboxRepository } from "./InboxRepository.js";
import { migrate } from "./migrations.js";

let dir: string;
let db: Database;
let repo: InboxRepository;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-inbox-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new InboxRepository(db);
});

beforeEach(async () => {
  // 删 workspaces 就够了（会话 → inbox 行随外键级联一起没）；再顺手清一遍这张表不花什么
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM inbox"),
  ]);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/inbox-one",
    1,
  ]);
  for (const sessionId of ["c1", "c2"]) {
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, 'w1', '会话', 0, 'agent-1', 'model-1', 2, 2)`,
      [sessionId],
    );
  }
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** 一个条目的入参（每格都能改，好让用例只改它关心的那一格） */
function entryOf(
  messageId: string,
  extra: Partial<{ sessionId: string; createdAt: string }> = {},
): Parameters<InboxRepository["insert"]>[0] {
  return {
    messageId,
    sessionId: extra.sessionId ?? "c1",
    createdAt: extra.createdAt ?? "2026-01-02T03:04:05.000Z",
    source: { kind: "user" },
    content: "一句话",
  };
}

describe("InboxRepository", () => {
  it("落一行再按会话读回来：四个字段原样，顺序即入队顺序", async () => {
    await repo.insert(entryOf("m1", { createdAt: "2026-01-02T03:04:05.000Z" }));
    await repo.insert({
      ...entryOf("m2", { createdAt: "2026-01-02T03:04:05.000Z" }),
      source: { kind: "agent", label: "补测试" },
      content: "把测试补上",
    });

    const entries = await repo.listBySession("c1");
    expect(entries).toEqual([
      {
        messageId: "m1",
        createdAt: "2026-01-02T03:04:05.000Z",
        source: { kind: "user" },
        content: "一句话",
      },
      {
        messageId: "m2",
        // 同一毫秒进来的两条：`createdAt` 一模一样，靠 `seq` 才还原得回先后
        createdAt: "2026-01-02T03:04:05.000Z",
        source: { kind: "agent", label: "补测试" },
        content: "把测试补上",
      },
    ]);
    // 只看这一段会话的：别的会话的行不混进来
    expect(await repo.listBySession("c2")).toEqual([]);
  });

  it("内容按原样：多模态段与 `__asset_id` 逐字往返（库里存的就是那一份 JSON）", async () => {
    // 带本地素材标记 + 厂商产物的那一种内容（用户贴了一张图）：一个字都不许清理
    const content: AgentNS.MessageContent = [
      { type: "text", text: "这张图里是什么？" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
        // `__asset_id` 是宿主的本地标记，落库时原样存下去（换模型时靠它重建）
        __asset_id: "asset-1",
      } as unknown as AgentNS.MessageContentSection,
    ];

    await repo.insert({ ...entryOf("m1"), content });

    const row = await db.get<{ content: string }>(
      "SELECT content FROM inbox WHERE messageId = ?",
      ["m1"],
    );
    // 列里存的就是 `JSON.stringify` 的那一份（没有任何预处理）
    expect(row?.content).toBe(JSON.stringify(content));

    const [entry] = await repo.listBySession("c1");
    // 读回来再序列化一次，与内存里那份逐字相同
    expect(JSON.stringify(entry?.content)).toBe(JSON.stringify(content));
  });

  it("删除：按 id 删（被取走的那几条）与按会话清（`/clear`）", async () => {
    await repo.insert(entryOf("m1"));
    await repo.insert(entryOf("m2"));
    await repo.insert(entryOf("m3"));
    await repo.insert(entryOf("other", { sessionId: "c2" }));

    // 被取走两条：只剩那一条
    expect(await repo.deleteMany(["m1", "m2"])).toBe(2);
    expect((await repo.listBySession("c1")).map((entry) => entry.messageId)).toEqual(["m3"]);

    // 空数组什么都不做（`inboxTaken` 里可能一条 id 都没有）
    expect(await repo.deleteMany([])).toBe(0);

    // 清空这一段：另一段一条不动
    expect(await repo.clearBySession("c1")).toBe(1);
    expect(await repo.listBySession("c1")).toEqual([]);
    expect((await repo.listBySession("c2")).map((entry) => entry.messageId)).toEqual([
      "other",
    ]);
  });

  it("同一个 messageId 不会落两行（主键挡住重复投递的那一条）", async () => {
    await repo.insert(entryOf("m1"));
    await expect(repo.insert(entryOf("m1"))).rejects.toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it("删会话 / 删工作区之后没有孤儿行（外键级联）", async () => {
    await repo.insert(entryOf("m1"));
    await repo.insert(entryOf("m2", { sessionId: "c2" }));

    await db.run("DELETE FROM sessions WHERE id = ?", ["c1"]);
    expect(await repo.listBySession("c1")).toEqual([]);
    // 另一段照旧：级联只带走被删的那一段
    expect((await repo.listBySession("c2")).map((entry) => entry.messageId)).toEqual(["m2"]);

    await db.run("DELETE FROM workspaces WHERE id = ?", ["w1"]);
    expect(await repo.listBySession("c2")).toEqual([]);
    expect(await db.all("SELECT messageId FROM inbox")).toEqual([]);
  });

  it("指向不存在会话的条目插不进去（外键真的在拦）", async () => {
    await expect(repo.insert(entryOf("m1", { sessionId: "没有这段会话" }))).rejects.toThrow(
      /FOREIGN KEY/i,
    );
  });
});
