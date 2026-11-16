/**
 * 取回一份素材的内容 —— `asset.get` 的客户端那一半（PRD F-H7 / F-H8）。
 *
 * ## 为什么值得有一个入口
 *
 * 消息里存的是段上的本地扩展字段 `__asset_id`（厂商的 `file_id`、base64、绝对路径都不进库），
 * 所以任何一段历史里的图，客户端都要能按 id 把字节取回来自己显示：换模型、换设备、重启之后
 * 都是同一条路。
 *
 * ## 怎么判断「这一段要不要去取」
 *
 * 只看**有没有 `__asset_id` 这个扩展字段**，不解析任何 url scheme：段上的 `image_url.url`
 * 是空的、是 `https://…`、还是别的东西，都不影响这个判断。判断本身在
 * {@link localAssetIdOf}，取字节在 {@link getSectionAsset}（缩略图与原图同一个入口）。
 *
 * ## 两档
 *
 * `variant: "original"` 是原图。`"thumb"` 目前**等同原图**（宿主这一波不引入原生图像库），
 * 回包里的 `variant` 说明实际给的是哪一档；要小图就按 `asset.width` / `asset.height` 自己缩
 * （宽高未知时是 `null`）。
 *
 * ## 形状
 *
 * 内容走同一条 WS 上的 JSON 回包（base64），不是二进制下行帧：请求/响应本身就是原子的，不需要
 * 再定一套「这条下行帧对应哪个请求」的关联规则。代价是体积多三分之一，单张上限仍按 20MB（D5）。
 * 这个函数把 base64 解成字节，调用方不必每次自己 `Buffer.from`。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type { AssetRef, AssetVariant, LocalMessageContentSection } from "@ai-zen/agents-host";

import type { ContractCaller } from "./client.js";

/** `getAsset` 的入参：要哪一份、要哪一档 */
export interface GetAssetOptions {
  assetId: string;
  /** 缺省 `original` */
  variant?: AssetVariant;
}

/** 取回来的一份素材：引用事实 + 实际给的档 + 字节 */
export interface AssetContent {
  /** 宿主那边这一行的引用（`mime` / `bytes` / 宽高都在里面） */
  asset: AssetRef;
  /** 实际给出的档（`thumb` 目前等同原图） */
  variant: AssetVariant;
  /** 解好码的字节，长度应等于 `asset.bytes` */
  bytes: Uint8Array;
}

/**
 * 按素材 id 取回内容。
 *
 * 宿主找不到这个 id（或行在而文件不在）时报 `not_found`，错误原样往上抛：这一层不猜原因。
 */
export async function getAsset(
  client: ContractCaller,
  options: GetAssetOptions,
): Promise<AssetContent> {
  const { asset, variant, data } = await client.call("asset.get", {
    assetId: options.assetId,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  });

  return {
    asset,
    variant,
    // base64 → 字节：Node 的 Buffer 是 Uint8Array 的子类，包成独立的视图交给调用方
    bytes: new Uint8Array(Buffer.from(data, "base64")),
  };
}

/**
 * 一个内容段引用的素材 id（没有这个扩展字段就是 `null`）。
 *
 * 与宿主那份判断同口径：看的是字段在不在，不是 url 长什么样。空串 / 空白算没写。
 */
export function localAssetIdOf(section: AgentNS.MessageContentSection): string | null {
  const value = (section as LocalMessageContentSection).__asset_id;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 按段取回内容：段上有 `__asset_id` 就 `asset.get`，没有就回 `null`。
 *
 * `null` 的意思是「这一段不用素材通道显示」—— 调用方按段上原有的字段显示（比如远端 url），
 * 不是「取失败」。取失败（id 认得、字节取不到）会抛错，让调用方决定怎么提示。
 *
 * 缩略图与原图同一个入口：`variant` 只是透传，宿主这一波两档给的是同一份字节。
 */
export async function getSectionAsset(
  client: ContractCaller,
  section: AgentNS.MessageContentSection,
  options: { variant?: AssetVariant } = {},
): Promise<AssetContent | null> {
  const assetId = localAssetIdOf(section);
  if (assetId === null) return null;
  return await getAsset(client, {
    assetId,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  });
}
