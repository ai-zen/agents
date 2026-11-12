/**
 * 素材服务：上传产物的落定与登记、取用时变成内容段（F-H7 / R44）、按引用清理（R33）。
 *
 * 三件事都属于「`assets/` 里那些文件与库里那些行」这个对象：
 *
 *   1. **落定**（{@link AssetService.finalizeUpload}）：上传接收器（`net/UploadReceiver`）把字节收进
 *      临时文件之后，本服务把它改名为正式文件、在 `assets` 表登记一行、回一个 {@link AssetRef}。
 *      文件命名只由服务端分配的 id 决定，不用客户端给的文件名拼路径。
 *   2. **取用**（{@link AssetService.prepareAttachments}）：`MessageInput.assetIds` → core 的内容段。
 *      走文件引用、内联 base64 还是退化成文字，由**实发模型与它所用端点**决定，判定逻辑用 SDK 的
 *      `fileToContentSection`（同一份口径，不在这里另写一遍）。没送出去的一律如实记账，不假装成功。
 *   3. **清理**（{@link AssetService.removeByConversation} 等）：按对话 / 素材 id 找出引用、删文件、删行。
 *      这一层是碰 `assets/` 下**正式文件**的地方（临时文件的生与死归上传接收器）。
 *
 * 它被 `ChatRunner` 当作 `prepareAttachments` 注入（PRD F-H7 / 裁定 R44）。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { fileToContentSection, mimeOf } from "@ai-zen/agents-sdk";
import type { Endpoint, FileSource, Model, ToolEnvDeps } from "@ai-zen/agents-sdk";

import type { ServerPaths } from "../config.js";
import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import type { UploadFinalizeRequest } from "../net/UploadReceiver.js";
import type { AttachmentPreparer } from "../runtime/ChatRunner.js";
import {
  MAX_ASSETS_PER_MESSAGE,
  type AssetRef,
  type AttachmentDelivery,
  type AttachmentOutcome,
  type LocalizedText,
  type ProblemFact,
} from "../wire/index.js";

// ---------------------------------------------------------------------------
// 依赖形状
// ---------------------------------------------------------------------------

/**
 * 素材行：本服务用到的字段（结构上等于存储层的 `AssetRow`）。
 *
 * 这里单独声明一份窄形状，是为了让本服务只依赖「它真的读的那些字段」，
 * `AssetRepository` 结构上满足它，接线处直接传进来即可。
 */
export interface AssetRecord {
  id: string;
  conversationId: string;
  messageId: string | null;
  name: string | null;
  /** 数据根下的相对路径（如 `assets/<id>.png`） */
  path: string;
  mime: string;
  bytes: number;
  sha256: string | null;
  createdAt: number;
}

/** 素材仓储里本服务用到的部分（`AssetRepository` 结构上满足） */
export interface AssetRegistry {
  create(input: {
    id: string;
    conversationId: string;
    messageId?: string | null;
    name?: string | null;
    path: string;
    mime: string;
    bytes: number;
    sha256?: string | null;
    createdAt: number;
  }): Promise<void>;
  get(id: string): Promise<AssetRecord | undefined>;
  listByConversation(conversationId: string): Promise<AssetRecord[]>;
  linkToMessage(id: string, messageId: string): Promise<number>;
  delete(id: string): Promise<number>;
}

/**
 * 实发模型的上下文：模型与它绑定的端点。
 *
 * 两者都不能只看 id 就猜：`file_id` 是端点维度的资源（传错端点会 not found），
 * 「这个模型能不能看图」在模型定义上。谁解析出来由配置层决定，这里只收结果。
 */
export interface AttachmentModelContext {
  model: Model | null;
  endpoint: Endpoint | null;
}

/** 按模型 id 找模型与端点；找不到就回 `null` 字段（调用方按「没有能力信息」处理） */
export type AttachmentModelResolver = (
  modelId: string | null,
) => Promise<AttachmentModelContext> | AttachmentModelContext;

/** `ChatRunner` 注入点的入参（结构即契约，直接从那里取，不另定义一份） */
export type AttachmentPrepareContext = Parameters<AttachmentPreparer>[0];

/** `prepareAttachments` 的出参（同上） */
export type AttachmentPreparation = Awaited<ReturnType<AttachmentPreparer>>;

/** 素材服务依赖；由单根组装后注入 */
export interface AssetServiceOptions {
  assets: AssetRegistry;
  paths: ServerPaths;
  /**
   * 按实发模型取模型与端点（F-H7 的判定依据）。不给时按「既没有视觉能力信息、也没有端点能力」
   * 处理：图片会走内联，超过内联上限的会如实报失败。
   */
  resolveModelContext?: AttachmentModelResolver;
  /** 传给 SDK 转换器的依赖（测试替身上传；生产缺省走 OpenAI 兼容的 Files API） */
  toolEnv?: ToolEnvDeps;
  /** 时钟，缺省 `Date.now` */
  now?: () => number;
  /** 素材 id 生成，缺省 `crypto.randomUUID` */
  newId?: () => string;
  /** 降级 / 失败的事实上报口（日志或通知）；缺省忽略 */
  onProblem?: (problem: ProblemFact, context: string) => void;
}

