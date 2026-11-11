/**
 * `MessageRepository` 的验收：边流边写的 upsert、seq 单调、`after` 三种分支、
 * 以及全文检索在中文下的行为（>= 3 字走 FTS5 trigram，2 字退化到 LIKE）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-messages-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new MessageRepository(db);

  // 两个 workspace，三个对话：搜索的三种范围都要有数据才测得出来
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
    ["c1", "w1", "对话一", 10],
    ["c2", "w1", "对话二", 20],
    ["c3", "w2", "对话三", 30],
  ] as const) {
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, workspaceId, name, "agent-1", "model-1", createdAt, createdAt],
    );
  }
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function message(overrides: Partial<MessageUpsertInput> & { id: string }): MessageUpsertInput {
  return {
    conversationId: "c1",
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
    expect(await repo.countByConversation("c1")).toBe(1);
  });

  it("seq 在一段对话内单调递增，换一段对话重新从 1 开始", async () => {
    await repo.upsert(message({ id: "m1" }));
    await repo.upsert(message({ id: "m2" }));
    await repo.upsert(message({ id: "m3" }));
    await repo.upsert(message({ id: "other", conversationId: "c2" }));

    const seqs = await db.all<{ id: string; seq: number }>(
      "SELECT id, seq FROM messages WHERE conversationId = 'c1' ORDER BY seq",
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
        // 对话不存在 → 外键失败 → 前一条也要回滚
        message({ id: "bad", conversationId: "nope" }),
      ]),
    ).rejects.toThrow();

    expect(await repo.countByConversation("c1")).toBe(0);
  });
});

describe("MessageRepository.listByConversation（A12 的 after 三种分支）", () => {
  const seed = async (): Promise<void> => {
    await repo.upsert(message({ id: "m1", content: "第一条", createdAt: 100 }));
    await repo.upsert(message({ id: "m2", content: "第二条", createdAt: 200 }));
    await repo.upsert(message({ id: "m3", content: "第三条", createdAt: 300 }));
  };

  it("不给 after：返回整段历史，按 seq 升序", async () => {
    await seed();
    const rows = await repo.listByConversation("c1");
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("after 指向存在的消息：从它本身开始（含它），拿到的是它最新的内容", async () => {
    await seed();
    // 模拟流式中那条：内容又变了
    await repo.upsert(message({ id: "m2", content: "第二条（已写完）", status: "completed", createdAt: 200 }));

    const rows = await repo.listByConversation("c1", "m2");
    expect(rows.map((row) => row.id)).toEqual(["m2", "m3"]);
    expect(rows[0]?.content).toBe("第二条（已写完）");
  });

  it("after 指向不存在的消息：退回整段历史", async () => {
    await seed();
    const rows = await repo.listByConversation("c1", "已被删除的消息");
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("after 指向别的对话的消息：也当作不存在，返回整段历史", async () => {
    await seed();
    await repo.upsert(message({ id: "m-other", conversationId: "c2", createdAt: 400 }));

    const rows = await repo.listByConversation("c1", "m-other");
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("MessageRepository.search", () => {
  const seed = async (): Promise<void> => {
    await repo.upsert(
      message({ id: "m1", conversationId: "c1", role: "user", content: "今天天气不错，我们去看海吧", createdAt: 100 }),
    );
    await repo.upsert(
      message({ id: "m2", conversationId: "c1", role: "assistant", content: "好的，海边风景很好", createdAt: 200 }),
    );
    await repo.upsert(
      message({ id: "m3", conversationId: "c2", role: "user", content: "另一段对话讲的是数据库索引", createdAt: 300 }),
    );
    await repo.upsert(
      message({ id: "m4", conversationId: "c3", role: "user", content: "第三个项目里提到了天气与海", createdAt: 400 }),
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

  it("按 conversationId 限定范围", async () => {
    await seed();
    const hits = await repo.search({ conversationId: "c1" }, "海边", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m2"]);
    expect(hits[0]?.conversationName).toBe("对话一");
  });

  it("按 workspaceId 限定范围", async () => {
    await seed();
    const hits = await repo.search({ workspaceId: "w1" }, "对话", 10);
    expect(hits.map((hit) => hit.id).sort()).toEqual(["m3"]);
    // c3 在 w2 下，被过滤掉了
    const all = await repo.search(undefined, "天气不", 10);
    expect(all.map((hit) => hit.id)).toEqual(["m1"]);
  });

  it("3 字查询也能叠加范围过滤（FTS 分支带 join）", async () => {
    await seed();
    // 3 个字 → 走 FTS5 分支，同时按对话 / 按 Workspace 过滤
    expect((await repo.search({ conversationId: "c1" }, "天气不", 10)).map((hit) => hit.id)).toEqual(["m1"]);
    expect((await repo.search({ conversationId: "c2" }, "天气不", 10)).map((hit) => hit.id)).toEqual([]);
    expect((await repo.search({ workspaceId: "w1" }, "天气不", 10)).map((hit) => hit.id)).toEqual(["m1"]);
    expect((await repo.search({ workspaceId: "w2" }, "天气不", 10)).map((hit) => hit.id)).toEqual([]);
    // c3 明明含有「天气与海」，但它属于 w2，被 w1 的过滤条件挡住
    expect((await repo.search({ workspaceId: "w2" }, "天气与", 10)).map((hit) => hit.id)).toEqual(["m4"]);
  });

  it("改过内容之后，旧词搜不到、新词搜得到（FTS 触发器跟着更新）", async () => {
    await seed();
    await repo.upsert(message({ id: "m1", conversationId: "c1", content: "今天下雨，不去看海了", createdAt: 100 }));

    expect(await repo.search(undefined, "天气不", 10)).toEqual([]);
    expect((await repo.search(undefined, "今天下雨", 10)).map((hit) => hit.id)).toEqual(["m1"]);
  });

  it("关键词里的特殊符号不会把查询语法搞坏", async () => {
    await seed();
    await repo.upsert(
      message({ id: "m9", conversationId: "c1", content: '他说 "完成度 100%" 就行了 AND OR NOT', createdAt: 500 }),
    );

    await expect(repo.search(undefined, '100%"', 10)).resolves.toBeDefined();
    const hits = await repo.search(undefined, "完成度", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m9"]);
  });

  it("空关键词不查库，直接返回空", async () => {
    await seed();
    expect(await repo.search(undefined, "   ", 10)).toEqual([]);
  });

  it("limit 生效", async () => {
    await seed();
    const hits = await repo.search(undefined, "天气", 1);
    expect(hits).toHaveLength(1);
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
    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("includeSelf 时连锚点一起删", async () => {
    await seed();
    expect(await repo.deleteAfter("c1", "m3", { includeSelf: true })).toBe(2);
    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("锚点不在该对话里时一条也不删", async () => {
    await seed();
    await repo.upsert(message({ id: "other", conversationId: "c2", createdAt: 500 }));
    expect(await repo.deleteAfter("c1", "other")).toBe(0);
    expect(await repo.countByConversation("c1")).toBe(4);
  });
});
