/**
 * `AssetRepository` 的验收：素材行只存引用、去重是全局的（`sha256` 唯一）、
 * 引用关系在 `session_assets`（级联删 / 归零才删护栏），以及
 * `asset_vendor_files` 这张可失效缓存的四个动作。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { AssetRepository } from "./AssetRepository.js";

let dir: string;
let db: Database;
let repo: AssetRepository;

// 库与迁移整个文件只做一次（起 worker + migrate 是每条用例的大头），每个用例只清表。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-assets-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new AssetRepository(db);
});

beforeEach(async () => {
  await db.tx((tx) => [
    // meta 不清：migrate 靠它判断跑不跑
    tx.run("DELETE FROM notices"),
    // workspaces 必须在 assets 之前：删 workspace 级联删掉 session_assets 关系行，
    // 之后 assets 的 ON DELETE RESTRICT 才不会拦
    tx.run("DELETE FROM workspaces"), // 级联 sessions → messages → session_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/one",
    1,
  ]);
  for (const sessionId of ["c1", "c2"]) {
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, 'w1', '对话', 0, 'agent-1', 'model-1', 2, 2)`,
      [sessionId],
    );
  }
  await db.run(
    `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
     VALUES ('m1', 'c1', 1, 'user', 'completed', 0, '"hi"', 'hi', 3, 3)`,
  );
  await db.run(
    `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
     VALUES ('m2', 'c2', 1, 'user', 'completed', 0, '"hi"', 'hi', 3, 3)`,
  );
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** 一条素材行（素材本身不记对话，归属靠关系行） */
async function seedAsset(id = "a1", digest = "digest-1"): Promise<void> {
  await repo.create({
    id,
    name: "photo.png",
    path: `assets/${id}.png`,
    mime: "image/png",
    bytes: 1024,
    sha256: digest,
    createdAt: 10,
  });
}

