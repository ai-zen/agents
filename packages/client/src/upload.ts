/**
 * 上传一个素材（图片）—— 宿主三段式的**客户端那一半**（PRD D5 / F-H8 / A11）。
 *
 * ## 三段式（可能只有一段）
 *
 * ```
 * asset.begin { purpose, mime, bytes, name?, sha256, sessionId }
 *   → { deduped: false, uploadId, maxBytes, receivedBytes, asset: null }   新上传，接着发字节
 *   → { deduped: true,  uploadId: null, ...,           asset: AssetRef }  已经有了，到此为止
 * 若干二进制帧（见 chunkFrame.ts）                              → 没有回执，按 uploadId 落盘
 * asset.end   { uploadId, sha256 }                              → { asset: AssetRef }
 * ```
 *
 * `sha256` 一开始就带上：宿主用它判断「库里是不是已经有这份字节了」，命中时一个字节
 * 都不用传（下面会直接返回既有引用）。同一张图贴两次因此只占一份磁盘、一次上行。
 * 去重按内容摘要做，不区分会话：另一段会话传过的同一张图也算命中，两段会话各自在宿主的
 * 关系表里留一行引用。
 *
 * 为什么字节不走 JSON-RPC 而走二进制帧：分片是任意二进制，base64 进 JSON 会平白多出三分之一体积，
 * 宿主还得先解一层编码；而「这条连接上的二进制帧 = 上传分片」是唯一的含义，不需要再包 `id`。
 *
 * ## 本地先把能拒的都拒掉
 *
 * 单张超过上限、附件张数超过上限、空文件、认不出类型 —— 这四件事在本地就能判，不必把 20MB 传
 * 上去再让 `asset.begin` 回一句不行（PRD D5 的口径也是「在 begin 就拒」）。上限**取值优先看握手**
 * （`host.hello` 的 `limits`）：宿主的数字才是那个真的会拒人的数字；拿不到握手结果时才用与
 * D5 一致的缺省值，两者都写在下面的常量里。
 *
 * ## 一段会话的归属
 *
 * `asset.begin` 要 `sessionId`（宿主要确认这段会话存在、并在消息落库时把引用记到它名下）：
 * 没有归属的上传只会在 `assets/` 里留下一个没人认领的文件。所以上传必须发生在**已经有一段会话**
 * 之后 —— 调用方手里得有 `sessionId`（草稿会话在 `asset.begin` 那一步由宿主落库）。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";

import type { AssetRef } from "@ai-zen/agents-host";

import { encodeChunkFrame } from "./chunkFrame.js";
import { ClientError, localError } from "./errors.js";
import type { ContractCaller } from "./client.js";

/** 单张附件的缺省上限：与 PRD D5 一致（20MB/张） */
export const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** 一条消息的附件数缺省上限：与 PRD D5 一致（4 张/条） */
export const DEFAULT_MAX_ASSETS_PER_MESSAGE = 4;

/**
 * 一片多大。
 *
 * 64KB 是「一帧的头部开销可以忽略」与「写出去的次数不至于太多」之间的折中：20MB 的文件分成
 * 320 帧，每帧的 JSON 头不到 60 字节。
 */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * 上传只需要两件事：能调契约方法、能写二进制帧。
 *
 * `Client` 结构上满足它；用例也可以给一个替身，于是上传的这段流程不必起真 socket 就能测。
 * `hello` / `language` 都是可缺的：缺了就用缺省上限、英文文案（与 D8 的兜底同口径）。
 */
export interface UploadTransport extends ContractCaller {
  /** 写一个二进制帧（`Client.sendBinary`；底层要 `ArrayBuffer` 支撑的视图） */
  sendBinary(frame: Uint8Array<ArrayBuffer>): Promise<void>;
  /** 握手结果里的 `limits`（宿主真正的上限）；没握手时为空 */
  readonly hello?: { limits?: { maxAssetBytes?: number; maxAssetsPerMessage?: number } } | null;
  /** 这条连接的语言（本地告警文案用它，与宿主文案的口径一致） */
  readonly language?: string;
}

