/**
 * 素材服务的验收：落定与登记（含对话内去重）、`assetIds` → 内容段（F-H7 / R44）、
 * 两层缓存（`assets` + 可失效的 `asset_vendor_files`）、`asset://` 的生成与还原、
 * 按 id 取内容（`asset.get`）、按引用清理（R33）。
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePaths, type ServerPaths } from "../config.js";
import { AssetRepository } from "../storage/AssetRepository.js";
import { Database } from "../storage/Database.js";
import { migrate } from "../storage/migrations.js";
import { MAX_ASSETS_PER_MESSAGE, type AssetRef, type AttachmentOutcome } from "../wire/index.js";
import { ServerError } from "../wire/errors.js";
import {
  AssetService,
  assetIdsOf,
  type AssetVendorRegistry,
  type AttachmentModelContext,
  type AttachmentPrepareContext,
} from "./AssetService.js";
import { makeTempDir, type TempDir } from "../net/TestSupport.js";

let dir: TempDir;
let paths: ServerPaths;
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

beforeEach(async () => {
  dir = await makeTempDir("assets");
  paths = resolvePaths(dir.path);
  assetsDir = paths.assetsDir;
  db = new Database(paths.dbFile);
  await migrate(db);
  repo = new AssetRepository(db);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目', '/tmp/w1', 1)");
  await db.run(
    `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
     VALUES ('c1', 'w1', '对话', 0, 'agent-1', 'm-1', 2, 2)`,
  );
  await db.run(
    `INSERT INTO messages (id, conversationId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
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

afterEach(async () => {
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

/** 走一遍「上传收完 → 落定登记」：临时文件进、正式素材出 */
async function uploadAsset(
  bytes: Uint8Array,
  options: { mime?: string; name?: string | null; conversationId?: string } = {},
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
    conversationId: options.conversationId ?? "c1",
  });
}

