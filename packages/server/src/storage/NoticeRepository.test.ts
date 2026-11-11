/**
 * `NoticeRepository` 的验收：永久通知只能手动清、带时长的到点消失（PRD L3）、
 * 存的是码 + 参数而不是渲染好的句子。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { NoticeRepository } from "./NoticeRepository.js";

let dir: string;
let db: Database;
let repo: NoticeRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-notices-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new NoticeRepository(db);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("NoticeRepository", () => {
  it("存的是码 + 参数，读回来还是结构化的（可用别的语言重新渲染）", async () => {
    await repo.create({
      id: "n1",
      level: "warn",
      code: "config.endpoint.missing",
      params: { endpoint: "openai" },
      durationMs: null,
      createdAt: 100,
    });

    const notice = await repo.get("n1");
    expect(notice).toEqual({
      id: "n1",
      level: "warn",
      code: "config.endpoint.missing",
      params: { endpoint: "openai" },
      durationMs: null,
      createdAt: 100,
    });
  });

  it("永久通知不会自己消失；带时长的到点就查不到", async () => {
    await repo.create({ id: "forever", level: "info", code: "saved", createdAt: 100 });
    await repo.create({
      id: "brief",
      level: "info",
      code: "saved",
      durationMs: 1000,
      createdAt: 100,
    });

    // 两条同一时刻创建，按 id 排序：brief 在前
    expect((await repo.listActive(200)).map((row) => row.id)).toEqual(["brief", "forever"]);
    // 100 + 1000 已经过去
    expect((await repo.listActive(1200)).map((row) => row.id)).toEqual(["forever"]);
  });

  it("deleteExpired 只清到点的，返回清掉的条数", async () => {
    await repo.create({ id: "forever", level: "info", code: "saved", createdAt: 100 });
    await repo.create({ id: "brief", level: "info", code: "saved", durationMs: 50, createdAt: 100 });

    expect(await repo.deleteExpired(200)).toBe(1);
    expect(await repo.get("brief")).toBeUndefined();
    expect(await repo.get("forever")).toBeDefined();
  });

  it("手动清一条 / 清全部", async () => {
    await repo.create({ id: "n1", level: "info", code: "a", createdAt: 100 });
    await repo.create({ id: "n2", level: "error", code: "b", createdAt: 200 });

    expect(await repo.clear("n1")).toBe(1);
    expect(await repo.clear("n1")).toBe(0);
    expect(await repo.clearAll()).toBe(1);
    expect(await repo.listActive(0)).toEqual([]);
  });
});
