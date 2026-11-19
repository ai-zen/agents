/**
 * 素材服务的验收：落定与登记（含全局去重）、`assetIds` → 内容段（F-H7 / R44）、
 * 两层缓存（`assets` + 可失效的 `asset_vendor_files`）、`__asset_id` 的打上 / 剥离 / 还原、
 * 按 id 取内容（`asset.get`）、引用归零才删（R33）。
 *
 * 传输方式的选择交给 SDK 的 `fileToContentSection`（本服务不另写一套判定），所以用例里
 * 换成不同的端点/模型组合，验的是「最终走成了哪条路」以及「账有没有如实记」；
 * 上传次数用假上传的计数器验：命中缓存就不该发 HTTP。
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import type { Endpoint, Model } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolvePaths, type HostPaths } from "../config.js";
import { AssetRepository } from "../storage/AssetRepository.js";
import { Database } from "../storage/Database.js";
import { migrate } from "../storage/migrations.js";
import {
  MAX_ASSETS_PER_MESSAGE,
  localAssetIdOf,
  type AssetRef,
  type AttachmentOutcome,
  type LocalMessageContentSection,
} from "../wire/index.js";
import { HostError } from "../wire/errors.js";
import {
  AssetService,
  assetIdsOf,
  type AssetVendorRegistry,
  type AttachmentModelContext,
  type AttachmentPreparation,
  type AttachmentPrepareContext,
} from "./AssetService.js";
import { makeTempDir, type TempDir } from "../net/TestSupport.js";

let dir: TempDir;
let paths: HostPaths;
let db: Database;
let repo: AssetRepository;
let service: AssetService;
let assetsDir: string;
let modelContext: AttachmentModelContext;
let uploadedFiles: string[];

const NOW_MS = 1_700_000_000_000;

function endpoint(filesApi: boolean): Endpoint {
  return {
    id: filesApi ? "ep-files" : "ep-plain",
    name: "端点",
    baseUrl: "https://api.example.test",
    apiKey: "key-1",
    capabilities: filesApi ? { filesApi: true } : undefined,
  };
}

function model(vision: boolean): Model {
  return {
    id: "m-1",
    name: "Model One",
    endpointId: "ep-files",
    tokenThresholds: { handoff: 1000, guard: 1500 },
    vision,
  };
}

/**
 * 整个文件共用一个库：`migrate` + 建实例只跑一次，每个用例只付一条 `DELETE` 批次。
 */
beforeAll(async () => {
  dir = await makeTempDir("assets");
  paths = resolvePaths(dir.path);
  assetsDir = paths.assetsDir;
  db = new Database(paths.dbFile);
  await migrate(db);
  repo = new AssetRepository(db);
});

beforeEach(async () => {
  // 整个文件共用一个库（见 beforeAll）：这里把上一个用例写进去的行清掉。
  // `meta` 不能清（`migrate` 靠它判断要不要跑迁移），FTS 由触发器跟着维护。
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  // 素材文件也要清：好几条用例断言「assets 目录里只剩这几份」
  await fs.rm(assetsDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });

  await db.run(
    "INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目', '/tmp/w1', 1)",
  );
  await db.run(
    `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
     VALUES ('c1', 'w1', '会话', 0, 'agent-1', 'm-1', 2, 2)`,
  );
  await db.run(
    `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
     VALUES ('msg-1', 'c1', 1, 'user', 'completed', 0, '"hi"', 'hi', 3, 3)`,
  );

  modelContext = { model: model(true), endpoint: endpoint(false) };
  uploadedFiles = [];
  service = new AssetService({
    assets: repo,
    // 厂商 file_id 的缓存表就挂在同一个仓储上（两层缓存：assets 是真相，这张是缓存）
    vendorFiles: repo,
    paths,
    resolveModelContext: () => modelContext,
    toolEnv: {
      upload: async ({ filename }) => {
        uploadedFiles.push(filename);
        return `file-${uploadedFiles.length}`;
      },
    },
    now: () => NOW_MS,
  });
});

afterAll(async () => {
  await db.close();
  await dir.remove();
});

// ---------------------------------------------------------------------------
// 造素材
// ---------------------------------------------------------------------------