/**
 * MIME → 落盘扩展名。
 *
 * 扩展名不是装饰：`fileToContentSection` 会按扩展名推 MIME（它要据此决定走视觉通道还是 `file` 块），
 * 所以常见类型都按同一张表落地；表外的类型落 `.bin`，取用时改走「给字节 + 显式 mime」那条来源。
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
};

export class AssetService {
  private readonly options: AssetServiceOptions;
  private readonly assets: AssetRegistry;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: AssetServiceOptions) {
    this.options = options;
    this.assets = options.assets;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  // -------------------------------------------------------------------------
  // 落定与登记
  // -------------------------------------------------------------------------

  /**
   * 把收完的临时文件变成正式素材（`UploadReceiver` 的落定回调）。
   *
   * 顺序是「先改名、再登记行、失败就把文件删回去」：库里出现一行指向不存在的文件，
   * 比文件多留一份更难收拾（取用时会变成「有引用但读不到」）。
   */
  async finalizeUpload(request: UploadFinalizeRequest): Promise<AssetRef> {
    const assetId = this.newId();
    const fileName = `${assetId}${extensionFor(request.mime)}`;
    const finalPath = join(this.options.paths.assetsDir, fileName);

    await fs.mkdir(this.options.paths.assetsDir, { recursive: true });
    await fs.rename(request.tempPath, finalPath);

    const relativePath = toRelativePath(this.options.paths.dataRoot, finalPath);
    try {
      await this.assets.create({
        id: assetId,
        conversationId: request.conversationId,
        name: request.name,
        path: relativePath,
        mime: request.mime,
        bytes: request.bytes,
        sha256: request.sha256,
        createdAt: this.now(),
      });
    } catch (error) {
      await fs.rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      assetId,
      mime: request.mime,
      bytes: request.bytes,
      name: request.name,
      // 尺寸要解码图片才拿得到；本轮不做，回 `null`（客户端按「未知」处理）
      width: null,
      height: null,
    };
  }

  /** 把上传好的素材挂到落库后的那条消息上（上传早于消息落库，PRD D5 / F-H8） */
  async linkToMessage(assetIds: string[], messageId: string): Promise<void> {
    for (const assetId of dedupe(assetIds)) {
      await this.assets.linkToMessage(assetId, messageId).catch((error: unknown) => {
        this.report(error, "素材挂到消息上失败");
      });
    }
  }

  /** 一条素材行（取用方要按 id 查 ref 时用） */
  async get(assetId: string): Promise<AssetRecord | undefined> {
    return await this.assets.get(assetId);
  }

  // -------------------------------------------------------------------------
  // 取用：assetIds → 内容段（PRD F-H7 / R44）
  // -------------------------------------------------------------------------

  /**
   * 用户输入 + 已上传的素材 → 真正发给模型的内容（`ChatRunner` 的 `prepareAttachments`）。
   *
   * 口径（F-H7 逐条）：
   *   - **文本段在前**：用户打的字始终是第一段，素材段按用户摆放的顺序跟在后面；
   *   - **按实发模型选传输方式**：能不能走 Files API 看端点声明、图片能不能进上下文看模型，
   *     判定与转换交给 SDK 的 `fileToContentSection`（与工具链里那段代码同一份口径）；
   *   - **失败要告警**：每张图各自的结局都记账（`deliveredAs` + `problem`），不合并成一句「成功」；
   *   - **全失败退回纯文本**：一张都没送出去时内容就是用户原来那段文字，
   *     既没有凭空多出来的段，也没有假装发出去的占位。
   */
  async prepareAttachments(context: AttachmentPrepareContext): Promise<AttachmentPreparation> {
    const content = context.input.content;
    const assetIds = dedupe(context.input.assetIds ?? []);
    if (assetIds.length === 0) return { content, attachments: [] };

    const withinLimit = assetIds.slice(0, MAX_ASSETS_PER_MESSAGE);
    const overflow = assetIds.slice(MAX_ASSETS_PER_MESSAGE);

    const collected: AgentNS.MessageContentSection[] = [];
    const attachments: AttachmentOutcome[] = [];

    // 一条消息最多带几张（PRD D5）：超出的那些明确记账，不静默丢掉
    for (const assetId of overflow) {
      attachments.push({
        assetId,
        deliveredAs: "dropped",
        section: null,
        problem: this.problem(
          "attachment.tooMany",
          { limit: MAX_ASSETS_PER_MESSAGE },
          { assetId, reason: "over_per_message_limit" },
        ),
      });
    }

    const target = await this.resolveTarget(context.modelId);

    for (const assetId of withinLimit) {
      const record = await this.assets.get(assetId);
      if (!record) {
        attachments.push({
          assetId,
          deliveredAs: "dropped",
          section: null,
          problem: this.problem("notice.attachmentDropped", { name: assetId }, {
            assetId,
            reason: "asset_not_found",
          }),
        });
        continue;
      }

      const outcome = await this.deliver(record, target);
      attachments.push(outcome);
      if (outcome.section !== null) collected.push(outcome.section);
    }

    return { content: withSections(content, collected), attachments };
  }

  /**
   * 一张素材的送达过程：读出字节来源、交给 SDK 转换、把结论译成 wire 上的「怎么走的」。
   *
   * 抛错不往上扔：一张图没送出去不该让整轮消息发不出去（F-H7 的「全失败退回纯文本」前提是
   * 其余内容照发），所以这里收敛成一个 `dropped` 的结局并上报。
   */
  private async deliver(
    record: AssetRecord,
    target: AttachmentModelContext,
  ): Promise<AttachmentOutcome> {
    const label = record.name ?? basename(record.path);
    try {
      const result = await fileToContentSection({
        source: await this.sourceOf(record),
        endpoint: target.endpoint,
        model: target.model,
        deps: this.options.toolEnv,
      });

      if (result.transport === "text") {
        // 模型读不了图：SDK 给了一段文字说明，这里如实说是「退化成文字」
        const problem = this.problem("message.imageAsText", {
          model: target.model?.name ?? target.model?.id ?? "",
          name: label,
        }, { assetId: record.id, reason: "model_without_vision", warning: result.warning });
        this.options.onProblem?.(problem, "附件退化成文字");
        return {
          assetId: record.id,
          deliveredAs: "text_fallback",
          section: result.section,
          problem,
        };
      }

      return {
        assetId: record.id,
        deliveredAs: deliveryOf(result.transport),
        section: result.section,
        problem: null,
      };
    } catch (error) {
      const problem = this.problem("notice.attachmentDropped", { name: label }, {
        assetId: record.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      this.options.onProblem?.(problem, "附件没能发出去");
      return { assetId: record.id, deliveredAs: "dropped", section: null, problem };
    }
  }

  /**
   * 素材 → `fileToContentSection` 的来源。
   *
   * 扩展名能推出同一个 MIME 时给路径（SDK 自己 stat + 读，省一次我们的读盘）；
   * 推不出来时给字节 + 显式 mime，否则 SDK 会因为「不认识的扩展名」直接拒掉一个我们明明知道类型的文件。
   */
  private async sourceOf(record: AssetRecord): Promise<FileSource> {
    const absolutePath = this.resolveAssetPath(record.path);
    if (mimeOf(absolutePath) === record.mime) return { path: absolutePath };
    const data = await fs.readFile(absolutePath);
    return {
      data: new Uint8Array(data),
      mime: record.mime,
      filename: record.name ?? basename(absolutePath),
    };
  }

  /**
   * 按 id 找模型与端点。
   *
   * 解析失败不让整轮崩掉：拿不到能力信息就按「没有端点能力、也没有模型信息」继续 ——
   * 后果是图片走内联、超过内联上限的那张如实报「发不出去」，而不是整条消息失败。
   */
  private async resolveTarget(modelId: string | null): Promise<AttachmentModelContext> {
    const resolver = this.options.resolveModelContext;
    const empty: AttachmentModelContext = { model: null, endpoint: null };
    if (!resolver) return empty;
    try {
      const resolved = await resolver(modelId);
      return { model: resolved.model ?? null, endpoint: resolved.endpoint ?? null };
    } catch (error) {
      this.report(error, "解析素材的实发模型失败");
      return empty;
    }
  }

  // -------------------------------------------------------------------------
  // 按引用清理（R33）
  // -------------------------------------------------------------------------

  /**
   * 清掉一段对话名下的全部素材（行 + 文件）。
   *
   * 对话已经被删掉时那些行已经随外键级联消失，本方法返回空清单；所以「删对话」那条路上
   * 更常用的是 {@link removeFiles}（服务层删之前就已经把要清的文件清单算好了）。
   */
  async removeByConversation(conversationId: string): Promise<string[]> {
    const rows = await this.assets.listByConversation(conversationId);
    return await this.removeRecords(rows);
  }

  /** 清掉指定的几个素材（行 + 文件） */
  async removeByAssetIds(assetIds: string[]): Promise<string[]> {
    const rows: AssetRecord[] = [];
    for (const assetId of dedupe(assetIds)) {
      const row = await this.assets.get(assetId);
      if (row) rows.push(row);
    }
    return await this.removeRecords(rows);
  }

  /**
   * 只删文件（行已经被级联删掉的场合）。
   *
   * 入参是数据根下的相对路径（服务层返回的 `assetPaths` 就是这个形状）。路径必须落在
   * `assets/` 里：这是唯一会让本服务删掉库外文件的地方，越界的路径一律不碰。
   */
  async removeFiles(relativePaths: string[]): Promise<string[]> {
    const removed: string[] = [];
    for (const relativePath of relativePaths) {
      const absolutePath = this.resolveAssetPath(relativePath);
      if (!this.isInsideAssetsDir(absolutePath)) {
        this.report(
          new Error(`refusing to remove ${relativePath}`),
          "素材路径不在 assets 目录下，跳过",
        );
        continue;
      }
      try {
        await fs.rm(absolutePath, { force: true });
        removed.push(normalizeSeparators(relativePath));
      } catch (error) {
        this.report(error, "删除素材文件失败");
      }
    }
    return removed;
  }

  /** 一批素材行：删行 + 删文件，返回删掉的文件（数据根相对路径） */
  private async removeRecords(rows: AssetRecord[]): Promise<string[]> {
    const removedPaths: string[] = [];
    for (const row of rows) {
      try {
        await this.assets.delete(row.id);
      } catch (error) {
        this.report(error, "删除素材行失败");
        // 行还在就继续：文件删掉会留下「有引用无文件」，比留着更糟
        continue;
      }
      removedPaths.push(...(await this.removeFiles([row.path])));
    }
    return removedPaths;
  }

  // -------------------------------------------------------------------------
  // 路径与文案
  // -------------------------------------------------------------------------

  /** 数据根相对路径 → 绝对路径（已经是绝对路径的原样返回） */
  private resolveAssetPath(path: string): string {
    return isAbsolute(path) ? path : join(this.options.paths.dataRoot, path);
  }

  /** 只认 `assets/` 目录里面的路径（含 `..` 绕出去的都不认） */
  private isInsideAssetsDir(absolutePath: string): boolean {
    const fromAssets = relative(this.options.paths.assetsDir, absolutePath);
    return fromAssets !== "" && !fromAssets.startsWith("..") && !isAbsolute(fromAssets);
  }

  /**
   * 一条给人看的事实（`LocalizedText` 的血缘：码 + 文案键 + 参数 + 当前语言下的句子）。
   *
   * 这里的语言用默认语言：素材转换发生在 `ChatRunner` 那一轮里，那一层拿不到「这是哪条连接」。
   * 客户端要按自己连接的语言显示时，用 `messageKey` + `params` 重新渲染即可（D8 的存码不存句子）。
   */
  private problem(
    messageKey: MessageKey,
    params: Record<string, unknown>,
    detail?: unknown,
  ): ProblemFact {
    const text: LocalizedText = {
      code: messageKey,
      messageKey,
      params,
      message: render(DEFAULT_LANGUAGE, messageKey, params),
    };
    return detail === undefined ? text : { ...text, detail };
  }

  private report(error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.onProblem?.(
      {
        code: "internal",
        messageKey: "error.internal",
        params: {},
        message: render(DEFAULT_LANGUAGE, "error.internal"),
        detail: { context, reason: message },
      },
      context,
    );
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** MIME 对应的落盘扩展名；表外类型落 `.bin`（取用时改走「字节 + 显式 mime」的来源） */
function extensionFor(mime: string): string {
  return EXTENSION_BY_MIME[mime.toLowerCase()] ?? ".bin";
}

/** 绝对路径 → 数据根下的相对路径（分隔符统一成 `/`，与库里存的口径一致） */
function toRelativePath(dataRoot: string, absolutePath: string): string {
  return normalizeSeparators(relative(dataRoot, absolutePath));
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 去重并去掉空值（同一张图重复 id 只发一次） */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** SDK 给的传输方式 → wire 上的「这个附件怎么走的」 */
function deliveryOf(transport: "url" | "files-api" | "inline" | "text"): AttachmentDelivery {
  if (transport === "files-api" || transport === "url") return "file_reference";
  if (transport === "inline") return "inline";
  return "text_fallback";
}

/**
 * 把素材段接在用户输入后面（F-H7：文本段在前）。
 *
 * 用户输入是字符串时先包成一段 `text`：core 的内容段数组里没有「裸字符串 + 数组」这种混装。
 */
function withSections(
  content: AttachmentPrepareContext["input"]["content"],
  sections: AgentNS.MessageContentSection[],
): AttachmentPrepareContext["input"]["content"] {
  if (sections.length === 0) return content;
  const head =
    typeof content === "string"
      ? content === ""
        ? []
        : [{ type: "text" as const, text: content }]
      : content;
  return [...head, ...sections];
}
