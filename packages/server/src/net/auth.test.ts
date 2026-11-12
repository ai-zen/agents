/**
 * 凭证层的验收：真相在库里（存 sha256）、本地凭证只在首次交付时写明文、吊销之后校验立刻不通过。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePaths, type ServerPaths } from "../config.js";
import { CredentialRepository, hashCredential } from "../storage/CredentialRepository.js";
import { Database } from "../storage/Database.js";
import { migrate } from "../storage/migrations.js";
import { CredentialService } from "../services/CredentialService.js";
import { createLocalCredential, createTokenVerifier, LOCAL_CREDENTIAL_NOTE, verify } from "./auth.js";
import { readLocalToken } from "./discovery.js";
import { makeTempDir, type TempDir } from "./TestSupport.js";

let dir: TempDir;
let paths: ServerPaths;
let db: Database;
let credentials: CredentialRepository;

beforeEach(async () => {
  dir = await makeTempDir("auth");
  paths = resolvePaths(dir.path);
  db = new Database(paths.dbFile);
  await migrate(db);
  credentials = new CredentialRepository(db);
});

afterEach(async () => {
  await db.close();
  await dir.remove();
});

describe("verify", () => {
  it("库里存的是摘要，明文校验通过", async () => {
    await credentials.create({
      id: "c1",
      note: "笔记本",
      hash: hashCredential("plain-token"),
      createdAt: 1,
    });

    const verified = await verify(db, "plain-token");
    expect(verified).toEqual({ id: "c1", note: "笔记本" });

    const stored = await credentials.get("c1");
    expect(stored?.hash).not.toBe("plain-token");
  });

  it("错的、空的、带多余空白的一律按对不上处理（空白会被去掉再算）", async () => {
    await credentials.create({
      id: "c1",
      note: "笔记本",
      hash: hashCredential("plain-token"),
      createdAt: 1,
    });

    expect(await verify(db, "wrong")).toBeNull();
    expect(await verify(db, "")).toBeNull();
    expect(await verify(db, "   ")).toBeNull();
    // 复制粘贴带上的空白不该让人连不上
    expect(await verify(db, " plain-token ")).toEqual({ id: "c1", note: "笔记本" });
  });

  it("吊销之后立刻不通过", async () => {
    const service = new CredentialService({ credentials, now: () => 10 });
    const created = await service.create({ note: "要吊销的" });
    expect(await verify(db, created.token)).not.toBeNull();

    await service.revoke({ credentialId: created.credential.id });
    expect(await verify(db, created.token)).toBeNull();
  });

  it("包成注入形状后行为一致", async () => {
    await credentials.create({
      id: "c1",
      note: "笔记本",
      hash: hashCredential("plain-token"),
      createdAt: 1,
    });
    const verifier = createTokenVerifier(db);
    expect(await verifier.verify("plain-token")).toEqual({ id: "c1", note: "笔记本" });
    expect(await verifier.verify("nope")).toBeNull();
  });
});

describe("createLocalCredential", () => {
  it("首次造一串、备注 local、并写进 run/token", async () => {
    const created = await createLocalCredential(db, paths, { now: () => 1_700_000_000_000 });

    expect(created.created).toBe(true);
    expect(created.token.length).toBeGreaterThanOrEqual(40);
    expect(await readLocalToken(paths)).toBe(created.token);

    const row = await credentials.get(created.credentialId);
    expect(row?.note).toBe(LOCAL_CREDENTIAL_NOTE);
    expect(row?.createdAt).toBe(1_700_000_000_000);
    // 库里没有明文
    expect(row?.hash).toBe(hashCredential(created.token));
    expect(await verify(db, created.token)).not.toBeNull();
  });

  it("再启动一次复用同一串（不是每次重启都换凭证）", async () => {
    const first = await createLocalCredential(db, paths);
    const second = await createLocalCredential(db, paths);

    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(second.credentialId).toBe(first.credentialId);
    expect(await credentials.countActive()).toBe(1);
  });

  it("交付文件里那串已吊销时，造一串新的并重写文件", async () => {
    const service = new CredentialService({ credentials });
    const first = await createLocalCredential(db, paths);
    await service.revoke({ credentialId: first.credentialId });

    const second = await createLocalCredential(db, paths);
    expect(second.created).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(await readLocalToken(paths)).toBe(second.token);
    expect(await verify(db, second.token)).not.toBeNull();
  });

  it("交付文件被手删了，再造一串（明文无从复原）", async () => {
    const first = await createLocalCredential(db, paths);
    await fs.rm(join(paths.runDir, "token"));

    const second = await createLocalCredential(db, paths);
    expect(second.created).toBe(true);
    expect(second.token).not.toBe(first.token);
  });

  it("rotate 强制换一串，旧串不再有效与否都不影响新串落盘", async () => {
    const first = await createLocalCredential(db, paths);
    const rotated = await createLocalCredential(db, paths, { rotate: true });

    expect(rotated.created).toBe(true);
    expect(rotated.token).not.toBe(first.token);
    expect(await readLocalToken(paths)).toBe(rotated.token);
    expect(await verify(db, rotated.token)).not.toBeNull();
  });
});
