/**
 * `CredentialRepository` 的验收：库里只有摘要、能按摘要找到有效凭证、可单独吊销、
 * 对外列表不带 hash（PRD L11：多串、带备注、权限相同、可单独吊销）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { CredentialRepository, hashCredential } from "./CredentialRepository.js";

let dir: string;
let db: Database;
let repo: CredentialRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-credentials-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new CredentialRepository(db);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("CredentialRepository", () => {
  it("摘要函数稳定：同一串明文永远得到同一摘要，且库里不出现明文", async () => {
    const token = "plain-secret-token";
    const hash = hashCredential(token);
    expect(hash).toBe(hashCredential(token));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);

    await repo.create({ id: "k1", note: "笔记本", hash, createdAt: 100 });

    const stored = await repo.get("k1");
    expect(stored?.hash).toBe(hash);
    expect(stored?.revokedAt).toBeNull();
    const raw = await db.get<{ n: number }>(
      "SELECT count(*) AS n FROM credentials WHERE hash LIKE ?",
      [`%${token}%`],
    );
    expect(raw?.n).toBe(0);
  });

  it("能按摘要找到有效凭证；吊销后就找不到了", async () => {
    const hash = hashCredential("token-a");
    await repo.create({ id: "k1", note: "手机", hash, createdAt: 100 });

    expect((await repo.findActiveByHash(hash))?.id).toBe("k1");

    expect(await repo.revoke("k1", 200)).toBe(1);
    expect(await repo.findActiveByHash(hash)).toBeUndefined();
    expect((await repo.get("k1"))?.revokedAt).toBe(200);
    // 重复吊销不生效
    expect(await repo.revoke("k1", 300)).toBe(0);
  });

  it("多串并存：列表带备注、不带 hash，只有一个是有效的也照样列出来", async () => {
    await repo.create({ id: "k1", note: "笔记本", hash: hashCredential("a"), createdAt: 100 });
    await repo.create({ id: "k2", note: "台式机", hash: hashCredential("b"), createdAt: 200 });
    await repo.revoke("k2", 300);

    const list = await repo.list();
    expect(list).toEqual([
      { id: "k1", note: "笔记本", createdAt: 100, revokedAt: null },
      { id: "k2", note: "台式机", createdAt: 200, revokedAt: 300 },
    ]);
    expect(await repo.countActive()).toBe(1);
  });

  it("同一摘要不会重复入库", async () => {
    const hash = hashCredential("same");
    await repo.create({ id: "k1", note: "甲", hash, createdAt: 100 });
    await expect(repo.create({ id: "k2", note: "乙", hash, createdAt: 200 })).rejects.toThrow(
      /UNIQUE|constraint/i,
    );
  });
});
