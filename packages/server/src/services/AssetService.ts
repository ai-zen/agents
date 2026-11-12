/**
 * 素材服务：上传产物的落定与登记、取用时变成内容段（F-H7 / R44）、按引用清理（R33）、
 * 以及「库里只有 `asset://`」这条口径的两端。
 *
 * 它围着 `assets` 这一份真相做五件事：
 *
 *   1. **落定**（{@link AssetService.finalizeUpload}）：上传接收器（`net/UploadReceiver`）把字节收进
 *      临时文件之后，本服务把它改名为正式文件、在 `assets` 表登记一行、回一个 {@link AssetRef}。
 *      同一段对话里同摘要的那一行已经在时，不重复落文件（去重），回既有那一行。
 *   2. **取用**（{@link AssetService.prepareAttachments}）：`MessageInput.assetIds` → core 的内容段。
 *      走文件引用、内联 base64 还是退化成文字，由**实发模型与它所用端点**决定，判定逻辑用 SDK 的
 *      `fileToContentSection`（同一份口径，不在这里另写一遍）。没送出去的一律如实记账，不假装成功。
 *      同时给出「落库用」的那一份内容：素材在那里写成 `asset://<assetId>`。
 *   3. **重放**（{@link AssetService.resolveHistory}）：历史里的 `asset://<id>` 在每轮发送前还原成
 *      当前模型能吃的内容段 —— 换了模型、重启之后再跑，同一条历史照样发得出去。
 *   4. **两层缓存**：`assets` 是真相；厂商的 `file_id` 是端点维度、会过期的资源，落在
 *      `asset_vendor_files`（{@link AssetService.vendorFiles}）。命中就不发 HTTP，miss 才真上传并写回；
 *      一次请求因「file 不存在/无效」失败时 {@link AssetService.invalidateVendorFiles} 把那一批作废。
 *   5. **清理**（{@link AssetService.removeByConversation} 等）：按对话 / 素材 id 找出引用、删文件、删行。
 *      这一层是碰 `assets/` 下**正式文件**的地方（临时文件的生与死归上传接收器）。
 *
 * 它被 `ChatRunner` 当作 `prepareAttachments` / `prepareHistory` 注入（PRD F-H7 / 裁定 R44）。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { fileToContentSection, mimeOf } from "@ai-zen/agents-sdk";
import type { Endpoint, FileSource, Model, ToolEnvDeps, UploadFn } from "@ai-zen/agents-sdk";

import type { ServerPaths } from "../config.js";
import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import type { UploadFinalizeRequest } from "../net/UploadReceiver.js";
import type {
  AttachmentHistoryResolver,
  AttachmentPreparer,
} from "../runtime/ChatRunner.js";
import { ServerError } from "../wire/errors.js";
import {
  MAX_ASSETS_PER_MESSAGE,
  type AssetGetResult,
  type AssetRef,
  type AssetVariant,
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
  /** 内容摘要；`(conversationId, sha256)` 唯一，所以它也是对话内去重的键 */
  sha256: string;
  /** 像素宽度；本波不解码图片，未如时为 `null` */
  width: number | null;
  /** 像素高度；口径同 `width` */
  height: number | null;
  createdAt: number;
}

/** 一条厂商 file_id 缓存行（结构上等于存储层的 `AssetVendorFileRow`） */
export interface VendorFileRecord {
  assetId: string;
  endpointId: string;
  vendorFileId: string;
  createdAt: number;
  lastUsedAt: number;
}

/** 素材仓储里本服务用到的部分（`AssetRepository` 结构上满足） */
export interface AssetRegistry {
  /** 插入；同一段对话里同摘要的那一行已经在时回既有行（`created: false`） */
  upsert(input: {
    id: string;
    conversationId: string;
    messageId?: string | null;
    name?: string | null;
    path: string;
    mime: string;
    bytes: number;
    sha256: string;
    width?: number | null;
    height?: number | null;
    createdAt: number;
  }): Promise<{ row: AssetRecord; created: boolean }>;
  get(id: string): Promise<AssetRecord | undefined>;
  /** 按内容摘要找（`asset.begin` 带 sha256 时的去重命中判定） */
  findByDigest(conversationId: string, sha256: string): Promise<AssetRecord | undefined>;
  listByConversation(conversationId: string): Promise<AssetRecord[]>;
  linkToMessage(id: string, messageId: string): Promise<number>;
  delete(id: string): Promise<number>;
}

