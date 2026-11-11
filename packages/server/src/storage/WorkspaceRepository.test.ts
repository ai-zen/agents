/**
 * `WorkspaceRepository` 的验收：基本读写、列表顺序、按 cwd 查、（删 Workspace 时）
 * 是否连带清掉它名下的对话由外键决定，这里顺带断言一次。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { WorkspaceRepository } from "./WorkspaceRepository.js";

let dir: string;
let db: Database;
let repo: WorkspaceRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-workspaces-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new WorkspaceRepository(db);
});

afterEach(async () => {
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
       VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`,
      ["c1", "w1", "对话", 100, 100],
    );

    expect(await repo.delete("w1")).toBe(1);
    expect(await repo.get("w1")).toBeUndefined();
    expect(await db.all("SELECT id FROM conversations")).toEqual([]);
  });
});
