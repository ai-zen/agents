import { z } from "zod";

import { base64ByteLength } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { AssetService } from "../asset/service.js";
import type { AssetRecord } from "../asset/types.js";
import type { Translator } from "../i18n/index.js";
import type { Trpc } from "./trpc.js";

/**
 * Asset 行过 wire 的那一份。形状只有 `asset/types.ts` 那一处，这里是它的声明式影子。
 *
 * `sha256` 出去是因为客户端要能判断两次上传是不是同一份字节：去重命中时回来的行是第一次那一份，
 * 靠 `id` 认不出来。
 *
 * `width` / `height` 出去是因为**只有界面用得上它们**（图还没到的时候先按比例撑开占位框）：
 * 缺了这两格就是「不知道多大」，客户端按未知排。
 */
const assetSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  mime: z.string(),
  name: z.string().nullable(),
  createdAt: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});

/**
 * 一张 Asset 的上限：**4MB**（`dev-docs/prd/09-attachments.md` 第 5 行，用户拍定的那一个数）。
 *
 * 数值只在这里写一次：超出上限**报错、不截断** —— 截断过的图片是另一张图，用户还会以为它
 * 完整地发出去了。
 */
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** 这两个 procedure 用到的只有 Asset 这一个域，加一个翻译口（超限那条文案要说清数值） */
export interface AssetApiDeps {
  readonly assets: AssetService;
  readonly t: Translator;
}

export function assetRouter(deps: AssetApiDeps, api: Trpc) {
  return api.router({
    /**
     * 取字节。`base64` 是因为 tRPC 这条 JSON 通道上没有二进制类型：
     * 编一次码的代价小于为下载另开一条通道。
     */
    get: api.procedure
      .input(z.object({ assetId: z.string() }))
      .output(z.object({ mime: z.string(), base64: z.string() }))
      .query(({ input }) => {
        const asset = deps.assets.get(input.assetId);
        return { mime: asset.mime, base64: deps.assets.getBytes(asset.id).toString("base64") };
      }),

    /**
     * 上传一份 Asset：客户端给 base64、mime 与（可选）文件名，回来的就是那一行。
     *
     * **宿主提供这个入口**（粘贴只是客户端那一半，两条路上限与数值一致）。体积先按 base64 量
     * 一次、不解码：**超了报错、不截断** —— 截断过的图片是另一张图，用户还会以为它完整地发出去了。
     * 落盘与去重全在 `AssetService.store`（按内容摘要，同一份字节全机只留一份）。
     */
    upload: api.procedure
      .input(
        z.object({
          name: z.string().nullable().optional(),
          mime: z.string(),
          base64: z.string(),
        }),
      )
      .output(z.object({ asset: z.custom<AssetRecord>() }))
      .mutation(({ input }) => {
        const bytes = base64ByteLength(input.base64);
        if (bytes > MAX_ASSET_BYTES) {
          throw new HostError(
            "invalid_params",
            deps.t("一张最多 4MB（{max} 字节），这一张 {bytes} 字节；超出上限报错，不截断", {
              max: MAX_ASSET_BYTES,
              bytes,
            }),
            { max: MAX_ASSET_BYTES, bytes },
          );
        }

        return {
          asset: deps.assets.store(
            Buffer.from(input.base64, "base64"),
            input.mime,
            input.name ?? null,
          ),
        };
      }),

    list: api.procedure
      .input(z.object({ sessionId: z.string() }))
      .output(z.array(assetSchema))
      .query(({ input }) => deps.assets.listBySession(input.sessionId)),
  });
}