/**
 * 厂商 file_id 缓存表的窄接口（`AssetRepository` 结构上满足）。
 *
 * 单列一个口子是为了让「缓存可以失效、可以删光重建」这件事在类型上就是真的：本服务只用
 * 这五个动作，没有第二个地方会去改它。
 */
export interface AssetVendorRegistry {
  getVendorFile(assetId: string, endpointId: string): Promise<VendorFileRecord | undefined>;
  upsertVendorFile(input: VendorFileRecord): Promise<void>;
  touchVendorFile(assetId: string, endpointId: string, lastUsedAt: number): Promise<number>;
  listVendorFiles(conversationId: string, endpointId: string): Promise<VendorFileRecord[]>;
  /** 这段对话在这个端点上的缓存整批作废，返回删掉的行数 */
  deleteVendorFiles(conversationId: string, endpointId: string): Promise<number>;
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
  /** 厂商 file_id 的缓存表；不注入时每次发送都真上传（缓存那一层不生效） */
  vendorFiles?: AssetVendorRegistry;
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
  private readonly vendorFiles?: AssetVendorRegistry;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: AssetServiceOptions) {
    this.options = options;
    this.assets = options.assets;
    this.vendorFiles = options.vendorFiles;
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
   *
   * 登记走 upsert：同一段对话里同摘要的那一行已经在时（两个上传撞在一起，或客户端没带
   * `sha256` 而服务端自己又算不出重复），唯一约束会挡住插入，这时把刚写出去的文件删掉、
   * 回库里既有那一行 —— 对话内去重的目的（只占一份磁盘）因此对两条路都成立。
   *
   * 登记失败时把错误翻译一次：外键失败在这条路上只有一个含义（那段对话在库里不存在），
   * 换成一个可判别的业务码，客户端才能说一句人话。
   */
  async finalizeUpload(request: UploadFinalizeRequest): Promise<AssetRef> {
    const assetId = this.newId();
    const fileName = `${assetId}${extensionFor(request.mime)}`;
    const finalPath = join(this.options.paths.assetsDir, fileName);

    await fs.mkdir(this.options.paths.assetsDir, { recursive: true });
    await fs.rename(request.tempPath, finalPath);

    const relativePath = toRelativePath(this.options.paths.dataRoot, finalPath);
    try {
      const { row, created } = await this.assets.upsert({
        id: assetId,
        conversationId: request.conversationId,
        name: request.name,
        path: relativePath,
        mime: request.mime,
        bytes: request.bytes,
        sha256: request.sha256,
        // 尺寸要解码图片才拿得到；本波不引入图像库，落 `null`（客户端按「未知」处理）
        width: null,
        height: null,
        createdAt: this.now(),
      });
      // 没插进去：库里已经有一份同摘要的字节，刚改名的那份是多余的
      if (!created) await fs.rm(finalPath, { force: true }).catch(() => undefined);
      return toAssetRef(row);
    } catch (error) {
      await fs.rm(finalPath, { force: true }).catch(() => undefined);
      throw this.registrationError(error, request.conversationId);
    }
  }

  /**
   * 「这段对话里已经有这张图了」时回既有那一行（`UploadReceiver.begin` 的去重判定）。
   *
   * 三个条件同时成立才算命中：同一段对话、同一个 `sha256`、同一个字节数。第三个条件看着多余
   * （摘要相同就是同一份内容），但它是「客户端报的总长与服务端那一行对得上」的交叉校验：对不上
   * 就当作没命中，让客户端老老实实传一遍。
   */
  async findExistingAsset(input: {
    conversationId: string;
    sha256: string;
    bytes: number;
  }): Promise<AssetRef | null> {
    const row = await this.assets.findByDigest(input.conversationId, input.sha256);
    if (!row || row.bytes !== input.bytes) return null;
    return toAssetRef(row);
  }

  /**
   * 登记素材行失败 → 给调用方一个能分支的错误。
   *
   * `assets.conversationId` 是这张表上唯一一条指向别处的外键（`messageId` 在这一步还是空），
   * 所以外键失败的含义就是「这段对话在库里不存在」：报 `not_found` 而不是 internal。
   * 其余失败（盘、库坏了）仍是 internal，原因写进 detail 并进日志。
   */
  private registrationError(error: unknown, conversationId: string): unknown {
    if (ServerError.is(error)) return error;
    const reason = error instanceof Error ? error.message : String(error);
    if (/FOREIGN KEY/i.test(reason)) {
      return new ServerError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId, reason: "conversation_not_found" },
      });
    }
    return new ServerError("internal", { detail: { reason, context: "asset_register" } });
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
   *
   * 同时给出**落库用**的那一份（`storedContent`）：素材在那里是 `asset://<assetId>`。
   * 一份内容、两种形状是故意的 —— 发给模型的带着厂商产物（`file_id` / base64），存下的带的是引用，
   * 否则这条消息绑在「这一次发送所用的端点」上，换模型 / 换端点 / 重启之后就发了。
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
    const records: AssetRecord[] = [];

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

      records.push(record);
      const outcome = await this.deliver(record, target);
      attachments.push(outcome);
      if (outcome.section !== null) collected.push(outcome.section);
    }

    return {
      content: withSections(content, collected),
      attachments,
      // 落库的那一份：成不成功都记「用户挂过这几张」（失败事实在 `attachments` 里，不在库里）
      storedContent: withSections(content, records.map(assetSectionOf)),
    };
  }

  /**
   * 历史里的 `asset://<id>` → 当前模型能吃的内容段（`ChatRunner` 的 `prepareHistory`）。
   *
   * 每轮发送前跑一次，因为「能不能吃」跟着模型 / 端点变：换个支持 Files API 的端点就会走文件引用，
   * 换个不支持视觉的模型就退化成一句文字提示。还原不出来的那一段换成一句文字说明而不是把
   * `asset://` 原样交给厂商（那会让整条请求 400）。
   *
   * 没有 `asset://` 的历史只扫一遍、不读盘也不上传：绝大多数消息里没有图。
   */
  async resolveHistory(context: {
    conversationId: string;
    modelId: string | null;
    messages: AgentNS.Message[];
  }): Promise<AgentNS.Message[]> {
    const needsResolve = (message: AgentNS.Message): boolean =>
      Array.isArray(message.content) && message.content.some((section) => isAssetRefSection(section));
    if (!context.messages.some(needsResolve)) return context.messages;

    const target = await this.resolveTarget(context.modelId);
    const resolved: AgentNS.Message[] = [];
    for (const message of context.messages) {
      if (!needsResolve(message) || !Array.isArray(message.content)) {
        resolved.push(message);
        continue;
      }
      const sections: AgentNS.MessageContentSection[] = [];
      for (const section of message.content) {
        const assetId = assetIdOfSection(section);
        if (assetId === null) {
          sections.push(section);
          continue;
        }
        const record = await this.assets.get(assetId);
        const outcome =
          record === null || record === undefined
            ? null
            : await this.deliver(record, target, { quiet: true });
        sections.push(outcome?.section ?? unavailableSection(assetId, record));
      }
      // 只换内容、不动消息本体（id / 角色 / 状态都是 core 那一份）
      resolved.push({ ...message, content: sections });
    }
    return resolved;
  }

  /**
   * 把「这段对话在这个端点上的厂商 file_id 缓存」整批作废，返回删掉的行数。
   *
   * 触发场景：一次请求因「file 不存在/无效」被厂商拒了。`file_id` 是端点维度且会过期的资源，
   * 到底哪一条失效了从错误里看不出来，所以按「这段对话 + 这个端点」整批删：重传一遍的代价与
   * 逐条定位一样，而下一轮发送会把真需要的那几个补回来。
   */
  async invalidateVendorFiles(input: {
    conversationId: string;
    modelId: string | null;
  }): Promise<number> {
    const vendor = this.vendorFiles;
    if (!vendor) return 0;
    const target = await this.resolveTarget(input.modelId);
    const endpointId = target.endpoint?.id;
    if (!endpointId) return 0;
    try {
      return await vendor.deleteVendorFiles(input.conversationId, endpointId);
    } catch (error) {
      this.report(error, "作废厂商文件缓存失败");
      return 0;
    }
  }

  /**
   * 按 id 取回素材内容（`asset.get`）。
   *
   * `thumb` 目前**等同原图**：本波不引入原生图像库，两档返回同一份字节与同一个 mime；
   * 客户端要小图时按回包里的 `width` / `height`（未知为 `null`）自己缩。
   */
  async getAsset(input: { assetId: string; variant?: AssetVariant }): Promise<AssetGetResult> {
    const row = await this.assets.get(input.assetId);
    if (!row) {
      throw new ServerError("not_found", {
        params: { entity: "asset" },
        detail: { assetId: input.assetId },
      });
    }
    let data: Buffer;
    try {
      data = await fs.readFile(this.resolveAssetPath(row.path));
    } catch (error) {
      // 行在、文件不在：这是服务端自己的不一致（不是调用方的错），但客户端要知道“取不到”
      this.report(error, "读取素材文件失败");
      throw new ServerError("not_found", {
        params: { entity: "asset" },
        detail: { assetId: input.assetId, reason: "asset_file_missing", path: row.path },
      });
    }
    return {
      asset: toAssetRef(row),
      variant: input.variant ?? "original",
      data: data.toString("base64"),
    };
  }

  /**
   * 一张素材的送达过程：读出字节来源、交给 SDK 转换、把结论译成 wire 上的「怎么走的」。
   *
   * 抛错不往上扔：一张图没送出去不该让整轮消息发不出去（F-H7 的「全失败退回纯文本」前提是
   * 其余内容照发），所以这里收敛成一个 `dropped` 的结局并上报。
   *
   * `quiet` 是历史重放用的：重放是每一轮的内部动作，一张旧图今天没送出去不等于用户刚做错了什么，
   * 不再往 `onProblem` 里塞一条（发送链上的告警留给“用户这一轮挂的图”）。
   */
  private async deliver(
    record: AssetRecord,
    target: AttachmentModelContext,
    options: { quiet?: boolean } = {},
  ): Promise<AttachmentOutcome> {
    const label = record.name ?? basename(record.path);
    try {
      const result = await fileToContentSection({
        source: await this.sourceOf(record),
        endpoint: target.endpoint,
        model: target.model,
        deps: this.conversionDeps(record, target),
      });

      if (result.transport === "text") {
        // 模型读不了图：SDK 给了一段文字说明，这里如实说是「退化成文字」
        const problem = this.problem("message.imageAsText", {
          model: target.model?.name ?? target.model?.id ?? "",
          name: label,
        }, { assetId: record.id, reason: "model_without_vision", warning: result.warning });
        if (!options.quiet) this.options.onProblem?.(problem, "附件退化成文字");
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
      if (!options.quiet) this.options.onProblem?.(problem, "附件没能发出去");
      return { assetId: record.id, deliveredAs: "dropped", section: null, problem };
    }
  }

  /**
   * 交给 SDK 转换器的依赖：只把 `upload` 换成一个「先查缓存、miss 才真上传」的版本。
   *
   * SDK 那边不再记任何 file_id（上一波已删），所以“同一张图不重复上传”由持有持久存储的
   * 这一层承担。缓存行以 `(assetId, endpointId)` 为键：同一个素材传到另一个端点必须重新上传
   * （`vendorFileId` 是端点维度资源）。命中时只 `touch` 一下 `lastUsedAt`，不发 HTTP。
   *
   * 每张素材各自拿一个闭包（不共享可变状态），并发发送两张不同的图不会互相写错行。
   */
  private conversionDeps(
    record: AssetRecord,
    target: AttachmentModelContext,
  ): ToolEnvDeps | undefined {
    const vendor = this.vendorFiles;
    const base = this.options.toolEnv;
    if (!vendor) return base;
    const realUpload = base?.upload ?? defaultVendorUpload;

    const upload: UploadFn = async (input) => {
      const endpointId = input.endpoint.id;
      try {
        const cached = await vendor.getVendorFile(record.id, endpointId);
        if (cached) {
          await vendor.touchVendorFile(record.id, endpointId, this.now());
          return cached.vendorFileId;
        }
      } catch (error) {
        // 读缓存失败不该让发送失败：当作 miss，重新上传一逼
        this.report(error, "读厂商文件缓存失败");
      }

      const vendorFileId = await realUpload(input);
      try {
        const at = this.now();
        await vendor.upsertVendorFile({
          assetId: record.id,
          endpointId,
          vendorFileId,
          createdAt: at,
          lastUsedAt: at,
        });
      } catch (error) {
        // 写回失败：这一轮照常发（id 已经拿到了），下一轮只是多传一次
        this.report(error, "写厂商文件缓存失败");
      }
      return vendorFileId;
    };

    return { ...base, upload };
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

/** 素材行 → wire 上的引用（尺寸未知时为 `null`，客户端按「未知」排占位） */
export function toAssetRef(row: AssetRecord): AssetRef {
  return {
    assetId: row.id,
    mime: row.mime,
    bytes: row.bytes,
    name: row.name,
    width: row.width,
    height: row.height,
  };
}

/** 消息里的素材引用前缀：`asset://<assetId>` */
export const ASSET_URL_PREFIX = "asset://";

/**
 * 素材 → 落库用的内容段（消息里只允许出现我们自己的引用）。
 *
 * 图片写 `image_url.url`，其余写 `file.file_id`：两处都借用 core 的字段装一个 `asset://` URL，
 * 因为 core 的内容段没有“素材 id”这个字段（R23 的口径）。发送前由 {@link AssetService.resolveHistory}
 * 把它们换成这个模型能吃的真段。
 */
export function assetSectionOf(row: AssetRecord): AgentNS.MessageContentSection {
  const url = `${ASSET_URL_PREFIX}${row.id}`;
  if (row.mime.startsWith("image/")) return { type: "image_url", image_url: { url } };
  return row.name === null ? { type: "file", file_id: url } : { type: "file", file_id: url, filename: row.name };
}

/** 一个内容段是不是我们的素材引用 */
export function isAssetRefSection(section: AgentNS.MessageContentSection): boolean {
  return assetUrlOf(section) !== null;
}

/** 内容段里装的 `asset://` URL（不是素材引用时为空） */
function assetUrlOf(section: AgentNS.MessageContentSection): string | null {
  if (section.type === "image_url") {
    const url = section.image_url.url;
    return url.startsWith(ASSET_URL_PREFIX) ? url : null;
  }
  if (section.type === "file" && typeof section.file_id === "string") {
    return section.file_id.startsWith(ASSET_URL_PREFIX) ? section.file_id : null;
  }
  return null;
}

/** 内容段里的素材 id（不是素材引用时为空） */
export function assetIdOfSection(section: AgentNS.MessageContentSection): string | null {
  const url = assetUrlOf(section);
  if (url === null) return null;
  const assetId = url.slice(ASSET_URL_PREFIX.length).trim();
  return assetId === "" ? null : assetId;
}

/**
 * 一条内容里的全部素材 id（按出现顺序、去重）。
 *
 * 撤回时的“回填输入框”（R62）靠它复原用户挂过的图：`assets.messageId` 一列只指向一条消息，
 * 而同一张图可以被好几条消息引用（对话内去重让它只落一份字节），所以消息content 才是“这条消息
 * 挂了哪几张图”的真相。
 */
export function assetIdsOf(content: AgentNS.MessageContent | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const section of content) {
    const assetId = assetIdOfSection(section);
    if (assetId !== null) ids.push(assetId);
  }
  return dedupe(ids);
}

/**
 * 还原失败时给模型的替代段。
 *
 * 这是**发给模型的文字**，不是给人看的文案（所以不走 i18n）：SDK 自己降级时也是这么写的。
 */
function unavailableSection(
  assetId: string,
  record: AssetRecord | undefined,
): AgentNS.MessageContentSection {
  const label = record?.name ?? assetId;
  return {
    type: "text",
    text: record === undefined
      ? `[Attachment] ${label} is no longer available in this conversation.`
      : `[Attachment] ${label} could not be sent with this request.`,
  };
}

/**
 * 缺省上传：OpenAI 兼容的 `POST {baseUrl}/files`（`purpose=user_data`）。
 *
 * 与 SDK 里的同名行为一致，但那个函数没有从包根导出（服务端只被允许调用 SDK 的公开出口），
 * 而注入 `deps.upload` 之后 SDK 就不会再用自己的缺省实现，所以这一份写在这里。
 * 用原生 `fetch` + `FormData`，不引任何东西。
 */
async function defaultVendorUpload(input: {
  endpoint: Endpoint;
  data: Uint8Array;
  filename: string;
  signal?: AbortSignal;
}): Promise<string> {
  // 拷一份：`Uint8Array<ArrayBufferLike>` 与 `BlobPart` 要求的 `ArrayBuffer` 在 TS 5.7 起不兼容
  const bytes = new Uint8Array(input.data.byteLength);
  bytes.set(input.data);

  const form = new FormData();
  form.append("purpose", "user_data");
  form.append(
    "file",
    new Blob([bytes], { type: mimeOf(input.filename) ?? "application/octet-stream" }),
    input.filename,
  );
  const response = await fetch(`${input.endpoint.baseUrl.replace(/\/+$/, "")}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.endpoint.apiKey}` },
    body: form,
    signal: input.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `File upload failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("File upload failed: response has no `id`");
  return body.id;
}

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
  content: AgentNS.MessageContent,
  sections: AgentNS.MessageContentSection[],
): AgentNS.MessageContent {
  if (sections.length === 0) return content;
  const head =
    typeof content === "string"
      ? content === ""
        ? []
        : [{ type: "text" as const, text: content }]
      : content;
  return [...head, ...sections];
}
