/**
 * 素材服务的验收：落定与登记、`assetIds` → 内容段（F-H7 / R44）、按引用清理（R33）。
 *
 * 传输方式的选择交给 SDK 的 `fileToContentSection`（本服务不另写一套判定），所以用例里
 * 换成不同的端点/模型组合，验的是「最终走成了哪条路」以及「账有没有如实记」。
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
import {
  AssetService,
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

  it("端点声明 Files API：走文件引用（file_id），不上传两次", async () => {
    modelContext = { model: model(true), endpoint: endpoint(true) };
    const ref = await uploadAsset(imageBytes(16));

    const first = await service.prepareAttachments(prepare([ref.assetId]));
    const outcome = outcomeOf(first.attachments, ref.assetId);
    expect(outcome.deliveredAs).toBe("file_reference");
    expect(outcome.section).toEqual({ type: "file", file_id: "file-1" });
    expect(uploadedFiles).toEqual([`${ref.assetId}.png`]);

    // 第二次取用同一张：SDK 的上传缓存命中，不再上传
    await service.prepareAttachments(prepare([ref.assetId]));
    expect(uploadedFiles).toHaveLength(1);
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
