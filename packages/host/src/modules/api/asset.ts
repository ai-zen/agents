import { z } from "zod";

import type { AssetService } from "../asset/service.js";
import type { Trpc } from "./trpc.js";

/**
 * 素材行过 wire 的那一份。形状只有 `asset/types.ts` 那一处，这里是它的声明式影子。
 *
 * `sha256` 出去是因为客户端要能判断两次上传是不是同一份字节：去重命中时回来的行是第一次那一份，
 * 靠 `id` 认不出来。
 */
const assetSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  mime: z.string(),
  name: z.string().nullable(),
  createdAt: z.number(),
});

/** 这两个 procedure 用到的只有素材这一个域 */
export interface AssetApiDeps {
  readonly assets: AssetService;
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

    list: api.procedure
      .input(z.object({ sessionId: z.string() }))
      .output(z.array(assetSchema))
      .query(({ input }) => deps.assets.listBySession(input.sessionId)),
  });
}
