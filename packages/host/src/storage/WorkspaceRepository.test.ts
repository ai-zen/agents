/**
 * `WorkspaceRepository` 的验收：基本读写、列表顺序、按 cwd 查、（删 Workspace 时）
 * 是否连带清掉它名下的对话由外键决定，这里顺带断言一次。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { WorkspaceRepository } from "./WorkspaceRepository.js";

let dir: string;
let db: Database;
let repo: WorkspaceRepository;

// 库与迁移整个文件只做一次（起 worker + migrate 是每条用例的大头），每个用例只清表。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-workspaces-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new WorkspaceRepository(db);
});

beforeEach(async () => {
  await db.tx((tx) => [
    // meta 不清：migrate 靠它判断跑不跑
    tx.run("DELETE FROM notices"),
    // workspaces 必须在 assets 之前：删 workspace 级联删掉 conversation_assets 关系行，
    // 之后 assets 的 ON DELETE RESTRICT 才不会拦
    tx.run("DELETE FROM workspaces"), // 级联 conversations → messages → conversation_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceRepository", () => {
  it("创建后能按 id 与 cwd 查回", async () => {
    await repo.create({ id: "w1", name: "项目一", cwd: "/tmp/one", createdAt: 100 });

    expect(await repo.get("w1")).toEqual({
      id: "w1",
      name: "项目一",
      cwd: "/tmp/one",
      createdAt: 100,
    });
    expect((await repo.getByCwd("/tmp/one"))?.id).toBe("w1");
    expect(await repo.getByCwd("/tmp/不存在")).toBeUndefined();
    expect(await repo.get("nope")).toBeUndefined();
  });

  it("同一个 cwd 不能登记两次（R14）", async () => {
    await repo.create({ id: "w1", name: "项目一", cwd: "/tmp/one", createdAt: 100 });

    await expect(
      repo.create({ id: "w2", name: "另一个名字", cwd: "/tmp/one", createdAt: 200 }),
    ).rejects.toThrow(/UNIQUE/i);

    // 失败的插入什么都没留下：仍然只有原来那个 Workspace
    expect(await repo.count()).toBe(1);
    expect((await repo.getByCwd("/tmp/one"))?.id).toBe("w1");
    expect(await repo.get("w2")).toBeUndefined();
  });

  it("列表按创建时间倒序（最近加的排前面）", async () => {
    await repo.create({ id: "w1", name: "旧", cwd: "/tmp/one", createdAt: 100 });
    await repo.create({ id: "w2", name: "新", cwd: "/tmp/two", createdAt: 200 });

    expect((await repo.list()).map((row) => row.id)).toEqual(["w2", "w1"]);
    expect(await repo.count()).toBe(2);
  });

  it("改名只动名字，cwd 不变（PRD D9：cwd 不可变）", async () => {
    await repo.create({ id: "w1", name: "旧名", cwd: "/tmp/one", createdAt: 100 });
    expect(await repo.rename("w1", "新名")).toBe(1);

    const workspace = await repo.get("w1");
    expect(workspace?.name).toBe("新名");
    expect(workspace?.cwd).toBe("/tmp/one");
  });

  it("删掉 Workspace 时它名下的对话一并消失（PRD D11）", async () => {
    await repo.create({ id: "w1", name: "项目一", cwd: "/tmp/one", createdAt: 100 });
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      ["c1", "w1", "对话", "agent-1", "model-1", 100, 100],
    );

    expect(await repo.delete("w1")).toBe(1);
    expect(await repo.get("w1")).toBeUndefined();
    expect(await db.all("SELECT id FROM conversations")).toEqual([]);
  });
});
