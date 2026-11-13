/**
 * `MetaRepository` 的验收：全新库（没有 `meta` 表）读出版本 0、迁移后读出真实版本与
 * 建库时间。版本号由 `migrations.migrate` 推进，这里只验证读取侧。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { MetaRepository } from "./MetaRepository.js";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-meta-"));
  db = new Database(join(dir, "ai-zen.db"));
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("MetaRepository", () => {
  it("全新库（没有 meta 表）不抛错，版本读作 0", async () => {
    const meta = new MetaRepository(db);
    expect(await meta.getSchemaVersion()).toBe(0);
    expect(await meta.getState()).toBeUndefined();
  });

  it("迁移后版本与建库时间都能读到", async () => {
    const before = Date.now();
    await migrate(db);
    const meta = new MetaRepository(db);

    const state = await meta.getState();
    expect(state?.schemaVersion).toBe(1);
    expect(state?.createdAt).toBeGreaterThan(0);
    expect(state?.createdAt).toBeGreaterThanOrEqual(before);
    expect(await meta.getSchemaVersion()).toBe(1);
  });
});