/** 一份假的图片字节（内容不重要：这里不验图片解码，只验字节如何被搬动） */
function imageBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7) % 251;
  return bytes;
}

/** 一份带真头的 PNG：8 字节签名 + IHDR 块（宽高就在里面，后面是占位的空字节） */
function pngBytes(width: number, height: number, tail = 16): Buffer {
  const buffer = Buffer.alloc(33 + tail);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

/** 一份带真头的 JPEG：SOI + APP1（EXIF 占位）+ SOF0 段（高宽在里面）+ SOS */
function jpegBytes(width: number, height: number): Buffer {
  const app = Buffer.alloc(4 + 16);
  app[0] = 0xff;
  app[1] = 0xe1;
  app.writeUInt16BE(18, 2);

  const frame = Buffer.alloc(4 + 15);
  frame[0] = 0xff;
  frame[1] = 0xc0;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app,
    frame,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0x00]),
  ]);
}

/** 走一遍「上传收完 → 落定登记」：临时文件进、正式素材出 */
async function uploadAsset(
  bytes: Uint8Array,
  options: { mime?: string; name?: string | null; sessionId?: string } = {},
): Promise<AssetRef> {
  await fs.mkdir(assetsDir, { recursive: true });
  const uploadId = randomUUID();
  const tempPath = join(assetsDir, `.upload-${uploadId}.part`);
  await fs.writeFile(tempPath, bytes);
  return await service.finalizeUpload({
    uploadId,
    tempPath,
    mime: options.mime ?? "image/png",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    name: options.name === undefined ? "photo.png" : options.name,
    purpose: "message_image",
    sessionId: options.sessionId ?? "c1",
  });
}

function prepare(
  assetIds: string[],
  content: AgentNS.MessageContent = "看看这张图",
): AttachmentPrepareContext {
  return {
    sessionId: "c1",
    agentId: "agent-1",
    modelId: "m-1",
    input: { content, assetIds },
  };
}

function outcomeOf(attachments: AttachmentOutcome[], assetId: string): AttachmentOutcome {
  const found = attachments.find((item) => item.assetId === assetId);
  if (!found) throw new Error(`没有 ${assetId} 的结局`);
  return found;
}

/** 带本地扩展字段的内容段（字面量直接写的话，core 的类型不认这些 `__` 键） */
function localSections(...sections: LocalMessageContentSection[]): LocalMessageContentSection[] {
  return sections;
}

/** 走一遍「消息落库那一刻」：把内容里的 `__asset_id` 记成关系行 */
async function linkToMessage(
  assetId: string,
  options: { messageId?: string; sessionId?: string } = {},
): Promise<number> {
  return await service.linkMessageAssets({
    sessionId: options.sessionId ?? "c1",
    messageId: options.messageId ?? "msg-1",
    content: localSections({ type: "image_url", image_url: { url: "" }, __asset_id: assetId }),
  });
}

// ---------------------------------------------------------------------------
// 落定与登记
// ---------------------------------------------------------------------------

