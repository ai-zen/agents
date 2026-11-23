/**
 * Asset 的两件事：把一份字节传上去（`asset.upload`）、按 id 把字节取回来（`asset.get`）。
 *
 * ## 判断都在宿主那一侧
 *
 * 一张 20MB 的上限、一条消息几张 Asset、内容段上的 `__asset_id` 怎么重建 —— 全是宿主的（后者在
 * SDK 的 `AssetTransportPlugin` 里）。客户端这一层只做「把本地文件读成字节」和「把字节交上去」
 * 这两步：同一个上限在两处各判一次，第二处迟早与第一处不一样，而用户看到的是第二处那个数。
 *
 * ## 取回：为什么按 id 就够
 *
 * 消息里存的是段上的本地扩展字段 `__asset_id`（厂商的 `file_id`、base64、绝对路径都不进库），
 * 所以任何一段历史里的图，客户端都要能按 id 把字节取回来自己显示：换模型、换设备、重启之后都
 * 是同一条路。判断「这一段要不要去取」只看有没有那个字段，不解析 url scheme（见
 * {@link localAssetIdOf}）。
 *
 * ## 形状
 *
 * 两条 procedure 都走同一条 ws 上的 JSON：上行给 base64、下行回 base64。内容本身就是原子的，
 * 不需要为下载另开一条二进制通道，代价是多三分之一体积。
 */

import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";

import type { TRPCClient } from "@trpc/client";
import type { AgentNS } from "@ai-zen/agents-core";
import type { AppRouter, AssetRecord } from "@ai-zen/agents-host";

import { ClientError, fromTRPCError, localError } from "./errors.js";

/** 「能调契约」这一件事：`HostClient` 结构上满足它，用例也可以给一个替身 */
export interface ContractCaller {
  readonly api: TRPCClient<AppRouter>;
}

/**
 * 一份要上传的内容：本地文件，或者已在内存里的字节。
 *
 * 两条来源都要，因为两个前端的起点不同：桌面端拖进来的是文件路径，CLI 的剪贴板图片是一段字节，
 * 两者都先落成字节再走同一条上传路径。
 */
export type AssetSource =
  | {
      /** 本地文件路径 */
      path: string;
      /** MIME 类型；缺省按扩展名认（见 {@link mimeOfPath}） */
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

/** 一份内容没上传成：它排第几（0 起）、叫什么、为什么 */
export interface AssetFailure {
  /** 在 `sources` 里的下标（调用方据此说「第几张」） */
  index: number;
  /** 文件名字（拿不到名字时为空） */
  name: string | null;
  /** 失败原因：宿主说的话原样在 `message` 与 `code` 上 */
  error: ClientError;
}

/** 一批内容的上传结果：成了的那些 + 没成的那些（一条都不静默丢） */
export interface UploadAssetsResult {
  /** 上传成功的 Asset 行，顺序即 `sources` 里成功的那些的顺序 */
  assets: AssetRecord[];
  /** 没上传成的，逐条带原因 */
  failures: AssetFailure[];
}

/** 取回来的一份 Asset：类型与字节 */
export interface AssetContent {
  mime: string;
  /** 解好码的字节 */
  bytes: Uint8Array;
}

/** 上传一份内容，回宿主给的 Asset 行。超限、类型不对之类的判断全在宿主那一侧 */
export async function uploadAsset(
  client: ContractCaller,
  source: AssetSource,
): Promise<AssetRecord> {
  const loaded = await load(source);
  try {
    const { asset } = await client.api.asset.upload.mutate({
      base64: Buffer.from(loaded.bytes).toString("base64"),
      mime: loaded.mime,
      name: loaded.name,
    });
    return asset;
  } catch (error) {
    throw fromTRPCError(error);
  }
}

/**
 * 一次上传多份内容。
 *
 * 一份失败不连累其它份：某一张读不出来、宿主拒了，它进 `failures`，剩下的继续 —— 「四张里有
 * 一张不行」不该等于「这一次什么都不发」。顺序串行：一次拖进来的几张图一块发，并发写同一条
 * socket 只是给对端的接收链排队。
 */
export async function uploadAssets(
  client: ContractCaller,
  sources: readonly AssetSource[],
): Promise<UploadAssetsResult> {
  const assets: AssetRecord[] = [];
  const failures: AssetFailure[] = [];

  for (const [index, source] of sources.entries()) {
    try {
      assets.push(await uploadAsset(client, source));
    } catch (error) {
      failures.push({
        index,
        name: nameOf(source),
        error: error instanceof ClientError ? error : fromTRPCError(error),
      });
    }
  }

  return { assets, failures };
}

/**
 * 按 Asset id 取回内容。
 *
 * 宿主找不到这个 id（或行在而文件不在）时报 `not_found`，错误原样往上抛：这一层不猜原因。
 */
export async function getAsset(
  client: ContractCaller,
  options: { assetId: string },
): Promise<AssetContent> {
  try {
    const { mime, base64 } = await client.api.asset.get.query({ assetId: options.assetId });
    return { mime, bytes: new Uint8Array(Buffer.from(base64, "base64")) };
  } catch (error) {
    throw fromTRPCError(error);
  }
}

/**
 * 一个内容段引用的 Asset id（没有这个扩展字段就是 `null`）。
 *
 * 与宿主那份判断同口径：看的是字段在不在，不是 url 长什么样。空串 / 空白算没写。
 */
export function localAssetIdOf(section: AgentNS.MessageContentSection): string | null {
  // `__asset_id` 不在 `MessageContentSection` 的类型里：它是本机的扩展键，落库那份原样带着它，
  // 出网那份由 core 的字段白名单剥掉
  const value = (section as { __asset_id?: unknown }).__asset_id;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 一份内容读出来的三样 */
interface Loaded {
  bytes: Uint8Array;
  mime: string;
  name: string | null;
}

/** 读出要上传的字节。文件那条路只认「读得出来 / 读不出来」，体积与张数由宿主判 */
async function load(source: AssetSource): Promise<Loaded> {
  if (!("path" in source)) {
    return { bytes: source.data, mime: normalizeMime(source.mime), name: source.name ?? null };
  }

  const path = source.path;
  const bytes = await fs.readFile(path).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw localError("asset_unreadable", { params: { path, reason }, detail: { path, reason } });
  });
  return {
    bytes: new Uint8Array(bytes),
    mime: normalizeMime(source.mime ?? mimeOfPath(path) ?? UNKNOWN_MIME),
    name: source.name ?? basename(path),
  };
}

/** 认不出类型时交给宿主的那个值：不猜，也不拒绝上传（字节本身是好的） */
const UNKNOWN_MIME = "application/octet-stream";

/** 扩展名 → MIME。只认图片；猜不出来的让调用方显式给 `mime`，不按内容嗅探 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** 按扩展名认类型；认不出来返回 `null` */
export function mimeOfPath(path: string): string | null {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

/** 去空白、小写（与宿主落库那份同口径） */
function normalizeMime(mime: string): string {
  return mime.trim().toLowerCase();
}

/** 这份内容叫做什么（报告里说「第几张、哪个文件」用） */
function nameOf(source: AssetSource): string | null {
  return "path" in source ? (source.name ?? basename(source.path)) : (source.name ?? null);
}
