/**
 * `ConversationRepository` 的验收：身份字段落库且必填、侧栏排序口径（置顶 + 创建时间倒序，
 * PRD D13）、改名不改顺序、名字是不是自动起的（R35）、按名字搜索与 LIKE 通配符转义。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { ConversationRepository } from "./ConversationRepository.js";
import type { ConversationCreateInput } from "./types.js";

let dir: string;
let db: Database;
let repo: ConversationRepository;

/** 对话身份（助手 / 模型）是必填的：不关心这两列的用例摊上这一份 */
const IDENTITY = { agentId: "agent-1", modelId: "model-1" } as const;

function input(fields: Omit<ConversationCreateInput, "agentId" | "modelId">): ConversationCreateInput {
  return { ...IDENTITY, ...fields };
}

// 库与迁移整个文件只做一次（起 worker + migrate 是每条用例的大头），每个用例只清表。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-conversations-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new ConversationRepository(db);
});

beforeEach(async () => {
  await db.tx((tx) => [
    // meta 不清：migrate 靠它判断跑不跑
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
    // workspaces 必须在 assets 之前：删 workspace 级联删掉 conversation_assets 关系行，
    // 之后 assets 的 ON DELETE RESTRICT 才不会拦
    tx.run("DELETE FROM workspaces"), // 级联 conversations → messages → conversation_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/one",
    1,
  ]);
  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w2",
    "项目二",
    "/tmp/two",
    2,
  ]);
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ConversationRepository", () => {
  it("创建时定下的项目与助手、加上模型与档位，能原样读回", async () => {
    await repo.create({
      id: "c1",
      workspaceId: "w1",
      name: "2026-11-12 10:00",
      agentId: "agent-1",
      modelId: "model-1",
      createdAt: 500,
    });

    const conversation = await repo.get("c1");
    expect(conversation).toEqual({
      id: "c1",
      workspaceId: "w1",
      name: "2026-11-12 10:00",
      // 创建时的原名就是自动起的名字（R35）
      nameIsAuto: true,
      pinned: false,
      agentId: "agent-1",
      modelId: "model-1",
      // 新建的会话不选档位：跟随助手定义上的那份参数
      thinkingLevel: null,
      // 新会话没压过：压缩那两列要等某一次真正的压缩才写（见 markCompacted）
      compactedAt: null,
      compactionMode: null,
      createdAt: 500,
      updatedAt: 500,
    });
  });

  it("压缩标记：写一次就落两列，且不动 updatedAt（压缩不是结构性变化）", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "原名", createdAt: 100 }));
    expect(await repo.markCompacted("c1", "auto", 900)).toBe(1);

    expect(await repo.get("c1")).toMatchObject({
      compactedAt: 900,
      compactionMode: "auto",
      // 结构那一列还是创建时那个
      updatedAt: 100,
    });

    // 再压一次（手动）就盖成新的那一份：只留最近一次的事实
    await repo.markCompacted("c1", "manual", 1500);
    expect(await repo.get("c1")).toMatchObject({ compactedAt: 1500, compactionMode: "manual" });

    // 对话不存在时是 0 行，不是错
    expect(await repo.markCompacted("c-missing", "auto", 1)).toBe(0);
  });

  it("换模型写这一列并顺手清掉档位；选档位只动那一列", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "原名", createdAt: 100 }));

    await repo.setThinkingLevel("c1", "high", 200);
    expect(await repo.get("c1")).toMatchObject({ modelId: "model-1", thinkingLevel: "high" });

    // 换模型：两句在一条语句里，档位不会留到新模型上
    await repo.setModel("c1", "model-2", 300);
    expect(await repo.get("c1")).toMatchObject({
      modelId: "model-2",
      thinkingLevel: null,
      updatedAt: 300,
    });

    // 清回「跟随助手」写的是 null
    await repo.setThinkingLevel("c1", "low", 400);
    await repo.setThinkingLevel("c1", null, 500);
    expect((await repo.get("c1"))?.thinkingLevel).toBeNull();
  });

  it("名字是不是自动起的写在这一列上：用户改名置 0，自动命名置 1（R35）", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "2026-11-12 10:00", createdAt: 100 }));
    expect((await repo.get("c1"))?.nameIsAuto).toBe(true);

    // 用户改名：名字从此归用户，即使改成一个跟原名无关的字串也不靠内容推断
    await repo.renameByUser("c1", "我的对话", 200);
    expect((await repo.get("c1"))?.name).toBe("我的对话");
    expect((await repo.get("c1"))?.nameIsAuto).toBe(false);

    // 自动命名：写新名并把它标回自动
    await repo.applyAutoName("c1", "重写存储层", 300);
    expect((await repo.get("c1"))?.name).toBe("重写存储层");
    expect((await repo.get("c1"))?.nameIsAuto).toBe(true);
  });

  it("用户把名字改回原样也仍然是用户改的（不靠名字内容判断）", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "2026-11-12 10:00", createdAt: 100 }));
    await repo.renameByUser("c1", "2026-11-12 10:00", 200);
    expect((await repo.get("c1"))?.nameIsAuto).toBe(false);
  });

  it("身份列不能为空：绕过仓储直接插 NULL 也被数据库拒（R18）", async () => {
    await expect(
      db.run(
        `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
         VALUES ('c-null', 'w1', '半成品', 0, NULL, 'model-1', 100, 100)`,
      ),
    ).rejects.toThrow(/NOT NULL/i);

    await expect(
      db.run(
        `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
         VALUES ('c-null2', 'w1', '半成品', 0, 'agent-1', NULL, 100, 100)`,
      ),
    ).rejects.toThrow(/NOT NULL/i);

    expect(await repo.listByWorkspace("w1")).toEqual([]);
  });

  it("列表：置顶优先，其次创建时间倒序", async () => {
    await repo.create(input({ id: "old", workspaceId: "w1", name: "旧", createdAt: 100 }));
    await repo.create(input({ id: "new", workspaceId: "w1", name: "新", createdAt: 300 }));
    await repo.create(input({ id: "mid", workspaceId: "w1", name: "中", createdAt: 200 }));
    await repo.create(input({ id: "other-ws", workspaceId: "w2", name: "别处", createdAt: 400 }));

    expect((await repo.listByWorkspace("w1")).map((row) => row.id)).toEqual(["new", "mid", "old"]);

    await repo.setPinned("old", true, 600);
    expect((await repo.listByWorkspace("w1")).map((row) => row.id)).toEqual(["old", "new", "mid"]);
  });

  it("改名不改变排序（PRD D13）", async () => {
    await repo.create(input({ id: "a", workspaceId: "w1", name: "甲", createdAt: 100 }));
    await repo.create(input({ id: "b", workspaceId: "w1", name: "乙", createdAt: 200 }));

    await repo.renameByUser("a", "甲（改过名）", 900);

    expect((await repo.listByWorkspace("w1")).map((row) => row.id)).toEqual(["b", "a"]);
    expect((await repo.get("a"))?.name).toBe("甲（改过名）");
  });

  it("按名字搜索：子串命中、可按 workspace 过滤、通配符被转义", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "重写存储层", createdAt: 100 }));
    await repo.create(input({ id: "c2", workspaceId: "w1", name: "100% 命中率", createdAt: 200 }));
    await repo.create(input({ id: "c3", workspaceId: "w2", name: "重写接线层", createdAt: 300 }));

    expect((await repo.searchByName("重写", undefined, 10)).map((row) => row.id).sort()).toEqual([
      "c1",
      "c3",
    ]);
    expect((await repo.searchByName("重写", "w1", 10)).map((row) => row.id)).toEqual(["c1"]);
    // "%" 被转义成普通字符，不能变成「匹配任意内容」
    expect((await repo.searchByName("100%", undefined, 10)).map((row) => row.id)).toEqual(["c2"]);
    expect(await repo.searchByName("%", undefined, 10)).toHaveLength(1);
  });

  it("limit 生效", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "甲", createdAt: 100 }));
    await repo.create(input({ id: "c2", workspaceId: "w1", name: "乙", createdAt: 200 }));

    expect(await repo.searchByName("", undefined, 1)).toHaveLength(1);
  });

  it("删对话是硬删（PRD D17）", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "甲", createdAt: 100 }));
    expect(await repo.delete("c1")).toBe(1);
    expect(await repo.get("c1")).toBeUndefined();
    expect(await repo.delete("c1")).toBe(0);
  });

  it("list() 跨 Workspace 取全部", async () => {
    await repo.create(input({ id: "c1", workspaceId: "w1", name: "甲", createdAt: 100 }));
    await repo.create(input({ id: "c2", workspaceId: "w2", name: "乙", createdAt: 200 }));
    expect((await repo.list()).map((row) => row.id)).toEqual(["c2", "c1"]);
  });
});