describe("finalizeUpload", () => {
  it("临时文件改名成正式文件，并在 assets 表登记一行", async () => {
    const bytes = imageBytes();

    const ref = await uploadAsset(bytes, { name: "photo.png" });

    expect(ref).toMatchObject({ mime: "image/png", bytes: bytes.byteLength, name: "photo.png" });
    expect(ref.assetId.length).toBeGreaterThan(10);

    const row = await repo.get(ref.assetId);
    expect(row).toMatchObject({
      path: `assets/${ref.assetId}.png`,
      mime: "image/png",
      bytes: bytes.byteLength,
      createdAt: NOW_MS,
    });
    // 文件在正式位置，内容一致；临时文件没了
    const written = await fs.readFile(join(assetsDir, `${ref.assetId}.png`));
    expect(new Uint8Array(written)).toEqual(bytes);
    expect((await fs.readdir(assetsDir)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("表外 MIME 落 .bin（取用时改走「字节 + 显式 mime」那条来源）", async () => {
    const ref = await uploadAsset(imageBytes(8), { mime: "application/x-weird" });
    expect((await repo.get(ref.assetId))?.path).toBe(`assets/${ref.assetId}.bin`);
  });

  it("落定时解出 PNG 的宽高：出参与 assets 行都是真值（R76）", async () => {
    const ref = await uploadAsset(pngBytes(120, 80));

    expect(ref).toMatchObject({ mime: "image/png", width: 120, height: 80 });
    expect(await repo.get(ref.assetId)).toMatchObject({ width: 120, height: 80 });
  });

  it("落定时解出 JPEG 的宽高（SOF0 段）", async () => {
    const ref = await uploadAsset(jpegBytes(640, 480), { mime: "image/jpeg", name: "photo.jpg" });

    expect(ref).toMatchObject({ mime: "image/jpeg", width: 640, height: 480 });
    expect(await repo.get(ref.assetId)).toMatchObject({ width: 640, height: 480 });
  });

  it("不是图片：宽高都是 null（不解、不猜）", async () => {
    const ref = await uploadAsset(Buffer.from("%PDF-1.7 一份文档", "utf8"), {
      mime: "application/pdf",
      name: "doc.pdf",
    });

    expect(ref).toMatchObject({ width: null, height: null });
    expect(await repo.get(ref.assetId)).toMatchObject({ width: null, height: null });
  });

  it("截断的 PNG：宽高为 null，上传照样成功", async () => {
    // 只留签名与块头：IHDR 的宽高字段没进来
    const truncated = pngBytes(120, 80).subarray(0, 20);

    const ref = await uploadAsset(truncated);

    expect(ref).toMatchObject({ mime: "image/png", bytes: truncated.byteLength });
    expect(ref.width).toBeNull();
    expect(ref.height).toBeNull();
    expect(await repo.get(ref.assetId)).toMatchObject({ width: null, height: null });
    // 素材确实落成了正式文件
    expect((await fs.readFile(join(assetsDir, `${ref.assetId}.png`))).byteLength).toBe(
      truncated.byteLength,
    );
  });

  it("linkMessageAssets：扫落库内容里的 __asset_id 记关系行（同一 message+asset 只一行）", async () => {
    const ref = await uploadAsset(imageBytes(8));

    expect(await linkToMessage(ref.assetId)).toBe(1);
    expect(await linkToMessage(ref.assetId)).toBe(0);
    expect((await repo.listByMessage("msg-1")).map((row) => row.id)).toEqual([ref.assetId]);
    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual([ref.assetId]);
    expect(await repo.countSessions(ref.assetId)).toBe(1);
  });

  it("linkMessageAssets：认不得的素材 id 不炸整轮（只少记一行）", async () => {
    expect(await linkToMessage("no-such-asset")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// assetIds → 内容段（F-H7）
// ---------------------------------------------------------------------------

describe("prepareAttachments", () => {
  it("没有素材时原样透传（不凭空造段）", async () => {
    const prepared = await service.prepareAttachments(prepare([]));
    expect(prepared.content).toBe("看看这张图");
    expect(prepared.attachments).toEqual([]);
  });

  it("端点没有 Files API：内联成 image_url，且文本段在前", async () => {
    const ref = await uploadAsset(imageBytes(32));

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    const outcome = outcomeOf(prepared.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("inline");
    expect(outcome.problem).toBeNull();
    expect(outcome.section?.type).toBe("image_url");

    const content = prepared.content as AgentNS.MessageContentSection[];
    expect(content).toHaveLength(2);
    // 用户打的字是第一段
    expect(content[0]).toEqual({ type: "text", text: "看看这张图" });
    expect(content[1]?.type).toBe("image_url");
    const url = (content[1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("端点声明 Files API：走文件引用，并且第二次取用命中缓存、不再发 HTTP", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(16));

    const first = await service.prepareAttachments(prepare([ref.assetId]));
    const outcome = outcomeOf(first.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("file_reference");
    // `file_id` 已经是引用，名字不跟着走（`filename` 只在 `file_data` 时才有意义，见 core 的类型）
    expect(outcome.section).toEqual({ type: "file", file_id: "file-1", __asset_id: ref.assetId });
    expect(outcome.section).not.toHaveProperty("filename");
    expect(uploadedFiles).toEqual([`${ref.assetId}.png`]);

    // SDK 不记厂商侧的文件 id，由我们的表记：第二次取用同一张图，
    // `asset_vendor_files` 命中，一个 HTTP 都不发
    const second = await service.prepareAttachments(prepare([ref.assetId]));
    expect(outcomeOf(second.attachments, ref.assetId).section).toEqual({
      type: "file",
      file_id: "file-1",
      __asset_id: ref.assetId,
    });
    expect(uploadedFiles).toHaveLength(1);
  });

  it("模型读不了图：退化成文字（带名字、不带磁盘路径），并如实记账", async () => {
    modelContext = { model: model(false), endpoint: endpoint(false) };
    const ref = await uploadAsset(imageBytes(16));

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    const outcome = outcomeOf(prepared.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("text_fallback");
    // 退化成文字也留着引用：客户端照样能说「这条消息用了哪份素材」，换模型时还能重建回来
    expect(outcome.section).toEqual({
      type: "text",
      text: "[Image] photo.png（当前模型看不了图片）",
      __asset_id: ref.assetId,
    });
    expect(outcome.problem?.messageKey).toBe("message.imageAsText");
    expect(outcome.problem?.message).toContain("Model One");
  });

  it("素材 id 不存在：记为 dropped，内容退回纯文本（绝不假成功）", async () => {
    const prepared = await service.prepareAttachments(prepare(["missing-asset"]));

    const outcome = outcomeOf(prepared.attachments, "missing-asset");
    expect(outcome.deliveredAs).toBe("dropped");
    expect(outcome.section).toBeNull();
    expect(outcome.problem?.messageKey).toBe("notice.attachmentDropped");
    expect(prepared.content).toBe("看看这张图");
  });

  it("文件被手删了：记为 dropped，并给出原因", async () => {
    const ref = await uploadAsset(imageBytes(16));
    await fs.rm(join(assetsDir, `${ref.assetId}.png`));

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    const outcome = outcomeOf(prepared.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("dropped");
    expect((outcome.problem?.detail as { reason?: string }).reason).toContain("ENOENT");
  });

  it("超过一条消息的张数上限：多的那些明确记账", async () => {
    const refs: AssetRef[] = [];
    for (let index = 0; index < MAX_ASSETS_PER_MESSAGE + 2; index += 1) {
      refs.push(await uploadAsset(imageBytes(8 + index)));
    }

    const prepared = await service.prepareAttachments(prepare(refs.map((ref) => ref.assetId)));

    expect(prepared.attachments).toHaveLength(MAX_ASSETS_PER_MESSAGE + 2);
    const deliverable = prepared.attachments.filter((item) => item.deliveredAs !== "dropped");
    expect(deliverable).toHaveLength(MAX_ASSETS_PER_MESSAGE);
    const dropped = prepared.attachments.filter((item) => item.deliveredAs === "dropped");
    expect(dropped).toHaveLength(2);
    expect(dropped[0]?.problem?.messageKey).toBe("attachment.tooMany");
  });

  it("用户输入本来就是分段数组时，素材段接在后面", async () => {
    const ref = await uploadAsset(imageBytes(16));
    const input: AgentNS.MessageContent = [
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ];

    const prepared = await service.prepareAttachments(prepare([ref.assetId], input));

    const content = prepared.content as AgentNS.MessageContentSection[];
    expect(content.map((section) => section.type)).toEqual(["text", "text", "image_url"]);
  });

  it("重复的 assetId 只发一次", async () => {
    const ref = await uploadAsset(imageBytes(16));
    const prepared = await service.prepareAttachments(prepare([ref.assetId, ref.assetId]));
    expect(prepared.attachments).toHaveLength(1);
    expect((prepared.content as AgentNS.MessageContentSection[]).length).toBe(2);
  });

  it("解析模型失败时不炸整轮：按「没有能力信息」继续，超内联上限的那张如实报失败", async () => {
    const failing = new AssetService({
      assets: repo,
      paths,
      resolveModelContext: () => {
        throw new Error("配置读不出来");
      },
    });
    const ref = await uploadAsset(imageBytes(16));

    const prepared = await failing.prepareAttachments(prepare([ref.assetId]));

    const outcome = outcomeOf(prepared.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// 按引用清理（R33：引用归零才删）
// ---------------------------------------------------------------------------

describe("按引用清理", () => {
  it("引用归零：删行 + 删文件，返回删掉的文件路径", async () => {
    const first = await uploadAsset(imageBytes(8));
    const second = await uploadAsset(imageBytes(9));
    await linkToMessage(first.assetId, { messageId: "msg-a" });
    await linkToMessage(second.assetId, { messageId: "msg-b" });
    await db.run("DELETE FROM messages WHERE id = ?", ["msg-a"]);
    await db.run("DELETE FROM messages WHERE id = ?", ["msg-b"]);

    const removed = await service.sweepUnreferenced([first.assetId, second.assetId]);

    expect([...removed].sort()).toEqual(
      [`assets/${first.assetId}.png`, `assets/${second.assetId}.png`].sort(),
    );
    expect(await repo.get(first.assetId)).toBeUndefined();
    expect(await fs.readdir(assetsDir)).toEqual([]);
  });

  it("还有别的会话在引用：行与文件都留下", async () => {
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c2', 'w1', '另一段', 0, 'agent-1', 'm-1', 2, 2)`,
    );
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
       VALUES ('msg-2', 'c2', 1, 'user', 'completed', 0, '"hi"', 'hi', 3, 3)`,
    );
    const ref = await uploadAsset(imageBytes(8));
    await linkToMessage(ref.assetId, { messageId: "msg-1" });
    await linkToMessage(ref.assetId, { messageId: "msg-2", sessionId: "c2" });
    // 删掉第一个会话：它那一行关系跟着走，第二个会话那一行还在
    await db.run("DELETE FROM sessions WHERE id = ?", ["c1"]);

    expect(await service.sweepUnreferenced([ref.assetId])).toEqual([]);
    expect(await repo.get(ref.assetId)).toBeDefined();
    expect(await fs.readdir(assetsDir)).toEqual([`${ref.assetId}.png`]);
    expect(await repo.countSessions(ref.assetId)).toBe(1);
  });

  it("只删文件（行已被级联删掉的场合）", async () => {
    const ref = await uploadAsset(imageBytes(8));
    const relativePath = `assets/${ref.assetId}.png`;

    const removed = await service.removeFiles([relativePath]);

    expect(removed).toEqual([relativePath]);
    expect(await fs.readdir(assetsDir)).toEqual([]);
  });

  it("assets 目录外的路径一概不碰", async () => {
    // 哨兵文件放在数据根下（assets/ 之外）。整个文件共用一个库，所以这里不能拿
    // `ai-zen.db` 当哨兵：写它会盖掉正在用的库文件。库里那份路径仍留在下面那条入参里。
    const outside = join(dir.path, "outside-the-assets-dir.txt");
    await fs.writeFile(outside, "keep me", "utf8");

    const removed = await service.removeFiles(["../ai-zen.db", outside]);

    expect(removed).toEqual([]);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("keep me");
  });

  it("文件已经不在了也不报错（清理要能重复执行）", async () => {
    const removed = await service.removeFiles(["assets/gone.png"]);
    expect(removed).toEqual(["assets/gone.png"]);
  });

  it("认不得的素材 id / 空清单：什么都不做", async () => {
    expect(await service.sweepUnreferenced([])).toEqual([]);
    expect(await service.sweepUnreferenced(["nope"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 全局去重（同一张图只占一份磁盘，可以跨会话）
// ---------------------------------------------------------------------------

describe("全局去重", () => {
  it("同一份字节上传两次：只落一份文件、第二次回既有 assetId", async () => {
    const bytes = imageBytes(48);
    const first = await uploadAsset(bytes);
    const second = await uploadAsset(bytes, { name: "again.png" });

    expect(second.assetId).toBe(first.assetId);
    // 磁盘上只有一份（文件名是第一次那个 assetId）
    expect(await fs.readdir(assetsDir)).toEqual([`${first.assetId}.png`]);
    // 库里那一行留着第一次的名字
    expect((await repo.get(first.assetId))?.name).toBe("photo.png");
  });

  it("两个不同会话上传同一张图：素材一行、磁盘一份、关系两行", async () => {
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c2', 'w1', '另一段', 0, 'agent-1', 'm-1', 2, 2)`,
    );
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
       VALUES ('msg-2', 'c2', 1, 'user', 'completed', 0, '"hi"', 'hi', 3, 3)`,
    );
    const bytes = imageBytes(32);
    const first = await uploadAsset(bytes);
    const second = await uploadAsset(bytes, { sessionId: "c2" });

    // 引用是同一份素材（数据库里只有一行、盘上只有一份）
    expect(second.assetId).toBe(first.assetId);
    expect(await fs.readdir(assetsDir)).toEqual([`${first.assetId}.png`]);

    // 归属靠关系行：每个会话各一行
    await linkToMessage(first.assetId, { messageId: "msg-1" });
    await linkToMessage(second.assetId, { messageId: "msg-2", sessionId: "c2" });
    expect(await repo.listSessionIds(first.assetId)).toEqual(["c1", "c2"]);
    expect(await repo.countSessions(first.assetId)).toBe(2);
  });

  it("findExistingAsset：同摘要 + 同字节才算命中，字节数对不上不算", async () => {
    const bytes = imageBytes(24);
    const ref = await uploadAsset(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");

    const hit = await service.findExistingAsset({ sha256: digest, bytes: bytes.byteLength });
    expect(hit?.assetId).toBe(ref.assetId);

    const miss = await service.findExistingAsset({
      sha256: digest,
      bytes: bytes.byteLength + 1,
    });
    expect(miss).toBeNull();
    expect(await service.findExistingAsset({ sha256: "other", bytes: 24 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 两层缓存：厂商 file_id 的失效与重建
// ---------------------------------------------------------------------------

describe("厂商 file_id 缓存", () => {
  it("换端点：该端点上没有缓存行 → 内联，不往新端点重传", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(20));
    await service.prepareAttachments(prepare([ref.assetId]));
    expect(uploadedFiles).toHaveLength(1);

    // 换一个端点（id 不同）：这个端点上没有这个素材的缓存行，就走内联 base64
    modelContext = {
      model: model(true),
      endpoint: { ...endpoint(true), id: "ep-files-2" },
    };
    const second = await service.prepareAttachments(prepare([ref.assetId]));
    expect(outcomeOf(second.attachments, ref.assetId).deliveredAs).toBe("inline");
    expect(uploadedFiles).toHaveLength(1);
    // 新端点上没有留下缓存行（没传过），老端点那一行原样还在
    expect(await repo.describeVendorFiles(ref.assetId, "ep-files-2")).toEqual({
      onEndpoint: false,
      elsewhere: true,
    });
    expect((await repo.getVendorFile(ref.assetId, "ep-files"))?.vendorFileId).toBe("file-1");
    // 历史数据一个字都没变：素材行还是第一次那一行
    expect(await repo.get(ref.assetId)).toBeDefined();
  });

  it("上传失败仍按既有选路降级：读缓存/写缓存出错都不该让发送失败", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(8));
    const broken: AssetVendorRegistry = {
      getVendorFile: async () => {
        throw new Error("db down");
      },
      upsertVendorFile: async () => {
        throw new Error("db down");
      },
      describeVendorFiles: async () => {
        throw new Error("db down");
      },
    };
    const withBrokenCache = new AssetService({
      assets: repo,
      vendorFiles: broken,
      paths,
      resolveModelContext: () => modelContext,
      toolEnv: {
        upload: async ({ filename }) => {
          uploadedFiles.push(filename);
          return `file-${uploadedFiles.length}`;
        },
      },
      now: () => NOW_MS,
    });

    const prepared = await withBrokenCache.prepareAttachments(prepare([ref.assetId]));
    expect(outcomeOf(prepared.attachments, ref.assetId).deliveredAs).toBe("file_reference");
    expect(uploadedFiles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// `__asset_id` 打上（内容那一份）、剥离（出网前）与还原（发送前）
// ---------------------------------------------------------------------------

describe("__asset_id 两端", () => {
  it("prepareAttachments 只回一份内容：厂商产物与 __asset_id 同在，没有第二个内容字段", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(16));

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    // 只有两格：内容一份、结局一份。`Record<keyof AttachmentPreparation, …>` 是穷举 ——
    // 将来谁再加一格（比如又一形态的「落库内容」），这个字面量当场就编译不过
    const shape: Record<keyof AttachmentPreparation, true> = {
      attachments: true,
      content: true,
    };
    expect(Object.keys(prepared).sort()).toEqual(Object.keys(shape).sort());

    // 这一份既是发给模型的（带着厂商的 `file_id`），也是原样落库的（`__asset_id` 就在同一段上）
    const content = prepared.content as LocalMessageContentSection[];
    expect(content).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "file", file_id: "file-1", __asset_id: ref.assetId },
    ]);
    // 结局里报给客户端的那一段，就是拼进内容的那一段（不是另造一份）
    expect(content[1]).toEqual(outcomeOf(prepared.attachments, ref.assetId).section);
    // 客户端回显靠它认出「这条消息用了哪份素材」
    expect(localAssetIdOf(content[1] as LocalMessageContentSection)).toBe(ref.assetId);
  });

  it("非图片素材也走同一份：`file_id` 与 `__asset_id` 同在那一段上", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(10), { mime: "application/pdf", name: "a.pdf" });

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    expect((prepared.content as LocalMessageContentSection[])[1]).toEqual({
      type: "file",
      file_id: "file-1",
      __asset_id: ref.assetId,
    });
  });

  it("assetIdsOf 从落库内容里认回素材 id（撤回回填用）", () => {
    const content: LocalMessageContentSection[] = [
      { type: "text", text: "看看" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
      { type: "file", filename: "a.pdf", __asset_id: "a2" },
      // 没有扩展字段的段一律不算（不看 url 是什么 scheme）
      { type: "image_url", image_url: { url: "asset://a1" } },
      { type: "image_url", image_url: { url: "https://example.test/x.png" } },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
    ];
    expect(assetIdsOf(content)).toEqual(["a1", "a2"]);
    expect(assetIdsOf("纯文本")).toEqual([]);
  });

  it("resolveHistory：历史里的 __asset_id 换成当前模型能吃的内容段，发出去的那份没有 __ 字段", async () => {
    const ref = await uploadAsset(imageBytes(16));
    const history: AgentNS.Message[] = [
      {
        id: "m1",
        role: "user" as AgentNS.Role,
        content: localSections(
          // 本机字段不只 `__asset_id`：发出去之前全都得没
          { type: "text", text: "这张图", __note: "本地备注" } as LocalMessageContentSection,
          { type: "image_url", image_url: { url: "" }, __asset_id: ref.assetId },
        ),
      },
      { id: "m2", role: "assistant" as AgentNS.Role, content: "看到了" },
    ];

    const resolved = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: history,
    });

    const sections = resolved[0]?.content as AgentNS.MessageContentSection[];
    expect(sections[0]).toEqual({ type: "text", text: "这张图" });
    expect(sections[1]?.type).toBe("image_url");
    const url = (sections[1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // 发出去的那一份里没有任何 `__` 开头的键
    expect(JSON.stringify(sections)).not.toContain("__");
    // 原消息不被就地改写（历史是只读的装载结果）
    expect((history[0]?.content as AgentNS.MessageContentSection[])[1]).toEqual({
      type: "image_url",
      image_url: { url: "" },
      __asset_id: ref.assetId,
    });
    // 没有素材段的消息原样返回
    expect(resolved[1]).toBe(history[1]);
  });

  it("稳定性：同一 (素材, 端点) 连发两轮，替换出来的段逐字节相同", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(24));
    const history: AgentNS.Message[] = [
      {
        id: "m1",
        role: "user" as AgentNS.Role,
        content: localSections({
          type: "image_url",
          image_url: { url: "" },
          __asset_id: ref.assetId,
        }),
      },
    ];

    const first = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: history,
    });
    const second = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: history,
    });

    // Files API：命中持久缓存，两轮拿到同一个 file_id，段逐字节相同
    expect(JSON.stringify(second[0]?.content)).toBe(JSON.stringify(first[0]?.content));
    expect(uploadedFiles).toHaveLength(1);
  });

  it("稳定性：内联（data URL）连发两轮逐字节相同，不重新编码出不同字节", async () => {
    modelContext = { model: model(true), endpoint: endpoint(false) };
    const ref = await uploadAsset(imageBytes(24));
    const history: AgentNS.Message[] = [
      {
        id: "m1",
        role: "user" as AgentNS.Role,
        content: localSections({
          type: "image_url",
          image_url: { url: "" },
          __asset_id: ref.assetId,
        }),
      },
    ];

    const first = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: history,
    });
    const second = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: history,
    });

    const firstUrl = (first[0]?.content as { image_url: { url: string } }[])[0]?.image_url.url;
    const secondUrl = (second[0]?.content as { image_url: { url: string } }[])[0]?.image_url.url;
    expect(secondUrl).toBe(firstUrl);
    expect(JSON.stringify(second[0]?.content)).toBe(JSON.stringify(first[0]?.content));
  });

  it("resolveHistory：换了不看图的模型时，历史里的图退化成文字而不是原样发给厂商", async () => {
    modelContext = { model: model(false), endpoint: endpoint(false) };
    const ref = await uploadAsset(imageBytes(16));

    const resolved = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: [
        {
          id: "m1",
          role: "user" as AgentNS.Role,
          content: localSections({
            type: "image_url",
            image_url: { url: "" },
            __asset_id: ref.assetId,
          }),
        },
      ],
    });

    const sections = resolved[0]?.content as AgentNS.MessageContentSection[];
    expect(sections[0]).toEqual({ type: "text", text: "[Image] photo.png（当前模型看不了图片）" });
    expect(JSON.stringify(sections)).not.toContain("__");
  });

  it("resolveHistory：素材已经不在时给一句文字说明（不把 __asset_id 交给厂商）", async () => {
    const resolved = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: [
        {
          id: "m1",
          role: "user" as AgentNS.Role,
          content: localSections({ type: "image_url", image_url: { url: "" }, __asset_id: "gone" }),
        },
      ],
    });

    const sections = resolved[0]?.content as AgentNS.MessageContentSection[];
    expect(sections[0]?.type).toBe("text");
    expect(JSON.stringify(sections)).not.toContain("__");
    expect(JSON.stringify(sections)).not.toContain(assetsDir);
  });

  it("没有素材引用的历史不碰盘、不上传（只做一遍白名单剥离）", async () => {
    const history: AgentNS.Message[] = [
      { id: "m1", role: "user" as AgentNS.Role, content: "只有文字" },
    ];
    const resolved = await service.resolveHistory({
      sessionId: "c1",
      modelId: "m-1",
      messages: history,
    });

    expect(resolved).toEqual(history);
    expect(uploadedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// asset.get
// ---------------------------------------------------------------------------

describe("getAsset", () => {
  it("两档都能取到字节，且与落盘的那份逐字节一致", async () => {
    const bytes = imageBytes(40);
    const ref = await uploadAsset(bytes);

    for (const variant of ["original", "thumb"] as const) {
      const fetched = await service.getAsset({ assetId: ref.assetId, variant });
      expect(fetched.variant).toBe(variant);
      expect(fetched.asset.assetId).toBe(ref.assetId);
      expect(new Uint8Array(Buffer.from(fetched.data, "base64"))).toEqual(bytes);
    }
  });

  it("不给 variant 时按原图", async () => {
    const ref = await uploadAsset(imageBytes(8));
    expect((await service.getAsset({ assetId: ref.assetId })).variant).toBe("original");
  });

  it("回包里带上传时解出的宽高（客户端拿它摆占位框）", async () => {
    const ref = await uploadAsset(pngBytes(120, 80));

    const fetched = await service.getAsset({ assetId: ref.assetId });

    expect(fetched.asset).toMatchObject({ assetId: ref.assetId, width: 120, height: 80 });
  });

  it("id 不认识：报 not_found（不是 internal）", async () => {
    const error = (await service
      .getAsset({ assetId: "nope" })
      .catch((caught: unknown) => caught)) as HostError;
    expect(HostError.is(error)).toBe(true);
    expect(error.code).toBe("not_found");
  });

  it("行在而文件不在：报 not_found，并说明是文件缺失", async () => {
    const ref = await uploadAsset(imageBytes(8));
    await fs.rm(join(assetsDir, `${ref.assetId}.png`));

    const error = (await service
      .getAsset({ assetId: ref.assetId })
      .catch((caught: unknown) => caught)) as HostError;
    expect(error.code).toBe("not_found");
    expect((error.detail as { reason?: string }).reason).toBe("asset_file_missing");
  });
});
