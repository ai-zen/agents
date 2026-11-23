import { randomUUID } from "node:crypto";

import { contentHash } from "@ai-zen/agents-sdk";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HostError } from "../../infra/errors.js";
import { ensureDirectory } from "../../infra/files.js";
import type { Translator } from "../i18n/index.js";
import { probeImageSize } from "./probe.js";
import type { assetTable, sessionAssetTable } from "./table.js";
import type { AssetRecord } from "./types.js";

export interface AssetDeps {
  readonly assets: ReturnType<typeof assetTable>;
  readonly sessionAssets: ReturnType<typeof sessionAssetTable>;
  /** 数据根：字节落在它下面的 `assets/` 里 */
  readonly dataRoot: string;
  readonly t: Translator;
}

/**
 * Asset：库里的行加磁盘上的字节。
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
   *
   * 宽高在这里量一次（只读文件头，见 `probe.ts`）：量不到就是空，**不重试、不告警** —— 它只给
   * 界面排版用，为一张认不出格式的图报一次警毫无用处。
   */
  store(bytes: Buffer, mime: string, name: string | null): AssetRecord {
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

    const asset: AssetRecord = {
      id: randomUUID(),
      sha256,
      mime,
      name,
      createdAt: Date.now(),
      // 解不出时 `size` 是 `undefined`，摊开就什么都不加（这两格是可选的）
      ...probeImageSize(bytes),
    };
    this.deps.assets.put(asset);
    return asset;
  }

  /**
   * 行不在就是 `not_found`，不折成 `undefined`：`getBytes` 要的是同一行的 `sha256`，
   * 两边都回 `undefined` 就成了每个调用点各判一次。
   */
  get(id: string): AssetRecord {
    const asset = this.deps.assets.get(id);
    if (asset === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {assetId} 的Asset", { assetId: id }),
        { entity: "asset", assetId: id },
      );
    }
    return asset;
  }

  getBytes(id: string): Buffer {
    return readFileSync(this.pathOf(this.get(id).sha256));
  }

  /**
   * 按 id 找一行，找不到就是 `undefined`。
   *
   * 与 {@link get} 并存不是重复：`get` 回答的是「取不到就是一条客户端认得出的失败」，而这个
   * 回答的是「有没有」—— 发给厂商之前按 id 重建内容段的那一格端口要的是后者（Asset 可能已经被
   * 删了，那是一种正常处境，不是失败）。
   */
  find(id: string): AssetRecord | undefined {
    return this.deps.assets.get(id);
  }

  listBySession(sessionId: string): AssetRecord[] {
    return this.deps.assets.listBySession(sessionId);
  }

  link(messageId: string, assetIds: readonly string[]): void {
    this.deps.sessionAssets.link(messageId, assetIds);
  }

  /**
   * 只处理传进来的这些 Asset：调用方知道刚删掉的是哪些消息，也就知道哪些 Asset 可能失去引用；
   * 全表扫是另一件事，还会让这个方法藏着一个与调用点无关的代价。
   *
   * 先删行再删字节：反过来的话，崩在中间会留下一条「行在、文件没了」的 Asset —— 它会一直出现在
   * 列表里却打不开。多留一个没人引用的文件则是安全的：下次存同一份字节时按摘要写回同一个路径。
   *
   * 返回真的删掉的那几个 id：入参里有引用没归零的、也有本来就已经不在的，调用方要报「这一次
   * 删掉了什么」时，只有这里数得准。
   */
  sweepUnreferenced(assetIds: readonly string[]): string[] {
    const removed: string[] = [];

    for (const assetId of assetIds) {
      if (this.deps.sessionAssets.countByAsset(assetId) > 0) continue;
      // 同一个 Asset 被两条删掉的消息引用时，这个 id 会在入参里出现两次
      const asset = this.deps.assets.get(assetId);
      if (asset === undefined) continue;
      this.deps.assets.delete(assetId);
      rmSync(this.pathOf(asset.sha256), { force: true });
      removed.push(assetId);
    }

    return removed;
  }

  private pathOf(sha256: string): string {
    return join(this.deps.dataRoot, "assets", sha256);
  }
}
