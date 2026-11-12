/**
 * `AssetRepository` 的验收：素材行只存引用、能挂到消息上、消息被删时行保留而引用置空、
 * 对话被删时行跟着走；以及这张表后面那层可失效缓存（`asset_vendor_files`）的四个动作。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { AssetRepository } from "./AssetRepository.js";

let dir: string;
let db: Database;
let repo: AssetRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-assets-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new AssetRepository(db);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/one",
    1,
  ]);
  await db.run(
    `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
     VALUES ('c1', 'w1', '对话', 0, 'agent-1', 'model-1', 2, 2)`,
  );
  await db.run(
    `INSERT INTO messages (id, conversationId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
     VALUES ('m1', 'c1', 1, 'user', 'completed', 0, '""', '', 3, 3)`,
  );
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AssetRepository", () => {
  it("上传时还没有消息：messageId 为空，之后可以挂上去", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      name: "photo.png",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 2048,
      sha256: "abc",
      createdAt: 10,
    });

    const before = await repo.get("a1");
    expect(before?.messageId).toBeNull();
    expect(await repo.listByMessage("m1")).toEqual([]);

    expect(await repo.linkToMessage("a1", "m1")).toBe(1);
    expect((await repo.listByMessage("m1")).map((row) => row.id)).toEqual(["a1"]);
    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual(["a1"]);
  });

  it("删消息后素材行还在、引用置空（文件路径不能丢）", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      messageId: "m1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      sha256: "digest-1",
      createdAt: 10,
    });

    await db.run("DELETE FROM messages WHERE id = ?", ["m1"]);

    const asset = await repo.get("a1");
    expect(asset?.messageId).toBeNull();
    expect(asset?.path).toBe("assets/a1.png");
  });

  it("删对话时素材行一并消失", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      sha256: "digest-1",
      createdAt: 10,
    });

    await db.run("DELETE FROM conversations WHERE id = ?", ["c1"]);
    expect(await repo.get("a1")).toBeUndefined();
  });

  it("单独删素材行", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      sha256: "digest-1",
      createdAt: 10,
    });

    expect(await repo.delete("a1")).toBe(1);
    expect(await repo.get("a1")).toBeUndefined();
  });
});

describe("对话内去重（按 conversationId + sha256）", () => {
  it("findByDigest 只在同一段对话里命中", async () => {
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c2', 'w1', '另一段', 0, 'agent-1', 'model-1', 2, 2)`,
    );
    await repo.create({
      id: "a1",
      conversationId: "c1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 4,
      sha256: "same-digest",
      createdAt: 10,
    });

    expect((await repo.findByDigest("c1", "same-digest"))?.id).toBe("a1");
    // 换一段对话：同一份字节是另一份资源（去重按对话做，不跨对话）
    expect(await repo.findByDigest("c2", "same-digest")).toBeUndefined();
    expect(await repo.findByDigest("c1", "other-digest")).toBeUndefined();
  });

  it("upsert：第一次插入，第二次回既有行（不再落一行）", async () => {
    const input = {
      conversationId: "c1",
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
    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual(["a1"]);
  });

  it("宽度 / 高度是可空的列（本波不解码图片）", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      sha256: "digest-1",
      createdAt: 10,
    });

    const row = await repo.get("a1");
    expect(row?.width).toBeNull();
    expect(row?.height).toBeNull();
    expect(row?.sha256).toBe("digest-1");
  });
});

describe("asset_vendor_files（可失效的缓存）", () => {
  /** 先有一条素材，缓存行都挂在它上面 */
  async function seedAsset(id = "a1", conversationId = "c1", digest = "digest-1"): Promise<void> {
    await repo.create({
      id,
      conversationId,
      path: `assets/${id}.png`,
      mime: "image/png",
      bytes: 1,
      sha256: digest,
      createdAt: 10,
    });
  }

  it("upsert 写入、再写覆盖 file_id 与 lastUsedAt（同一对 asset+etag 只有一行）", async () => {
    await seedAsset();

    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
      lastUsedAt: 20,
    });
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-2",
      createdAt: 30,
      lastUsedAt: 30,
    });

    expect(await repo.getVendorFile("a1", "ep-1")).toMatchObject({
      vendorFileId: "file-2",
      lastUsedAt: 30,
    });
  });

  it("touch 只改 lastUsedAt，不换 file_id", async () => {
    await seedAsset();
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
      lastUsedAt: 20,
    });

    expect(await repo.touchVendorFile("a1", "ep-1", 99)).toBe(1);
    expect(await repo.getVendorFile("a1", "ep-1")).toMatchObject({
      vendorFileId: "file-1",
      lastUsedAt: 99,
    });
    // 不存在的行：0 行被改动
    expect(await repo.touchVendorFile("a1", "ep-2", 99)).toBe(0);
  });

  it("listVendorFiles 按「这段对话 + 这个端点」取，端点不对就是空的", async () => {
    await seedAsset("a1");
    await seedAsset("a2", "c1", "digest-2");
    for (const [assetId, endpointId, at] of [
      ["a1", "ep-1", 20],
      ["a2", "ep-1", 30],
      ["a1", "ep-2", 40],
    ] as const) {
      await repo.upsertVendorFile({
        assetId,
        endpointId,
        vendorFileId: `file-${assetId}-${endpointId}`,
        createdAt: at,
        lastUsedAt: at,
      });
    }

    const rows = await repo.listVendorFiles("c1", "ep-1");
    expect(rows.map((row) => row.assetId)).toEqual(["a1", "a2"]);
    expect(await repo.listVendorFiles("c1", "ep-3")).toEqual([]);
  });

  it("deleteVendorFiles 只删「这段对话 + 这个端点」，返回删掉的行数", async () => {
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c2', 'w1', '另一段', 0, 'agent-1', 'model-1', 2, 2)`,
    );
    await seedAsset("a1", "c1");
    await seedAsset("a2", "c1", "digest-2");
    await seedAsset("a3", "c2", "digest-3");
    for (const assetId of ["a1", "a2", "a3"]) {
      await repo.upsertVendorFile({
        assetId,
        endpointId: "ep-1",
        vendorFileId: `file-${assetId}`,
        createdAt: 20,
        lastUsedAt: 20,
      });
    }

    expect(await repo.deleteVendorFiles("c1", "ep-1")).toBe(2);
    expect(await repo.listVendorFiles("c1", "ep-1")).toEqual([]);
    // 别的对话那一行还在（缓存按对话作废）
    expect((await repo.listVendorFiles("c2", "ep-1")).map((row) => row.assetId)).toEqual(["a3"]);
  });

  it("deleteVendorFile 删单条", async () => {
    await seedAsset();
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
      lastUsedAt: 20,
    });

    expect(await repo.deleteVendorFile("a1", "ep-1")).toBe(1);
    expect(await repo.getVendorFile("a1", "ep-1")).toBeUndefined();
    expect(await repo.deleteVendorFile("a1", "ep-1")).toBe(0);
  });

  it("素材删掉时缓存跟着走（ON DELETE CASCADE）", async () => {
    await seedAsset();
    await repo.upsertVendorFile({
      assetId: "a1",
      endpointId: "ep-1",
      vendorFileId: "file-1",
      createdAt: 20,
      lastUsedAt: 20,
    });

    await repo.delete("a1");
    expect(await repo.getVendorFile("a1", "ep-1")).toBeUndefined();
  });
});