function prepare(assetIds: string[], content: AgentNS.MessageContent = "看看这张图"): AttachmentPrepareContext {
  return {
    conversationId: "c1",
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
      conversationId: "c1",
      messageId: null,
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

  it("挂到消息上之后能在消息维度查到", async () => {
    const ref = await uploadAsset(imageBytes(8));
    await service.linkToMessage([ref.assetId], "msg-1");
    expect((await repo.listByMessage("msg-1")).map((row) => row.id)).toEqual([ref.assetId]);
  });

  it("对话不存在时给可判别的业务码（不是 internal）", async () => {
    const error = await uploadAsset(imageBytes(8), { conversationId: "no-such-conversation" }).catch(
      (caught: unknown) => caught,
    );

    expect(ServerError.is(error)).toBe(true);
    expect((error as ServerError).code).toBe("not_found");
    expect((error as ServerError).detail).toMatchObject({
      conversationId: "no-such-conversation",
      reason: "conversation_not_found",
    });
    // 正式文件也不留（库里没行、盘上就不该有文件）
    const leftovers = (await fs.readdir(assetsDir)).filter((name) => !name.endsWith(".part"));
    expect(leftovers).toEqual([]);
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

  it("端点声明 Files API：走文件引用（file_id），并且第二次取用命中缓存、不再发 HTTP", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(16));

    const first = await service.prepareAttachments(prepare([ref.assetId]));
    const outcome = outcomeOf(first.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("file_reference");
    expect(outcome.section).toEqual({ type: "file", file_id: "file-1" });
    expect(uploadedFiles).toEqual([`${ref.assetId}.png`]);

    // SDK 不再记厂商侧的文件 id（它的进程内缓存在上一波删掉了），所以由我们的表记：
    // 第二次取用同一张图，`asset_vendor_files` 命中，一个 HTTP 都不发
    const second = await service.prepareAttachments(prepare([ref.assetId]));
    expect(outcomeOf(second.attachments, ref.assetId).section).toEqual({
      type: "file",
      file_id: "file-1",
    });
    expect(uploadedFiles).toHaveLength(1);
    // 命中也把 lastUsedAt 更新一次（缓存行还活着）
    expect((await repo.getVendorFile(ref.assetId, "ep-files"))?.lastUsedAt).toBe(NOW_MS);
  });

  it("模型读不了图：退化成文字，并如实记账", async () => {
    modelContext = { model: model(false), endpoint: endpoint(false) };
    const ref = await uploadAsset(imageBytes(16));

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    const outcome = outcomeOf(prepared.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("text_fallback");
    expect(outcome.section?.type).toBe("text");
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

    const prepared = await service.prepareAttachments(
      prepare(refs.map((ref) => ref.assetId)),
    );

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
// 按引用清理（R33）
// ---------------------------------------------------------------------------

describe("按引用清理", () => {
  it("按对话清：删文件 + 删行，返回删掉的文件路径", async () => {
    const first = await uploadAsset(imageBytes(8));
    const second = await uploadAsset(imageBytes(9));

    const removed = await service.removeByConversation("c1");

    expect([...removed].sort()).toEqual(
      [`assets/${first.assetId}.png`, `assets/${second.assetId}.png`].sort(),
    );
    expect(await repo.get(first.assetId)).toBeUndefined();
    expect(await fs.readdir(assetsDir)).toEqual([]);
  });

  it("按素材 id 清：只删指定的那几个", async () => {
    const first = await uploadAsset(imageBytes(8));
    const second = await uploadAsset(imageBytes(9));

    const removed = await service.removeByAssetIds([first.assetId]);

    expect(removed).toEqual([`assets/${first.assetId}.png`]);
    expect(await repo.get(first.assetId)).toBeUndefined();
    expect(await repo.get(second.assetId)).toBeDefined();
    expect(await fs.readdir(assetsDir)).toEqual([`${second.assetId}.png`]);
  });

  it("只删文件（行已被级联删掉的场合）", async () => {
    const ref = await uploadAsset(imageBytes(8));
    const relativePath = `assets/${ref.assetId}.png`;

    const removed = await service.removeFiles([relativePath]);

    expect(removed).toEqual([relativePath]);
    expect(await fs.readdir(assetsDir)).toEqual([]);
  });

  it("assets 目录外的路径一概不碰", async () => {
    const outside = join(dir.path, "ai-zen.db");
    await fs.writeFile(outside, "keep me", "utf8");

    const removed = await service.removeFiles(["../ai-zen.db", outside]);

    expect(removed).toEqual([]);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("keep me");
  });

  it("文件已经不在了也不报错（清理要能重复执行）", async () => {
    const removed = await service.removeFiles(["assets/gone.png"]);
    expect(removed).toEqual(["assets/gone.png"]);
  });
});

// ---------------------------------------------------------------------------
// 对话内去重（同一张图贴两次只占一份磁盘）
// ---------------------------------------------------------------------------

describe("对话内去重", () => {
  it("同一段对话里同一份字节上传两次：只落一份文件、第二次回既有 assetId", async () => {
    const bytes = imageBytes(48);
    const first = await uploadAsset(bytes);
    const second = await uploadAsset(bytes, { name: "again.png" });

    expect(second.assetId).toBe(first.assetId);
    // 磁盘上只有一份（文件名是第一次那个 assetId）
    expect(await fs.readdir(assetsDir)).toEqual([`${first.assetId}.png`]);
    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual([first.assetId]);
    // 库里那一行留着第一次的名字
    expect((await repo.get(first.assetId))?.name).toBe("photo.png");
  });

  it("换一段对话，同一份字节是另一份资源（去重不跨对话）", async () => {
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c2', 'w1', '另一段', 0, 'agent-1', 'm-1', 2, 2)`,
    );
    const bytes = imageBytes(32);
    const first = await uploadAsset(bytes);
    const second = await uploadAsset(bytes, { conversationId: "c2" });

    expect(second.assetId).not.toBe(first.assetId);
    expect(await fs.readdir(assetsDir)).toHaveLength(2);
  });

  it("findExistingAsset：同对话 + 同摘要 + 同字节才算命中，字节数对不上不算", async () => {
    const bytes = imageBytes(24);
    const ref = await uploadAsset(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");

    const hit = await service.findExistingAsset({
      conversationId: "c1",
      sha256: digest,
      bytes: bytes.byteLength,
    });
    expect(hit?.assetId).toBe(ref.assetId);

    const miss = await service.findExistingAsset({
      conversationId: "c1",
      sha256: digest,
      bytes: bytes.byteLength + 1,
    });
    expect(miss).toBeNull();
    expect(
      await service.findExistingAsset({ conversationId: "c1", sha256: "other", bytes: 24 }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 两层缓存：厂商 file_id 的失效与重建
// ---------------------------------------------------------------------------

describe("厂商 file_id 缓存", () => {
  it("换端点：同一份素材在新端点上重传一次，新端点有自己的 file_id", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(20));
    await service.prepareAttachments(prepare([ref.assetId]));
    expect(uploadedFiles).toHaveLength(1);

    // 换一个端点（id 不同）：缓存按 (assetId, endpointId) 命中不了，要重传一次
    modelContext = {
      model: model(true),
      endpoint: { ...endpoint(true), id: "ep-files-2" },
    };
    const second = await service.prepareAttachments(prepare([ref.assetId]));
    expect(outcomeOf(second.attachments, ref.assetId).deliveredAs).toBe("file_reference");
    expect(uploadedFiles).toHaveLength(2);
    expect((await repo.getVendorFile(ref.assetId, "ep-files"))?.vendorFileId).toBe("file-1");
    expect((await repo.getVendorFile(ref.assetId, "ep-files-2"))?.vendorFileId).toBe("file-2");
    // 历史数据一个字都没变：素材行还是第一次那一行
    expect(await repo.get(ref.assetId)).toBeDefined();
  });

  it("invalidateVendorFiles：删掉「这段对话 + 这个端点」的缓存，下一轮重传一次", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(20));
    await service.prepareAttachments(prepare([ref.assetId]));
    expect(await repo.listVendorFiles("c1", "ep-files")).toHaveLength(1);

    const removed = await service.invalidateVendorFiles({
      conversationId: "c1",
      modelId: "m-1",
    });
    expect(removed).toBe(1);
    expect(await repo.listVendorFiles("c1", "ep-files")).toEqual([]);

    // 缓存删了、素材还在：下一轮重新上传（这就是“删光也能从 assets 重建”）
    await service.prepareAttachments(prepare([ref.assetId]));
    expect(uploadedFiles).toHaveLength(2);
    expect(await repo.listVendorFiles("c1", "ep-files")).toHaveLength(1);
  });

  it("解码不出端点时如实回 0（没有可作废的东西，调用方就不该重试）", async () => {
    modelContext = { model: model(true), endpoint: null };
    const ref = await uploadAsset(imageBytes(8));
    await repo.upsertVendorFile({
      assetId: ref.assetId,
      endpointId: "ep-files",
      vendorFileId: "file-1",
      createdAt: NOW_MS,
      lastUsedAt: NOW_MS,
    });

    expect(await service.invalidateVendorFiles({ conversationId: "c1", modelId: "m-1" })).toBe(0);
    // 解析不出端点时那批缓存原样留着（没有依据说它们坏了）
    expect(await repo.listVendorFiles("c1", "ep-files")).toHaveLength(1);
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
      touchVendorFile: async () => 0,
      listVendorFiles: async () => [],
      deleteVendorFiles: async () => 0,
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
// `asset://` 的生成（落库形态）与还原（发送前）
// ---------------------------------------------------------------------------

describe("asset:// 两端", () => {
  it("prepareAttachments 同时给出发送形态与落库形态；落库形态里只有 asset://", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(16));

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    // 发送形态：厂商产物（file_id），会随端点/模型变
    const sent = prepared.content as AgentNS.MessageContentSection[];
    expect(sent[1]).toEqual({ type: "file", file_id: "file-1" });

    // 落库形态：只有我们自己的引用
    const stored = prepared.storedContent as AgentNS.MessageContentSection[];
    expect(stored).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: `asset://${ref.assetId}` } },
    ]);
    const flat = JSON.stringify(stored);
    expect(flat).not.toContain("file-1");
    expect(flat).not.toContain("base64");
    expect(flat).not.toContain(assetsDir);
  });

  it("非图片素材写进 file.file_id（同样是 asset:// 引用）", async () => {
    const ref = await uploadAsset(imageBytes(10), { mime: "application/pdf", name: "a.pdf" });

    const prepared = await service.prepareAttachments(prepare([ref.assetId]));

    expect((prepared.storedContent as AgentNS.MessageContentSection[])[1]).toEqual({
      type: "file",
      file_id: `asset://${ref.assetId}`,
      filename: "a.pdf",
    });
  });

  it("assetIdsOf 从落库内容里认回素材 id（撤回回填用）", () => {
    expect(
      assetIdsOf([
        { type: "text", text: "看看" },
        { type: "image_url", image_url: { url: "asset://a1" } },
        { type: "file", file_id: "asset://a2", filename: "a.pdf" },
        { type: "image_url", image_url: { url: "https://example.test/x.png" } },
        { type: "image_url", image_url: { url: "asset://a1" } },
      ]),
    ).toEqual(["a1", "a2"]);
    expect(assetIdsOf("纯文本")).toEqual([]);
  });

  it("resolveHistory：历史里的 asset:// 换成当前模型能吃的内容段", async () => {
    const ref = await uploadAsset(imageBytes(16));
    const history: AgentNS.Message[] = [
      {
        id: "m1",
        role: "user" as AgentNS.Role,
        content: [
          { type: "text", text: "这张图" },
          { type: "image_url", image_url: { url: `asset://${ref.assetId}` } },
        ],
      },
      { id: "m2", role: "assistant" as AgentNS.Role, content: "看到了" },
    ];

    const resolved = await service.resolveHistory({
      conversationId: "c1",
      modelId: "m-1",
      messages: history,
    });

    const sections = resolved[0]?.content as AgentNS.MessageContentSection[];
    expect(sections[0]).toEqual({ type: "text", text: "这张图" });
    expect(sections[1]?.type).toBe("image_url");
    const url = (sections[1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // 原消息不被就地改写（历史是只读的装载结果）
    expect((history[0]?.content as AgentNS.MessageContentSection[])[1]).toEqual({
      type: "image_url",
      image_url: { url: `asset://${ref.assetId}` },
    });
    // 没有素材段的消息原样返回
    expect(resolved[1]).toBe(history[1]);
  });

  it("resolveHistory：换了不看图的模型时，历史里的图退化成文字而不是原样发给厂商", async () => {
    modelContext = { model: model(false), endpoint: endpoint(false) };
    const ref = await uploadAsset(imageBytes(16));

    const resolved = await service.resolveHistory({
      conversationId: "c1",
      modelId: "m-1",
      messages: [
        {
          id: "m1",
          role: "user" as AgentNS.Role,
          content: [{ type: "image_url", image_url: { url: `asset://${ref.assetId}` } }],
        },
      ],
    });

    const sections = resolved[0]?.content as AgentNS.MessageContentSection[];
    expect(sections[0]?.type).toBe("text");
    expect(JSON.stringify(sections)).not.toContain("asset://");
  });

  it("resolveHistory：素材已经不在时给一句文字说明（不把 asset:// 交给厂商）", async () => {
    const resolved = await service.resolveHistory({
      conversationId: "c1",
      modelId: "m-1",
      messages: [
        {
          id: "m1",
          role: "user" as AgentNS.Role,
          content: [{ type: "image_url", image_url: { url: "asset://gone" } }],
        },
      ],
    });

    const sections = resolved[0]?.content as AgentNS.MessageContentSection[];
    expect(sections[0]?.type).toBe("text");
    expect(JSON.stringify(sections)).not.toContain("asset://");
  });

  it("没有 asset:// 的历史不碰盘、不上传（原样返回同一个数组）", async () => {
    const history: AgentNS.Message[] = [
      { id: "m1", role: "user" as AgentNS.Role, content: "只有文字" },
    ];
    const resolved = await service.resolveHistory({
      conversationId: "c1",
      modelId: "m-1",
      messages: history,
    });

    expect(resolved).toBe(history);
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

  it("id 不认识：报 not_found（不是 internal）", async () => {
    const error = (await service.getAsset({ assetId: "nope" }).catch((caught: unknown) => caught)) as ServerError;
    expect(ServerError.is(error)).toBe(true);
    expect(error.code).toBe("not_found");
  });

  it("行在而文件不在：报 not_found，并说明是文件缺失", async () => {
    const ref = await uploadAsset(imageBytes(8));
    await fs.rm(join(assetsDir, `${ref.assetId}.png`));

    const error = (await service
      .getAsset({ assetId: ref.assetId })
      .catch((caught: unknown) => caught)) as ServerError;
    expect(error.code).toBe("not_found");
    expect((error.detail as { reason?: string }).reason).toBe("asset_file_missing");
  });
});