/**
 * 一份要上传的内容：本地文件，或者已在内存里的字节。
 *
 * 两条来源都要，因为两个前端的起点不同：桌面端拖进来的是文件路径，CLI 的剪贴板图片是一段
 * base64（PRD F-H6：剪贴板是本机能力，读到的就是字节），两者都先落成字节再走同一条上传路径。
 */
export type AssetSource =
  | {
      /** 本地文件路径 */
      path: string;
      /** MIME 类型；缺省按扩展名认（见 `mimeOfPath`） */
      mime?: string;
      /** 原始文件名；缺省取路径的 basename */
      name?: string;
    }
  | {
      /** 已在内存里的字节 */
      data: Uint8Array;
      /** MIME 类型（内存里的字节没有名字可猜，必须给） */
      mime: string;
      name?: string;
    };

/** `uploadAsset` 的入参：一段会话 + 一份内容（文件路径或字节）+ 可选分片大小 */
export type UploadAssetOptions = {
  /** 这段素材归属哪段会话（`asset.begin` 必填） */
  sessionId: string;
  /** 每片多少字节，缺省 {@link DEFAULT_CHUNK_SIZE} */
  chunkSize?: number;
} & (
  | { path: string; mime?: string; name?: string }
  | { data: Uint8Array; mime: string; name?: string }
);

/** `uploadAssets` 的入参：一次给多份内容（一次拖进几张图就是几条） */
export interface UploadAssetsOptions {
  sessionId: string;
  sources: readonly AssetSource[];
  chunkSize?: number;
}

/** 一份内容没上传成：它排第几（0 起）、叫什么、为什么 */
export interface AssetFailure {
  /** 在 `sources` 里的下标（调用方据此说「第几张」） */
  index: number;
  /** 文件名字（拿不到名字时为空） */
  name: string | null;
  /** 失败原因；张数超限时它的码是 `asset_count_exceeded` */
  error: ClientError;
}

/** 一批内容的上传结果：成了的那些 + 没成的那些（**一条都不静默丢**） */
export interface UploadAssetsResult {
  /** 上传成功的引用，顺序即 `sources` 里成功的那些的顺序 */
  assets: AssetRef[];
  /** 没上传成/没地方放的，逐条带原因 */
  failures: AssetFailure[];
}

/**
 * 上传一份内容，回宿主给的素材引用。
 *
 * 顺序是有意的：先算上限与摘要（本地能判的错在这里就抛），再 `asset.begin`（宿主的拒也在这里
 * 到达，而且它拒的时候一个字节都还没传）—— 如果宿主说“这段会话里已经有了”（`deduped`），
 * 这一步就把既有引用返回，不发帧、不调 `asset.end`；否则分片，最后 `asset.end` 由宿主复核
 * 长度与摘要。
 */
