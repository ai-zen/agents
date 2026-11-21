import { randomUUID } from "node:crypto";

import { contentHash } from "@ai-zen/agents-sdk";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HostError } from "../../infra/errors.js";
import { ensureDirectory } from "../../infra/files.js";
import type { Translator } from "../i18n/index.js";
import type { assetTable, sessionAssetTable } from "./table.js";
import type { Asset } from "./types.js";

export interface AssetDeps {
  readonly assets: ReturnType<typeof assetTable>;
  readonly sessionAssets: ReturnType<typeof sessionAssetTable>;
  /** 数据根：字节落在它下面的 `assets/` 里 */
  readonly dataRoot: string;
  readonly t: Translator;
}

/**
 * 素材：库里的行加磁盘上的字节。
 *
 * 一次 `store` 之后行与字节都在，此后的删除只走 `sweepUnreferenced` 一个出口 ——
 * 各自开一个删除方法，就会出现「字节删了行还在」那种只有下一次读取才发现的不一致。
 */
export class AssetService {
  constructor(private readonly deps: AssetDeps) {}

  /**
   * 存一份字节。文件名用的是内容的摘要：同一份字节重名、改名都是同一份文件，
   * 用用户给的名字落盘就得处理重名，而重名之后两份不同的字节会互相覆盖。
   *
   * 库里已经有这个摘要时直接返回那一行，不写文件：去重命中还去写一遍，等于把写文件变成每次上传
   * 都要做的事。名字也跟着是第一次那一份 —— 摘要相同就是同一份字节，不该有第二个身份。
   */
  store(bytes: Buffer, mime: string, name: string | null): Asset {
    const sha256 = contentHash(bytes);
    const existing = this.deps.assets.getBySha256(sha256);
    if (existing !== undefined) return existing;

    const path = this.pathOf(sha256);
    ensureDirectory(join(this.deps.dataRoot, "assets"));
    // 先写同目录的临时文件再 `rename`：半截字节落到摘要这个名字上之后，读的人分不出它是不是完整那一份
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, bytes);
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }

    const asset: Asset = { id: randomUUID(), sha256, mime, name, createdAt: Date.now() };
    this.deps.assets.put(asset);
    return asset;
  }

  /**
   * 行不在就是 `not_found`，不折成 `undefined`：`getBytes` 要的是同一行的 `sha256`，
   * 两边都回 `undefined` 就成了每个调用点各判一次。
   */
  get(id: string): Asset {
    const asset = this.deps.assets.get(id);
    if (asset === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {assetId} 的素材", { assetId: id }),
        { entity: "asset", assetId: id },
      );
    }
    return asset;
  }

  getBytes(id: string): Buffer {
    return readFileSync(this.pathOf(this.get(id).sha256));
  }

  listBySession(sessionId: string): Asset[] {
    return this.deps.assets.listBySession(sessionId);
  }

  link(messageId: string, assetIds: readonly string[]): void {
    this.deps.sessionAssets.link(messageId, assetIds);
  }

  /**
   * 只处理传进来的这些素材：调用方知道刚删掉的是哪些消息，也就知道哪些素材可能失去引用；
   * 全表扫是另一件事，还会让这个方法藏着一个与调用点无关的代价。
   *
   * 先删行再删字节：反过来的话，崩在中间会留下一条「行在、文件没了」的素材 —— 它会一直出现在
   * 列表里却打不开。多留一个没人引用的文件则是安全的：下次存同一份字节时按摘要写回同一个路径。
   */
  sweepUnreferenced(assetIds: readonly string[]): void {
    for (const assetId of assetIds) {
      if (this.deps.sessionAssets.countByAsset(assetId) > 0) continue;
      // 同一个素材被两条删掉的消息引用时，这个 id 会在入参里出现两次
      const asset = this.deps.assets.get(assetId);
      if (asset === undefined) continue;
      this.deps.assets.delete(assetId);
      rmSync(this.pathOf(asset.sha256), { force: true });
    }
  }

  private pathOf(sha256: string): string {
    return join(this.deps.dataRoot, "assets", sha256);
  }
}
