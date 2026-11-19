/**
 * 素材服务：上传产物的落定与登记、取用时变成内容段（F-H7 / R44）、按引用清理（R33）、
 * 以及段上 `__asset_id` 这条本地标记的两端（打上 / 按当前模型兜底重建）。
 *
 * 它围着 `assets` 这一份真相做五件事：
 *
 *   1. **落定**（{@link AssetService.finalizeUpload}）：上传接收器（`net/UploadReceiver`）把字节收进
 *      临时文件之后，本服务把它改名为正式文件、在 `assets` 表登记一行、回一个 {@link AssetRef}。
 *      库里已经有同摘要的那一行时不重复落文件（全局去重），回既有那一行。
 *   2. **取用**（{@link AssetService.prepareAttachments}）：`MessageInput.assetIds` → core 的内容段。
 *      走文件引用、内联 base64 还是退化成文字，由**实发模型与它所用端点**决定，判定逻辑用 SDK 的
 *      `fileToContentSection`（同一份口径，不在这里另写一遍）。没送出去的一律如实记账，不假装成功。
 *      产出**只有一份**内容：段上带着厂商产物（`file_id` / base64），并挂本地标记 `__asset_id`。
 *   3. **重放**（{@link AssetService.resolveHistory}）：历史里的 `__asset_id` 在每轮发送前还原成
 *      当前模型能吃的内容段 —— 换了模型、重启之后再跑，同一条历史照样发得出去。发出去的那一份
 *      经 core 的 `formatContent` 按字段白名单重建，`__` 开头的键不会出网。
 *   4. **厂商 file_id 的缓存**：`assets` 是真相；厂商的 `file_id` 是端点维度资源，落在
 *      `asset_vendor_files`（{@link AssetService.vendorFiles}）。三条：
 *        - 这个端点上有缓存行 → 直接用那个 `vendorFileId`；
 *        - 这个端点上没有、别的端点上有（换厂商 / 换端点）→ 内联 base64，不往新端点重传；
 *        - 哪个端点上都没有 → 上传一次并写回。
 *      发送失败就报失败：不自动重试、不判失效、不清缓存。
 *   5. **清理**（{@link AssetService.sweepUnreferenced}）：引用归零的素材才删行、删文件。关系行
 *      （`session_assets`）由外键级联删，所以这里判的是「删完之后还剩几张引用」。
 *      这一层是碰 `assets/` 下**正式文件**的地方（临时文件的生与死归上传接收器）。
 *
 * 它被 `ChatRunner` 当作 `prepareAttachments` / `prepareHistory` / `linkMessageAssets` 注入
 * （PRD F-H7 / 裁定 R44）。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { formatContent, formatContentSection } from "@ai-zen/agents-core";
import { fileToContentSection, mimeOf } from "@ai-zen/agents-sdk";
import type { Endpoint, FileSource, Model, ToolEnvDeps, UploadFn } from "@ai-zen/agents-sdk";

import type { HostPaths } from "../config.js";
import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import type { UploadFinalizeRequest } from "../net/UploadReceiver.js";
import type { AttachmentPreparer, MessageAssetLinker } from "../runtime/ChatRunner.js";
import { HostError } from "../wire/errors.js";
import {
  MAX_ASSETS_PER_MESSAGE,
  localAssetIdOf,
  type AssetGetResult,
  type AssetRef,
  type AssetVariant,
  type AttachmentDelivery,
  type AttachmentOutcome,
  type LocalMessageContentSection,
  type LocalizedText,
  type ProblemFact,
} from "../wire/index.js";
import { readImageSizeFromFile } from "./imageSize.js";

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
  name: string | null;
  /** 数据根下的相对路径（如 `assets/<id>.png`） */
  path: string;
  mime: string;
  bytes: number;
  /** 内容摘要；全库唯一，所以它也是去重的键 */
  sha256: string;
  /** 像素宽度：落定时按文件头解出（PNG / JPEG），解不出来为 `null` */
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
}