describe("AssetRepository", () => {
  it("素材行只有引用与事实，没有归属列", async () => {
    await seedAsset();

    const row = await repo.get("a1");
    expect(row).toMatchObject({
      id: "a1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1024,
      sha256: "digest-1",
      createdAt: 10,
    });
    // 归属不在这一行上：它只由关系行回答
    expect(row && "sessionId" in row).toBe(false);
    expect(row && "messageId" in row).toBe(false);
    expect(await repo.listBySession("c1")).toEqual([]);
  });

  it("关系行：同一对 message + asset 只一行，重复写返回 0", async () => {
    await seedAsset();

    const link = { sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 };
    expect(await repo.linkAsset(link)).toBe(1);
    expect(await repo.linkAsset(link)).toBe(0);

    expect((await repo.listByMessage("m1")).map((row) => row.id)).toEqual(["a1"]);
    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual(["a1"]);
    expect(await repo.listAssetIdsByMessage("m1")).toEqual(["a1"]);
    expect(await repo.listAssetIdsBySession("c1")).toEqual(["a1"]);
  });

  it("同一段对话里两条消息引用同一份素材：素材只出现一次", async () => {
    await seedAsset();
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
       VALUES ('m3', 'c1', 2, 'user', 'completed', 0, '"again"', 'again', 4, 4)`,
    );
    await repo.linkAsset({ sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 });
    await repo.linkAsset({ sessionId: "c1", messageId: "m3", assetId: "a1", createdAt: 21 });

    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual(["a1"]);
    expect(await repo.countReferences("a1")).toBe(2);
    expect(await repo.countSessions("a1")).toBe(1);
  });

  it("「几张会话引用了它」= COUNT(DISTINCT sessionId)", async () => {
    await seedAsset();
    await repo.linkAsset({ sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 });
    await repo.linkAsset({ sessionId: "c2", messageId: "m2", assetId: "a1", createdAt: 21 });

    expect(await repo.countSessions("a1")).toBe(2);
    expect(await repo.listSessionIds("a1")).toEqual(["c1", "c2"]);
  });

  it("删消息：关系行跟着走，素材行还在（别人的引用不受影响）", async () => {
    await seedAsset();
    await repo.linkAsset({ sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 });
    await repo.linkAsset({ sessionId: "c2", messageId: "m2", assetId: "a1", createdAt: 21 });

    await db.run("DELETE FROM messages WHERE id = ?", ["m1"]);

    expect(await repo.listAssetIdsByMessage("m1")).toEqual([]);
    expect(await repo.get("a1")).toBeDefined();
    expect(await repo.countSessions("a1")).toBe(1);
  });

  it("删对话：只带走它自己的关系行", async () => {
    await seedAsset();
    await repo.linkAsset({ sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 });
    await repo.linkAsset({ sessionId: "c2", messageId: "m2", assetId: "a1", createdAt: 21 });

    await db.run("DELETE FROM sessions WHERE id = ?", ["c1"]);

    expect(await repo.listBySession("c1")).toEqual([]);
    expect((await repo.listBySession("c2")).map((row) => row.id)).toEqual(["a1"]);
    expect(await repo.get("a1")).toBeDefined();
  });

  it("还有引用时素材行物理删不掉（RESTRICT 护栏）", async () => {
    await seedAsset();
    await repo.linkAsset({ sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 });

    await expect(db.run("DELETE FROM assets WHERE id = ?", ["a1"])).rejects.toThrow();
    // 「归零才删」这条语句同样删不掉（返回 0 而不是抛错）
    expect(await repo.deleteIfUnreferenced("a1")).toBe(0);
    expect(await repo.get("a1")).toBeDefined();
  });

  it("引用归零之后才删得掉", async () => {
    await seedAsset();
    await repo.linkAsset({ sessionId: "c1", messageId: "m1", assetId: "a1", createdAt: 20 });
    await db.run("DELETE FROM messages WHERE id = ?", ["m1"]);

    expect(await repo.countReferences("a1")).toBe(0);
    expect(await repo.deleteIfUnreferenced("a1")).toBe(1);
    expect(await repo.get("a1")).toBeUndefined();
  });
});

describe("全局去重（按 sha256，不分对话）", () => {
  it("findByDigest 只按摘要找：换一段对话也命中同一行", async () => {
    await seedAsset("a1", "same-digest");

    expect((await repo.findByDigest("same-digest"))?.id).toBe("a1");
    expect(await repo.findByDigest("other-digest")).toBeUndefined();
  });

  it("upsert：第一次插入，第二次回既有行（不再落一行）", async () => {
    const input = {
      path: "assets/first.png",
      mime: "image/png",
      bytes: 8,
      sha256: "digest-x",
      createdAt: 10,
    };

    const first = await repo.upsert({ ...input, id: "a1" });
    expect(first.created).toBe(true);
    expect(first.row.id).toBe("a1");

    const second = await repo.upsert({ ...input, id: "a2", path: "assets/second.png" });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe("a1");
    expect(second.row.path).toBe("assets/first.png");
  });

  it("宽度 / 高度是可空的列（本波不解码图片）", async () => {
    await seedAsset();

    const row = await repo.get("a1");
    expect(row?.width).toBeNull();
    expect(row?.height).toBeNull();
    expect(row?.sha256).toBe("digest-1");
  });
});

describe("asset_vendor_files（厂商 file_id 的缓存）", () => {
  /** 先有一条素材，缓存行都挂在它上面 */
  async function seedLinkedAsset(id = "a1", sessionId = "c1", digest = "digest-1") {
    await seedAsset(id, digest);
    const messageId = sessionId === "c1" ? "m1" : "m2";
    await repo.linkAsset({ sessionId, messageId, assetId: id, createdAt: 20 });
  }

  it("upsert 写入、再写覆盖 file_id（同一对 asset+endpoint 只有一行）", async () => {
    await seedLinkedAsset();

    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
    });
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-2",
      createdAt: 30,
    });

    expect(await repo.getVendorFile("a1", "ep-1")).toMatchObject({ vendorFileId: "file-2" });
  });

  it("describeVendorFiles 分开报「这个端点上有没有」与「别的端点上有没有」", async () => {
    await seedLinkedAsset();
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
    });

    expect(await repo.describeVendorFiles("a1", "ep-1")).toEqual({
      onEndpoint: true,
      elsewhere: false,
    });
    // 换端点：这个端点上没有、另一个端点上才有
    expect(await repo.describeVendorFiles("a1", "ep-2")).toEqual({
      onEndpoint: false,
      elsewhere: true,
    });
    // 没传过的素材：两边都没有
    expect(await repo.describeVendorFiles("a9", "ep-1")).toEqual({
      onEndpoint: false,
      elsewhere: false,
    });
  });

  it("素材删掉时缓存跟着走（ON DELETE CASCADE）", async () => {
    await seedLinkedAsset();
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
    });
    await db.run("DELETE FROM messages WHERE id = ?", ["m1"]);

    expect(await repo.deleteIfUnreferenced("a1")).toBe(1);
    expect(await repo.getVendorFile("a1", "ep-1")).toBeUndefined();
  });
});
