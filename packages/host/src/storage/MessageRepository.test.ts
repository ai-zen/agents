/**
 * `MessageRepository` 的验收：边流边写的 upsert、seq 单调、`after` 三种分支、
 * subagent 消息按父工具调用取回（R37）与「subagent 那一半」的整段取回，以及全文检索在中文下的行为
 * （>= 3 字走 FTS5 trigram，2 字退化到 LIKE）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { MessageRepository } from "./MessageRepository.js";
import type { MessageUpsertInput } from "./types.js";

let dir: string;
let db: Database;
let repo: MessageRepository;

// 库与迁移整个文件只做一次（起 worker + migrate 是每条用例的大头），每个用例只清表。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-messages-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new MessageRepository(db);
});

beforeEach(async () => {
  await db.tx((tx) => [
    // meta 不清：migrate 靠它判断跑不跑
    tx.run("DELETE FROM notices"),
    // workspaces 必须在 assets 之前：删 workspace 级联删掉 session_assets 关系行，
    // 之后 assets 的 ON DELETE RESTRICT 才不会拦。messages 的 FTS 索引由触发器跟着维护
    tx.run("DELETE FROM workspaces"), // 级联 sessions → messages → session_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);

  // 两个 workspace，三个会话：搜索的三种范围都要有数据才测得出来
  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/project-one",
    1,
  ]);
  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w2",
    "项目二",
    "/tmp/project-two",
    2,
  ]);
  for (const [id, workspaceId, name, createdAt] of [
    ["c1", "w1", "会话一", 10],
    ["c2", "w1", "会话二", 20],
    ["c3", "w2", "会话三", 30],
  ] as const) {
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, workspaceId, name, "agent-1", "model-1", createdAt, createdAt],
    );
  }
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function message(overrides: Partial<MessageUpsertInput> & { id: string }): MessageUpsertInput {
  return {
    sessionId: "c1",
    role: "user",
    status: "completed",
    content: "",
    createdAt: 100,
    ...overrides,
  };
}

describe("MessageRepository.upsert", () => {
  it("写入后能原样读回正文、附加字段与 omit", async () => {
    await repo.upsert(
      message({
        id: "m1",
        content: "你好，世界",
        omit: true,
        data: { name: "user", hidden: false },
      }),
    );

    const stored = await repo.get("m1");
    expect(stored?.content).toBe("你好，世界");
    expect(stored?.omit).toBe(true);
    expect(stored?.data).toEqual({ name: "user", hidden: false });
    expect(stored?.seq).toBe(1);
  });

  it("同一条消息反复写：覆盖正文 / 状态 / omit，但 seq 与 createdAt 不变", async () => {
    await repo.upsert(message({ id: "m1", status: "pending", content: "部分", createdAt: 100 }));
    const first = await repo.get("m1");

    await repo.upsert(message({ id: "m1", status: "aborted", content: "部分内容（已中止）", omit: true, createdAt: 999 }));
    const second = await repo.get("m1");

    expect(second?.content).toBe("部分内容（已中止）");
    expect(second?.status).toBe("aborted");
    expect(second?.omit).toBe(true);
    // 流式过程中不能越写越往后跳
    expect(second?.seq).toBe(first?.seq);
    expect(second?.createdAt).toBe(100);
    expect(second?.updatedAt).toBe(999);
    // 覆盖不是新增
    expect(await repo.countBySession("c1")).toBe(1);
  });

  it("seq 在一段会话内单调递增，换一段会话重新从 1 开始", async () => {
    await repo.upsert(message({ id: "m1" }));
    await repo.upsert(message({ id: "m2" }));
    await repo.upsert(message({ id: "m3" }));
    await repo.upsert(message({ id: "other", sessionId: "c2" }));

    const seqs = await db.all<{ id: string; seq: number }>(
      "SELECT id, seq FROM messages WHERE sessionId = 'c1' ORDER BY seq",
    );
    expect(seqs).toEqual([
      { id: "m1", seq: 1 },
      { id: "m2", seq: 2 },
      { id: "m3", seq: 3 },
    ]);
    expect((await repo.get("other"))?.seq).toBe(1);
  });

  it("upsertMany 是一个事务：中途失败则整批不落库", async () => {
    await expect(
      repo.upsertMany([
        message({ id: "ok-1" }),
        // 会话不存在 → 外键失败 → 前一条也要回滚
        message({ id: "bad", sessionId: "nope" }),
      ]),
    ).rejects.toThrow();

    expect(await repo.countBySession("c1")).toBe(0);
  });
});

describe("一条取法：库里只有主线消息（CORE §17 / v5）", () => {
  it("list 与 count 数的是同一批行（没有第二套取法可对）", async () => {
    await repo.upsert(message({ id: "m1", createdAt: 100 }));
    await repo.upsert(message({ id: "m2", role: "assistant", createdAt: 200 }));
    // `hidden` 两边都不算：它在界面上从来没出现过
    await repo.upsert(message({ id: "cwd", data: { hidden: true }, createdAt: 50 }));

    const listed = await repo.listBySession("c1");
    expect(listed.map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(await repo.countBySession("c1")).toBe(listed.length);
  });
});

describe("MessageRepository.search", () => {
  const seed = async (): Promise<void> => {
    await repo.upsert(
      message({ id: "m1", sessionId: "c1", role: "user", content: "今天天气不错，我们去看海吧", createdAt: 100 }),
    );
    await repo.upsert(
      message({ id: "m2", sessionId: "c1", role: "assistant", content: "好的，海边风景很好", createdAt: 200 }),
    );
    await repo.upsert(
      message({ id: "m3", sessionId: "c2", role: "user", content: "另一段会话讲的是数据库索引", createdAt: 300 }),
    );
    await repo.upsert(
      message({ id: "m4", sessionId: "c3", role: "user", content: "第三个项目里提到了天气与海", createdAt: 400 }),
    );
  };

  it("3 个汉字的中文子串能命中（FTS5 trigram）", async () => {
    await seed();
    const hits = await repo.search(undefined, "天气不", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m1"]);
    expect(hits[0]?.snippet).toContain("天气不");
  });

  it("2 个汉字查询退化成 LIKE 也能命中", async () => {
    await seed();
    // trigram 下 2 个字符必然搜不到，这条用例盯的就是仓储里的退化分支
    const hits = await repo.search(undefined, "天气", 10);
    expect(hits.map((hit) => hit.id).sort()).toEqual(["m1", "m4"]);
  });

  it("3 字查询也能叠加范围过滤（FTS 分支带 join）", async () => {
    await seed();
    // 3 个字 → 走 FTS5 分支，同时按会话 / 按 Workspace 过滤
    expect((await repo.search({ sessionId: "c1" }, "天气不", 10)).map((hit) => hit.id)).toEqual(["m1"]);
    expect((await repo.search({ sessionId: "c2" }, "天气不", 10)).map((hit) => hit.id)).toEqual([]);
    expect((await repo.search({ workspaceId: "w1" }, "天气不", 10)).map((hit) => hit.id)).toEqual(["m1"]);
    expect((await repo.search({ workspaceId: "w2" }, "天气不", 10)).map((hit) => hit.id)).toEqual([]);
    // c3 明明含有「天气与海」，但它属于 w2，被 w1 的过滤条件挡住
    expect((await repo.search({ workspaceId: "w2" }, "天气与", 10)).map((hit) => hit.id)).toEqual(["m4"]);
  });

  it("改过内容之后，旧词搜不到、新词搜得到（FTS 触发器跟着更新）", async () => {
    await seed();
    await repo.upsert(message({ id: "m1", sessionId: "c1", content: "今天下雨，不去看海了", createdAt: 100 }));

    expect(await repo.search(undefined, "天气不", 10)).toEqual([]);
    expect((await repo.search(undefined, "今天下雨", 10)).map((hit) => hit.id)).toEqual(["m1"]);
  });

  it("关键词里的特殊符号不会把查询语法搞坏", async () => {
    await seed();
    await repo.upsert(
      message({ id: "m9", sessionId: "c1", content: '他说 "完成度 100%" 就行了 AND OR NOT', createdAt: 500 }),
    );

    await expect(repo.search(undefined, '100%"', 10)).resolves.toBeDefined();
    const hits = await repo.search(undefined, "完成度", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m9"]);
  });
});

describe("MessageRepository.deleteAfter（撤回，PRD D24）", () => {
  const seed = async (): Promise<void> => {
    await repo.upsert(message({ id: "m1", role: "user", createdAt: 100 }));
    await repo.upsert(message({ id: "m2", role: "assistant", createdAt: 200 }));
    await repo.upsert(message({ id: "m3", role: "user", createdAt: 300 }));
    await repo.upsert(message({ id: "m4", role: "assistant", createdAt: 400 }));
  };

  it("默认删掉锚点之后的消息", async () => {
    await seed();
    expect(await repo.deleteAfter("c1", "m2")).toBe(2);
    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("includeSelf 时连锚点一起删", async () => {
    await seed();
    expect(await repo.deleteAfter("c1", "m3", { includeSelf: true })).toBe(2);
    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("锚点不在该会话里时一条也不删", async () => {
    await seed();
    await repo.upsert(message({ id: "other", sessionId: "c2", createdAt: 500 }));
    expect(await repo.deleteAfter("c1", "other")).toBe(0);
    expect(await repo.countBySession("c1")).toBe(4);
  });
});