/** 一个素材的缓存行分布：这个端点上有没有、别的端点上有没有 */
export interface VendorFilePresence {
  /** 这个端点上已经有缓存行（命中就复用那个 file_id） */
  onEndpoint: boolean;
  /** 别的端点上有（换过厂商 / 端点，这次走内联） */
  elsewhere: boolean;
}

/** 素材仓储里本服务用到的部分（`AssetRepository` 结构上满足） */
export interface AssetRegistry {
  /** 插入；库里已有同摘要的那一行时回既有行（`created: false`） */
  upsert(input: {
    id: string;
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
  /** 按内容摘要找（`asset.begin` 带 sha256 时的去重命中判定，全库范围） */
  findByDigest(sha256: string): Promise<AssetRecord | undefined>;
  /** 记一行「这条消息引用了这份素材」；已经有这一行时返回 0 */
  linkAsset(input: {
    sessionId: string;
    messageId: string;
    assetId: string;
    createdAt: number;
  }): Promise<number>;
  /** 这份素材被几行引用 */
  countReferences(assetId: string): Promise<number>;
  /** 归零才删（还有引用时返回 0，删不掉） */
  deleteIfUnreferenced(assetId: string): Promise<number>;
}

/**
 * 厂商 file_id 缓存表的窄接口（`AssetRepository` 结构上满足）。
 *
 * 单列一个口子是为了让「缓存只是一张表」这件事在类型上就是真的：本服务只用这三个动作，
 * 没有第二个地方会去改它。
 */
export interface AssetVendorRegistry {
  getVendorFile(assetId: string, endpointId: string): Promise<VendorFileRecord | undefined>;
  upsertVendorFile(input: VendorFileRecord): Promise<void>;
  /** 这个素材的缓存行分布（决定这次是复用、内联还是上传） */
  describeVendorFiles(assetId: string, endpointId: string): Promise<VendorFilePresence>;
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

/** `ChatRunner` 的素材关系登记口（结构即契约，同上） */
export type MessageAssetLinkContext = Parameters<MessageAssetLinker>[0];

/** 素材服务依赖；由单根组装后注入 */
export interface AssetServiceOptions {
  assets: AssetRegistry;
  /** 厂商 file_id 的缓存表；不注入时每次发送都真上传（缓存那一层不生效） */
  vendorFiles?: AssetVendorRegistry;
  paths: HostPaths;
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
   * 登记走 upsert，键是 `sha256`（全库唯一）：库里已经有同一份字节时（另一段对话传过、或
   * 两个上传撞在一起），唯一约束会挡住插入，这时把刚写出去的文件删掉、回库里既有那一行 ——
   * 全局去重的目的（整台机器只占一份磁盘）因此对两条路都成立。
   *
   * 「这段素材归哪段对话」不在这张表上：归属在消息落库那一刻写进 `session_assets`
   * （{@link AssetService.linkMessageAssets}），所以这个入参里的 `sessionId` 不参与登记。
   *
   * 文件落到正式位置之后读一次文件头，把像素尺寸一并登记（{@link readImageSizeFromFile}）：
   * 客户端拿 `width` / `height` 先排占位框，图显示出来时界面不会跳。量不到就是 `null`。
   */
  async finalizeUpload(request: UploadFinalizeRequest): Promise<AssetRef> {
    const assetId = this.newId();
    const fileName = `${assetId}${extensionFor(request.mime)}`;
    const finalPath = join(this.options.paths.assetsDir, fileName);

    await fs.mkdir(this.options.paths.assetsDir, { recursive: true });
    await fs.rename(request.tempPath, finalPath);

    const size = await readImageSizeFromFile(finalPath);
    const relativePath = toRelativePath(this.options.paths.dataRoot, finalPath);
    try {
      const { row, created } = await this.assets.upsert({
        id: assetId,
        name: request.name,
        path: relativePath,
        mime: request.mime,
        bytes: request.bytes,
        sha256: request.sha256,
        // 尺寸来自文件头解码；量不到（非 PNG / JPEG、截断、读不出来）时为 `null`
        width: size?.width ?? null,
        height: size?.height ?? null,
        createdAt: this.now(),
      });
      // 没插进去：库里已经有一份同摘要的字节，刚改名的那份是多余的
      if (!created) await fs.rm(finalPath, { force: true }).catch(() => undefined);
      return toAssetRef(row);
    } catch (error) {
      await fs.rm(finalPath, { force: true }).catch(() => undefined);
      throw this.registrationError(error);
    }
  }

  /**
   * 「库里已经有这张图了」时回既有那一行（`UploadReceiver.begin` 的去重判定）。
   *
   * 两个条件同时成立才算命中：同一个 `sha256`、同一个字节数。第二个条件看着多余
   * （摘要相同就是同一份内容），但它是「客户端报的总长与宿主那一行对得上」的交叉校验：对不上
   * 就当作没命中，让客户端老老实实传一遍。
   *
   * 去重是**全局**的：另一段对话传过的同一张图也算命中，命中之后两个对话各自在
   * `session_assets` 里留一行引用，磁盘上仍然只有一份。
   */
  async findExistingAsset(input: { sha256: string; bytes: number }): Promise<AssetRef | null> {
    const row = await this.assets.findByDigest(input.sha256);
    if (!row || row.bytes !== input.bytes) return null;
    return toAssetRef(row);
  }

  /**
   * 登记素材行失败的翻译。
   *
   * `assets` 这一行不挂任何外键（归属在关系表上），所以这里没有「对话不存在」这类可判别失败：
   * 盘坏了、库坏了都是 internal，原因写进 detail 并进日志。
   */
  private registrationError(error: unknown): unknown {
    if (HostError.is(error)) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new HostError("internal", { detail: { reason, context: "asset_register" } });
  }

  /**
   * 消息落库那一刻：扫 `content` 里的 `__asset_id` 记关系行（同一 message + asset 只一行）。
   *
   * 关系行是「谁引用了它」的唯一记录，所以它跟消息行同一步写：之后撤回、删对话、删消息都由
   * 外键级联删关系行，不需要谁去减计数。写不进去（素材 id 认不得、库出错）不让这一轮失败 ——
   * 后果只是这份素材的引用少记一次，{@link AssetService.sweepUnreferenced} 因此会晚一步删。
   */
  async linkMessageAssets(context: MessageAssetLinkContext): Promise<number> {
    let linked = 0;
    for (const assetId of assetIdsOf(context.content)) {
      try {
        linked += await this.assets.linkAsset({
          sessionId: context.sessionId,
          messageId: context.messageId,
          assetId,
          createdAt: this.now(),
        });
      } catch (error) {
        this.report(error, "登记消息的素材引用失败");
      }
    }
    return linked;
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
   * 产出**只有一份**内容：素材段上带着厂商产物（`file_id` / base64），同时挂着本地标记
   * `__asset_id`。这一份既是发给模型的那一份，也是**原样落库**的那一份 —— 落库不做任何清理
   * （prompt caching 要的是两次请求的 messages 前缀逐字一致，清掉厂商产物之后重启或换端点，
   * 前缀就变了，缓存全 miss）。`__asset_id` 只给两件事用：客户端回显「这条消息用了哪份素材」，
   * 以及换模型 / 换厂商时 {@link AssetService.resolveHistory} 在装配那一刻兜底重建。
   */
  async prepareAttachments(context: AttachmentPrepareContext): Promise<AttachmentPreparation> {
    const content = context.input.content;
    const assetIds = dedupe(context.input.assetIds ?? []);
    if (assetIds.length === 0) {
      // 没有素材也要过一遍白名单：用户输入里可能带着客户端塞的本地字段，它们不该出网
      return { content: formatContent(content), attachments: [] };
    }

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

      const outcome = await this.sendAsset(record, target);
      // 段上补本地标记：这一份会原样落库，`__asset_id` 让客户端认得出「用了哪份素材」，
      // 也让换模型 / 换厂商时 `resolveHistory` 还能把它重建回来（出网时由 core 的白名单剥掉）
      const section = outcome.section === null ? null : withAssetId(outcome.section, record.id);
      attachments.push({ ...outcome, section });
      if (section !== null) collected.push(section);
    }

    return {
      // 只有这一份：用户打的字在前、素材段在后；送出去的那一份原样交给上层投递与落库
      content: withSections(formatContent(content), collected),
      attachments,
    };
  }

  /**
   * 历史里的 `__asset_id` → 当前模型能吃的内容段（`ChatRunner` 的 `prepareHistory`）。
   *
   * 每轮发送前跑一次，因为「能不能吃」跟着模型 / 端点变：换个支持 Files API 的端点就会走文件引用，
   * 换个不支持视觉的模型就退化成一句文字提示。还原不出来的那一段换成一句文字说明而不是把
   * 引用原样交给厂商（那会让整条请求 400）。
   *
   * 无论有没有素材引用，内容都按 core 的字段白名单重建一次（`formatContent`）：`__` 开头的键
   * 是本机扩展，出网的那一份里不该有它们。没有引用时不读盘、不上传。
   */
  async resolveHistory(context: {
    sessionId: string;
    modelId: string | null;
    messages: AgentNS.Message[];
  }): Promise<AgentNS.Message[]> {
    const usesAssets = context.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((section) => localAssetIdOf(section) !== null),
    );
    if (!usesAssets) {
      return context.messages.map((message) =>
        Array.isArray(message.content)
          ? { ...message, content: formatContent(message.content) }
          : message,
      );
    }

    const target = await this.resolveTarget(context.modelId);
    const resolved: AgentNS.Message[] = [];
    for (const message of context.messages) {
      if (!Array.isArray(message.content)) {
        resolved.push(message);
        continue;
      }
      const sections: AgentNS.MessageContentSection[] = [];
      for (const section of message.content) {
        const assetId = localAssetIdOf(section);
        if (assetId === null) {
          sections.push(formatContentSection(section));
          continue;
        }
        const record = await this.assets.get(assetId);
        const outcome =
          record === null || record === undefined
            ? null
            : await this.sendAsset(record, target, { quiet: true });
        sections.push(outcome?.section ?? unavailableSection(assetId, record));
      }
      // 只换内容、不动消息本体（id / 角色 / 状态都是 core 那一份）
      resolved.push({ ...message, content: sections });
    }
    return resolved;
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
      throw new HostError("not_found", {
        params: { entity: "asset" },
        detail: { assetId: input.assetId },
      });
    }
    let data: Buffer;
    try {
      data = await fs.readFile(this.resolveAssetPath(row.path));
    } catch (error) {
      // 行在、文件不在：这是宿主自己的不一致（不是调用方的错），但客户端要知道“取不到”
      this.report(error, "读取素材文件失败");
      throw new HostError("not_found", {
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
   * 一张素材的送达：读出字节来源、交给 SDK 转换、把结论译成 wire 上的「怎么走的」。
   *
   * 名字按它对模型做的事取（`sendAsset`）：它把一张素材送进这一份内容，不是「投递一条消息」
   * —— 宿主里叫 `deliver` 的是那一件事（`ChatRunner.deliver`）。
   *
   * 抛错不往上扔：一张图没送出去不该让整轮消息发不出去（F-H7 的「全失败退回纯文本」前提是
   * 其余内容照发），所以这里收敛成一个 `dropped` 的结局并上报。
   *
   * `quiet` 是历史重放用的：重放是每一轮的内部动作，一张旧图今天没送出去不等于用户刚做错了什么，
   * 不再往 `onProblem` 里塞一条（发送链上的告警留给“用户这一轮挂的图”）。
   */
  private async sendAsset(
    record: AssetRecord,
    target: AttachmentModelContext,
    options: { quiet?: boolean } = {},
  ): Promise<AttachmentOutcome> {
    const label = record.name ?? basename(record.path);
    try {
      const result = await fileToContentSection({
        source: await this.sourceOf(record),
        endpoint: await this.vendorEndpoint(record, target.endpoint),
        model: target.model,
        deps: this.conversionDeps(record, target),
      });

      if (result.transport === "text") {
        // 模型读不了图：给模型一句说明（不是给用户看的文案，所以不走 i18n）
        const problem = this.problem("message.imageAsText", {
          model: target.model?.name ?? target.model?.id ?? "",
          name: label,
        }, { assetId: record.id, reason: "model_without_vision", warning: result.warning });
        if (!options.quiet) this.options.onProblem?.(problem, "附件退化成文字");
        return {
          assetId: record.id,
          deliveredAs: "text_fallback",
          section: noVisionSection(label),
          problem,
        };
      }

      return {
        assetId: record.id,
        deliveredAs: deliveryOf(result.transport),
        section: replacementSection(result.section, label),
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
   * 这次交给 SDK 的端点。
   *
   * 这个端点上已经有这个素材的缓存行（或者哪个端点上都没有）时原样给它：前者命中复用，
   * 后者上传一次。只有「这个端点上没有、别的端点上有」才给 `null` —— 那是换厂商 / 换端点，
   * 不往新端点重传，SDK 于是走内联 base64。
   */
  private async vendorEndpoint(
    record: AssetRecord,
    endpoint: Endpoint | null,
  ): Promise<Endpoint | null> {
    const vendor = this.vendorFiles;
    if (!vendor || !endpoint) return endpoint;
    try {
      const presence = await vendor.describeVendorFiles(record.id, endpoint.id);
      return presence.onEndpoint || !presence.elsewhere ? endpoint : null;
    } catch (error) {
      // 读不到缓存行就当没命中：交给 SDK 那条既定选路（上传失败会自己降级内联）
      this.report(error, "读厂商文件缓存失败");
      return endpoint;
    }
  }

  /**
   * 交给 SDK 转换器的依赖：只把 `upload` 换成一个「先查缓存、miss 才真上传」的版本。
   *
   * SDK 那边不记任何 file_id，所以「同一张图不重复上传」由持有持久存储的这一层承担。
   * 缓存行以 `(assetId, endpointId)` 为键：命中就拿那个 `vendorFileId`，miss 才发 HTTP 并写回。
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
        if (cached) return cached.vendorFileId;
      } catch (error) {
        // 读缓存失败不该让发送失败：当作 miss，重新上传一遍
        this.report(error, "读厂商文件缓存失败");
      }

      const vendorFileId = await realUpload(input);
      try {
        await vendor.upsertVendorFile({
          assetId: record.id,
          endpointId,
          vendorFileId,
          createdAt: this.now(),
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
   * 一批素材 id → 引用归零的那些：删行、删文件。
   *
   * 调用时机是「消息清理完之后」：撤回、删对话、删项目都已经交给外键把关系行级联删掉了，
   * 这里再问一次「这张素材还剩几行引用」（`COUNT(*)`）——还剩就不动，归零才删。
   * `assets` 那行的删除走 {@link AssetRegistry.deleteIfUnreferenced}（`RESTRICT` 是护栏：
   * 判完之后又有人引用上时，物理删不掉）。
   *
   * 返回真正删掉的文件（数据根相对路径）；行在而文件已经不在时不报错（清理要能重复执行）。
   */
  async sweepUnreferenced(assetIds: string[]): Promise<string[]> {
    const removed: string[] = [];
    for (const assetId of dedupe(assetIds)) {
      const row = await this.assets.get(assetId);
      if (!row) continue;
      try {
        if ((await this.assets.countReferences(assetId)) > 0) continue;
        if ((await this.assets.deleteIfUnreferenced(assetId)) === 0) continue;
      } catch (error) {
        // 删行失败就留着文件：行还在而文件没了会变成「有引用无文件」，比多留一份更糟
        this.report(error, "删除素材行失败");
        continue;
      }
      removed.push(...(await this.removeFiles([row.path])));
    }
    return removed;
  }

  /**
   * 只删文件。
   *
   * 入参是数据根下的相对路径（`assets` 行的 `path` 就是这个形状）。路径必须落在 `assets/` 里：
   * 这是唯一会让本服务删掉库外文件的地方，越界的路径一律不碰。
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

/**
 * 段上补一个本地标记 `__asset_id`（指回 `assets` 表那一行）。
 *
 * 这**不是**「另一种落库形态」：落库的就是这一份，厂商产物（`file_id` / base64）原样在上面。
 * 标记只给两件事用 —— 客户端回显「这条消息用了哪份素材」（`localAssetIdOf`），以及换模型 /
 * 换厂商时 {@link AssetService.resolveHistory} 按当前模型把这一段重建一遍。
 *
 * 出网的那一份里没有它：core 的 `formatContent` 按字段白名单重建，`__` 开头的键留不下来。
 */
function withAssetId(
  section: AgentNS.MessageContentSection,
  assetId: string,
): LocalMessageContentSection {
  return { ...(section as LocalMessageContentSection), __asset_id: assetId };
}

/**
 * 一条内容里的全部素材 id（按出现顺序、去重）。
 *
 * 撤回时的“回填输入框”（R62）与消息落库时的关系行都靠它复原「这条消息挂了哪几张图」：
 * `assets` 行上不再记消息，`session_assets` 才是那个事实，而它的来源是 content。
 */
export function assetIdsOf(content: AgentNS.MessageContent | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const section of content) {
    const assetId = localAssetIdOf(section);
    if (assetId !== null) ids.push(assetId);
  }
  return dedupe(ids);
}

/**
 * 模型看不了图时给模型的替代段。
 *
 * 这是**发给模型的文字**，不是给人看的文案（所以不走 i18n）：把文件名说清楚，让模型知道自己
 * 漏了什么。不带磁盘路径 —— 那是本机事实，厂商不需要知道。
 */
function noVisionSection(label: string): AgentNS.MessageContentSection {
  return { type: "text", text: `[Image] ${label}（当前模型看不了图片）` };
}

/**
 * 把 SDK 给出的段收敛成本服务的三种形态。
 *
 *   - Files API：`{ type: "file", file_id }`
 *   - 内联图片：`{ type: "image_url", image_url: { url: "data:…" } }`（`detail` 有就带上）
 *   - 其余（非图片内联）：`{ type: "file", file_data, filename }`
 *
 * 同一个 `(素材, 端点)` 每次进来的 `source` 都是同一份字节，`upload` 命中持久缓存时拿到的也是
 * 同一个 `file_id`，所以这里不做任何跟「这一次」有关的加工（时间戳、随机名、重新编码）——
 * 连发两轮得到的段逐字节相同。
 */
function replacementSection(
  section: AgentNS.MessageContentSection,
  label: string,
): AgentNS.MessageContentSection {
  if (section.type === "file") {
    if (typeof section.file_id === "string") {
      // `file_id` 已经是引用：只有 `file_data` 才带 `filename`（两者不同现，见 core 的类型）
      return { type: "file", file_id: section.file_id };
    }
    if (typeof section.file_data === "string") {
      return { type: "file", file_data: section.file_data, filename: label };
    }
    return section;
  }
  if (section.type === "image_url") {
    const detail = section.image_url.detail;
    return detail === undefined
      ? { type: "image_url", image_url: { url: section.image_url.url } }
      : { type: "image_url", image_url: { url: section.image_url.url, detail } };
  }
  return section;
}

/**
 * 还原失败时给模型的替代段。
 *
 * 这也是**发给模型的文字**（不走 i18n）：素材已经不在库里时，模型至少要知道这里原本有一个附件。
 */
function unavailableSection(
  assetId: string,
  record: AssetRecord | undefined,
): AgentNS.MessageContentSection {
  const label = record?.name ?? assetId;
  return {
    type: "text",
    text: record === undefined
      ? `[Attachment] ${label} is no longer available in this session.`
      : `[Attachment] ${label} could not be sent with this request.`,
  };
}

/**
 * 缺省上传：OpenAI 兼容的 `POST {baseUrl}/files`（`purpose=user_data`）。
 *
 * 与 SDK 里的同名行为一致，但那个函数没有从包根导出（宿主只被允许调用 SDK 的公开出口），
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