export async function uploadAsset(
  client: UploadTransport,
  options: UploadAssetOptions,
): Promise<AssetRef> {
  const limits = limitsOf(client);
  const chunkSize = resolveChunkSize(options.chunkSize);
  const language = client.language;
  const loaded = await loadSource(options, limits.maxAssetBytes, language);

  // 客户端本来就要算一次摘要（`asset.end` 要用）；顺手在 `begin` 就交上去，让宿主能提前去重
  const digest = createHash("sha256").update(loaded.bytes).digest("hex");

  const began = await client.call("asset.begin", {
    purpose: "message_image",
    mime: loaded.mime,
    bytes: loaded.bytes.byteLength,
    ...(loaded.name === null ? {} : { name: loaded.name }),
    sha256: digest,
    sessionId: options.sessionId,
  });

  // 命中去重：宿主已经有这份字节，回的是既有引用（客户端一个帧也不欠）
  if (began.deduped) {
    if (began.asset === null) {
      throw localError("unexpected", {
        params: { reason: "asset.begin 说已有素材，却没给引用" },
        detail: { assetId: null, reason: "deduped_without_asset" },
      });
    }
    return began.asset;
  }

  const uploadId = began.uploadId;
  if (uploadId === null) {
    throw localError("unexpected", {
      params: { reason: "asset.begin 既没说已有素材，也没给上传句柄" },
      detail: { reason: "missing_upload_id" },
    });
  }

  // 宿主这一刻的上限可能比本地缺省值更小（部署方调过），以它为准而不是以我们猜的为准
  if (loaded.bytes.byteLength > began.maxBytes) {
    throw tooLarge(loaded.bytes.byteLength, began.maxBytes, language);
  }

  for (let offset = 0; offset < loaded.bytes.byteLength; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, loaded.bytes.byteLength);
    await client.sendBinary(encodeChunkFrame(uploadId, loaded.bytes.subarray(offset, end)));
  }

  // 分片没有回执：长度与摘要的校验全在 `asset.end`。它过了，字节就真的落成了素材
  const { asset } = await client.call("asset.end", { uploadId, sha256: digest });
  return asset;
}

/**
 * 一次上传多份内容。
 *
 * 三件必须说清的事：
 *
 *   1. **张数上限在本地就判**（D5：4 张/条）。超出的那些不退化成「悄悄扔掉」，而是逐个进
 *      `failures`（`asset_count_exceeded`）—— 调用方需要能逐张说一句人话。前 `limit` 张照常上传：
 *      宿主 `prepareAttachments` 的口径也是「取前 N 张 + 逐条报告超出的」。
 *   2. **一份失败不连累其它份**：某一张读取失败/宿主拒了，它进 `failures`，剩下的继续。
 *      这比整批抛出去更接近用户想要的结果（「四张里有一张不行」不该等于「这一次什么都不发」）。
 *   3. 顺序串行：一次拖进来的几张图一块发，并发写同一条 socket 反而是给宿主的接收链排队。
 */
export async function uploadAssets(
  client: UploadTransport,
  options: UploadAssetsOptions,
): Promise<UploadAssetsResult> {
  const limits = limitsOf(client);
  const language = client.language;
  const assets: AssetRef[] = [];
  const failures: AssetFailure[] = [];

  for (const [index, source] of options.sources.entries()) {
    const name = nameOf(source);
    if (index >= limits.maxAssetsPerMessage) {
      failures.push({
        index,
        name,
        error: localError("asset_count_exceeded", {
          language,
          params: { limit: limits.maxAssetsPerMessage },
        }),
      });
      continue;
    }
    try {
      assets.push(await uploadAsset(client, perSource(source, options)));
    } catch (error) {
      failures.push({ index, name, error: asClientError(error) });
    }
  }

  return { assets, failures };
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/** 一份内容的字节 + 类型 + 名字（校验过、可以直接进 `asset.begin`） */
interface LoadedSource {
  bytes: Uint8Array;
  mime: string;
  name: string | null;
}

/**
 * 读出要上传的字节，顺带把「读不到 / 空的 / 认不出类型 / 太大」这四种本地能判的错抛掉。
 *
 * 文件那条路先 `stat` 再读：超限时不该把一整个 100MB 的文件读进内存才说不行。
 */
async function loadSource(
  source: UploadAssetOptions,
  maxBytes: number,
  language: string | undefined,
): Promise<LoadedSource> {
  if ("path" in source) {
    const path = source.path;
    let size: number;
    try {
      size = (await fs.stat(path)).size;
    } catch (error) {
      throw localError("asset_unreadable", {
        language,
        params: { path, reason: reasonOf(error) },
        detail: { path, reason: reasonOf(error) },
      });
    }
    if (size > maxBytes) throw tooLarge(size, maxBytes, language);
    if (size === 0) {
      throw localError("asset_empty", {
        language,
        params: { name: source.name ?? basename(path) },
      });
    }

    const bytes = await fs.readFile(path).catch((error: unknown) => {
      throw localError("asset_unreadable", {
        language,
        params: { path, reason: reasonOf(error) },
        detail: { path, reason: reasonOf(error) },
      });
    });
    // 先 stat 后读：这两步之间文件可能被换掉（或长胖），以真正读到的字节为准再判一次
    if (bytes.byteLength > maxBytes) throw tooLarge(bytes.byteLength, maxBytes, language);

    const name = source.name ?? basename(path);
    const mime = source.mime ?? mimeOfPath(path);
    if (mime === null) {
      throw localError("asset_mime_unknown", { language, params: { name } });
    }
    return { bytes, mime: normalizeMime(mime), name };
  }

  const bytes = source.data;
  if (bytes.byteLength > maxBytes) throw tooLarge(bytes.byteLength, maxBytes, language);
  if (bytes.byteLength === 0) {
    throw localError("asset_empty", {
      language,
      params: { name: source.name ?? "(data)" },
    });
  }
  return {
    bytes,
    mime: normalizeMime(source.mime),
    name: source.name ?? null,
  };
}

/** 一个 `AssetSource` → 一次上传的入参 */
function perSource(source: AssetSource, options: UploadAssetsOptions): UploadAssetOptions {
  const chunk = options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize };
  if ("path" in source) {
    return {
      sessionId: options.sessionId,
      path: source.path,
      ...(source.mime === undefined ? {} : { mime: source.mime }),
      ...(source.name === undefined ? {} : { name: source.name }),
      ...chunk,
    };
  }
  return {
    sessionId: options.sessionId,
    data: source.data,
    mime: source.mime,
    ...(source.name === undefined ? {} : { name: source.name }),
    ...chunk,
  };
}

