/**
 * 凭证服务的验收：明文只在创建时出现一次、库里只存摘要、吊销是置 `revokedAt`。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CredentialRepository, hashCredential } from "../storage/CredentialRepository.js";
import { Database } from "../storage/Database.js";
import { migrate } from "../storage/migrations.js";
import { HostError } from "../wire/errors.js";
import { CredentialService } from "./CredentialService.js";

let dir: string;
let db: Database;
let repo: CredentialRepository;
let service: CredentialService;

// 整个文件共用一个库：`new + migrate` 每用例要 55ms，而清表只是一条 DELETE 批次
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-credentials-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new CredentialRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）
  await db.tx((tx) => [tx.run("DELETE FROM credentials")]);
  service = new CredentialService({ credentials: repo, now: () => 1_700_000_000_000 });
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("CredentialService", () => {
  it("创建时回一次明文，库里只有摘要", async () => {
    const result = await service.create({ note: "我的笔记本" });

    expect(result.token.length).toBeGreaterThanOrEqual(40);
    expect(result.credential.note).toBe("我的笔记本");
    expect(result.credential.revokedAt).toBeNull();
    expect(result.credential.createdAt).toBe(new Date(1_700_000_000_000).toISOString());

    // 摘要对得上 => 鉴权那一侧能靠同一个口径查到这串
    const active = await repo.findActiveByHash(hashCredential(result.token));
    expect(active?.id).toBe(result.credential.id);
    // 库里那一行的 hash 不是明文
    const stored = await repo.get(result.credential.id);
    expect(stored?.hash).not.toBe(result.token);
  });

  it("两次创建的明文不同", async () => {
    const first = await service.create({ note: "a" });
    const second = await service.create({ note: "b" });
    expect(first.token).not.toBe(second.token);
  });

  it("列出时不带摘要，能同时看到有效与已吊销", async () => {
    const first = await service.create({ note: "旧的" });
    await service.create({ note: "新的" });
    await service.revoke({ credentialId: first.credential.id });

    const listed = await service.list();
    expect(listed.credentials).toHaveLength(2);
    expect(listed.credentials.map((item) => item.note).sort()).toEqual(["新的", "旧的"]);
    expect(Object.keys(listed.credentials[0] ?? {})).not.toContain("hash");
    const revoked = listed.credentials.find((item) => item.id === first.credential.id);
    expect(revoked?.revokedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("吊销后再也查不到有效凭证；重复吊销返回 false", async () => {
    const created = await service.create({ note: "要吊销的" });
    const first = await service.revoke({ credentialId: created.credential.id });
    expect(first.revoked).toBe(true);
    expect(await repo.findActiveByHash(hashCredential(created.token))).toBeUndefined();

    const again = await service.revoke({ credentialId: created.credential.id });
    expect(again.revoked).toBe(false);
  });

  it("吊销不存在的凭证报 not_found", async () => {
    await expect(service.revoke({ credentialId: "没有这串" })).rejects.toBeInstanceOf(HostError);
  });
});