/** 上限从握手结果里取；握手没给（或给得不合理）时回落到 D5 的缺省值 */
function limitsOf(client: UploadTransport): {
  maxAssetBytes: number;
  maxAssetsPerMessage: number;
} {
  const limits = client.hello?.limits;
  return {
    maxAssetBytes: positiveOr(limits?.maxAssetBytes, DEFAULT_MAX_ASSET_BYTES),
    maxAssetsPerMessage: positiveOr(limits?.maxAssetsPerMessage, DEFAULT_MAX_ASSETS_PER_MESSAGE),
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 分片大小：必须是正整数，否则是调用方的程序错误（不是用户能犯的错） */
function resolveChunkSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(value) || value <= 0) {
    throw localError("unexpected", { params: { reason: `chunkSize 必须是正整数：${value}` } });
  }
  return value;
}

function tooLarge(bytes: number, limit: number, language: string | undefined): ClientError {
  return localError("asset_too_large", {
    language,
    params: { size: formatBytes(bytes), limit: formatBytes(limit) },
    detail: { bytes, limit },
  });
}

/**
 * 扩展名 → MIME。只认图片：`asset.begin` 的 `purpose` 目前只有「消息里的图片」这一种（D5），
 * 猜不出来的就让调用方显式给 `mime`，不在这里按内容嗅探。
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** 按扩展名认类型；认不出返回 `null`（调用方据此要求显式 mime） */
export function mimeOfPath(path: string): string | null {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

/** 与宿主 `UploadReceiver` 同口径：去空白、小写 */
function normalizeMime(mime: string): string {
  return mime.trim().toLowerCase();
}

/** 这份内容叫做什么（报告里说「第几张、哪个文件」用） */
function nameOf(source: AssetSource): string | null {
  return "path" in source ? (source.name ?? basename(source.path)) : (source.name ?? null);
}

/** 任意抛出物收敛成 `ClientError`（原始信息进 `detail.reason`，不猜原因） */
function asClientError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return localError("unexpected", { params: { reason }, detail: { reason } });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 字节数的人话形式（本地告警里的 `{size}` / `{limit}`）。
 *
 * 与宿主 `formatBytes` 同口径：1024 进制、最多一位小数（`20 MB`、`8.5 MB`、`512 KB`）。
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
