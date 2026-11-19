/**
 * 上传接收器：`asset.begin` → 若干二进制帧 → `asset.end`（PLAN A11 / PRD D5、F-H8）。
 *
 * 三段式的分工：
 *   1. `asset.begin`（JSON-RPC 请求）：声明用途、类型、总字节数。**超限在这里就拒**（PRD D5：
 *      20MB/张），不接收完再说不行 —— 那既浪费带宽，也让客户端在上传中途白等一下。
 *      素材行要按会话挂外键，所以开临时文件之前先让归属的会话落库（草稿会话在库里还没有行，
 *      R56：落库发生在「第一次真正用到它」的那一刻，带图的第一条消息就属于这种）。
 *   2. 任意多个二进制帧：每一帧带上「这是哪个上传」的头，字节直接追加进临时文件，不在内存里攒。
 *   3. `asset.end`（JSON-RPC 请求）：校验总长度与客户端给的 `sha256`，通过后交给落定回调，
 *      把临时文件变成正式素材（`<dataRoot>/assets/` 下的正式文件 + 库里一行引用）。
 *
 * 二进制帧的形状（`asset.chunk`）：
 *
 * ```
 * | 4 字节大端无符号整数 N | N 字节 UTF-8 JSON 头 {"uploadId": "..."} | 若干字节片段 |
 * ```
 *
 * 为什么头里要带 `uploadId` 而不是「一条连接同时只允许一个上传」：同一条连接上可以并发多个上传
 * （一次拖进四张图就是四个），宿主分配的 `uploadId` 是它们之间唯一的区分方式。头做成
 * 「长度前缀 + JSON」而不是固定长度二进制 id，是为了让帧在抓包/日志里仍然可读，也不绑定
 * `uploadId` 的编码方式。
 *
 * 清理的口径（三处，都在本文件里）：
 *   - 长度或摘要不符：删临时文件，报错；
 *   - 连接断开 / 宿主收尾：这条连接名下所有未完成的上传按 `begin` 记下的临时文件删掉；
 *   - 写盘出错：删临时文件，报错。
 */

import { createHash, randomUUID, type Hash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_LANGUAGE, type Language } from "../i18n/index.js";
import { HostError } from "../wire/errors.js";
import type {
  AssetBeginParams,
  AssetBeginResult,
  AssetEndParams,
  AssetEndResult,
  AssetPurpose,
  AssetRef,
} from "../wire/index.js";
import { MAX_ASSET_BYTES } from "../wire/index.js";

/**
 * 收完一个上传之后要交给落定方的事实（临时文件此时已关闭、校验已通过）。
 *
 * 类型定在 net 这一侧（上传协议的一部分），落定实现（`AssetService.finalizeUpload`）按结构
 * 满足它 —— 两边不需要互相 import 具体实现。
 */
export interface UploadFinalizeRequest {
  uploadId: string;
  /** 临时文件的绝对路径；落定方负责把它改成正式文件 */
  tempPath: string;
  mime: string;
  /** 实际写入的字节数（已校验过等于声明值） */
  bytes: number;
  /** 小写十六进制的摘要（已校验过等于客户端给的值） */
  sha256: string;
  name: string | null;
  purpose: AssetPurpose;
  sessionId: string;
}

/** 落定：把临时文件变成正式素材并登记引用 */
export type UploadFinalizer = (request: UploadFinalizeRequest) => Promise<AssetRef>;

/**
 * 上传前的去重查询：库里是不是已经有同一份字节了。
 *
 * 命中时 `asset.begin` 直接回既有引用（`deduped: true`）：不建临时文件、不分配 `uploadId`。
 * 宿主自己算 `sha256` 也行，但它得先把 20MB 收完 —— 客户端本来就算过，问一句就够了。
 * 去重是全局的（按内容摘要），所以这里不问「哪段会话」。
 */
export type ExistingAssetLookup = (input: {
  sha256: string;
  bytes: number;
}) => Promise<AssetRef | null>;

/**
 * 上传前让「这段会话」成为库里的行。
 *
 * `language` 是那条「这段会话在哪个目录」的隐藏消息的渲染语言（D8）：上传是连接上的动作，
 * 只有接线层知道收件人说的是哪种语言，所以逐次传进来而不是在构造时定死。
 */
export type SessionPersister = (
  sessionId: string,
  language: Language,
) => Promise<void>;

export interface UploadReceiverOptions {
  /** 数据根下的 `assets/`：临时文件与正式文件同目录，改名不必跨设备复制 */
  assetsDir: string;
  /** 收完之后做什么（缺省实现见 `AssetService.finalizeUpload`） */
  finalize: UploadFinalizer;
  /**
   * 上传前把这段会话落成库里的行（R56：`session.create` 只发 id 与身份）。
   *
   * 素材行按 `sessionId` 挂外键，所以「新会话第一条消息就带图」这条路上，会话的落库发生在
   * `asset.begin`（与「第一次 `send`」同义）。实现方要自己幂等（同一段会话反复调只落一行）；
   * 不注入时上传不碰会话表。
   */
  ensureSession?: SessionPersister;
  /**
   * `asset.begin` 带了 `sha256` 时先问一句「库里是不是已经有它」。
   *
   * 不注入时不问去重（每次都收字节），也不报错：去重是优化，不是上传的前提。
   */
  findExisting?: ExistingAssetLookup;
  /** 单张上限，缺省 `MAX_ASSET_BYTES`（20MB，PRD D5） */
  maxAssetBytes?: number;
  /** 内部错误去处（清理失败、落定失败等）；缺省忽略 */
  onError?: (error: unknown, context: string) => void;
}

/** 一次上传的进行态（只在内存里；进程没了就等于断开，临时文件由下次启动前的清理兜底） */
interface UploadSession {
  uploadId: string;
  connectionId: string;
  purpose: AssetPurpose;
  mime: string;
  name: string | null;
  sessionId: string;
  declaredBytes: number;
  tempPath: string;
  handle: FileHandle;
  hash: Hash;
  receivedBytes: number;
  /** 写盘串行化：同一上传的多个分片必须按到达顺序落盘 */
  chain: Promise<void>;
  closed: boolean;
}

/** 二进制帧头部的长度字段占多少字节 */
const HEADER_LENGTH_BYTES = 4;

/** 头部 JSON 的长度上限（防一个坏帧声称自己有 4GB 的头） */
const HEADER_LIMIT_BYTES = 4096;

/** 目前只有「消息里的图片」这一种用途（PRD D5）；别的值按参数不对处理 */
const PURPOSES: readonly AssetPurpose[] = ["message_image"];

/**
 * MIME 的粗校验：`type/subtype`，两边都是 token 字符。
 *
 * 不做白名单：允许上传什么类型是「客户端让用户选什么」的事，宿主只保证这个值能被安全地
 * 用于落盘命名与内容段（真正的类型判断在 `fileToContentSection` 那一层）。
 */
const MIME_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

export class UploadReceiver {
  private readonly assetsDir: string;
  private readonly finalize: UploadFinalizer;
  private readonly onError?: (error: unknown, context: string) => void;
  /** 单张上限；`hello` 的 `limits` 也从这里取，两边不各写一个数 */
  readonly maxAssetBytes: number;
  private readonly ensureSession?: SessionPersister;
  private readonly findExisting?: ExistingAssetLookup;
  /** connectionId → uploadId → 进行中的上传 */
  private readonly sessions = new Map<string, Map<string, UploadSession>>();

  constructor(options: UploadReceiverOptions) {
    this.assetsDir = options.assetsDir;
    this.finalize = options.finalize;
    this.maxAssetBytes = options.maxAssetBytes ?? MAX_ASSET_BYTES;
    this.ensureSession = options.ensureSession;
    this.findExisting = options.findExisting;
    this.onError = options.onError;
  }

  /**
   * `asset.begin`：校验声明、让归属的会话落库、问去重、开临时文件、发一个上传句柄。
   *
   * 声明里只有「总长」能验，字节本身还没到；所以这里的拒绝都是**声明层面**的
   * （超限、类型不合法、缺会话归属、会话不存在）。
   *
   * 去重命中时这条路就到此为止：不建临时文件、不分配 `uploadId`。去重按内容摘要做，不区分
   * 会话，所以命中并不证明这段会话存在 —— 「让会话落库」排在问去重之前，不存在的会话这一趟
   * 一个字节也不会收。
   *
   * 「让会话落库」排在建临时文件之前：会话不存在时这一趟上传一个字节都不该落盘，
   * 也不该占住一个 `uploadId`。`language` 是这条连接的语言，用来渲染那条隐藏的 cwd 消息。
   */
  async begin(
    connectionId: string,
    params: AssetBeginParams,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<AssetBeginResult> {
    const purpose = requirePurpose(params.purpose);
    const mime = requireMime(params.mime);
    const declaredBytes = requireDeclaredBytes(params.bytes, this.maxAssetBytes);
    const sessionId = requireSessionId(params.sessionId);
    const name = normalizeName(params.name);
    const sha256 = params.sha256 === undefined ? null : normalizeDigest(params.sha256);

    // 草稿会话在库里还没有行（R56），而「这段会话存在」是上传的前提：先落库再收字节
    await this.persistSession(sessionId, language);

    // 库里已有同一份字节时只回引用：磁盘上只有一份，两段会话各自在关系表里留一行
    const existing = sha256 === null ? null : await this.lookupExisting({ sha256, bytes: declaredBytes });
    if (existing !== null) {
      return {
        deduped: true,
        uploadId: null,
        maxBytes: this.maxAssetBytes,
        receivedBytes: 0,
        asset: existing,
      };
    }

    await fs.mkdir(this.assetsDir, { recursive: true });
    const uploadId = randomUUID();
    // 临时文件名用宿主分配的上传句柄，不用客户端给的名字：文件名不参与路径拼接之外任何判断
    const tempPath = join(this.assetsDir, `.upload-${uploadId}.part`);
    const handle = await fs.open(tempPath, "wx");

    const session: UploadSession = {
      uploadId,
      connectionId,
      purpose,
      mime,
      name,
      sessionId,
      declaredBytes,
      tempPath,
      handle,
      hash: createHash("sha256"),
      receivedBytes: 0,
      chain: Promise.resolve(),
      closed: false,
    };
    this.sessionMap(connectionId).set(uploadId, session);

    return {
      deduped: false,
      uploadId,
      maxBytes: this.maxAssetBytes,
      receivedBytes: 0,
      asset: null,
    };
  }

  /**
   * 一个二进制帧：解出上传句柄，把片段追加进临时文件。
   *
   * 返回值是这条上传目前已收到的字节数（用得上就返回，测试与调试都不必去翻文件）。
   */
  async receiveBinary(connectionId: string, frame: Uint8Array): Promise<number> {
    const { uploadId, chunk } = decodeChunkFrame(frame);
    const session = this.sessions.get(connectionId)?.get(uploadId);
    if (!session) {
      throw new HostError("not_found", {
        params: { entity: "upload" },
        detail: { uploadId, reason: "unknown_upload_id" },
      });
    }
    return await this.append(session, chunk);
  }

  /**
   * `asset.end`：等写盘排空、关文件、校验长度与摘要，通过后落定。
   *
   * 校验不过时的顺序是「先删文件、再报错」：报错之后这条上传就没有别的出口了，
   * 留着半个文件只会变成没人认领的垃圾。
   */
  async end(connectionId: string, params: AssetEndParams): Promise<AssetEndResult> {
    const uploadId = requireUploadId(params.uploadId);
    const session = this.sessions.get(connectionId)?.get(uploadId);
    if (!session) {
      throw new HostError("not_found", {
        params: { entity: "upload" },
        detail: { uploadId, reason: "unknown_upload_id" },
      });
    }

    // 还有分片在写：等它们落完再验，否则长度会少算
    await session.chain;
    await this.closeHandle(session);
    this.detach(session);

    if (session.receivedBytes !== session.declaredBytes) {
      await this.discard(session);
      throw new HostError("invalid_params", {
        detail: {
          reason: "size_mismatch",
          uploadId,
          declaredBytes: session.declaredBytes,
          receivedBytes: session.receivedBytes,
        },
      });
    }

    const digest = session.hash.digest("hex");
    const expected = normalizeDigest(params.sha256);
    if (digest !== expected) {
      await this.discard(session);
      throw new HostError("invalid_params", {
        detail: { reason: "digest_mismatch", uploadId, expected, actual: digest },
      });
    }

    try {
      const asset = await this.finalize({
        uploadId,
        tempPath: session.tempPath,
        mime: session.mime,
        bytes: session.receivedBytes,
        sha256: digest,
        name: session.name,
        purpose: session.purpose,
        sessionId: session.sessionId,
      });
      return { asset };
    } catch (error) {
      // 落定失败（改名失败、登记失败）：临时文件留着没有意义，删掉再往上抛
      await this.discard(session);
      throw error;
    }
  }

  /**
   * 丢掉一条连接名下所有未完成的上传（连接断开时调）。
   *
   * 这是「中途断开按 `begin` 记的临时文件清理」的落点。清理本身失败只报给 `onError`：
   * 连接已经没了，没有谁在等一个失败结果。
   */
  async abortConnection(connectionId: string): Promise<void> {
    const sessions = this.sessions.get(connectionId);
    if (!sessions) return;
    this.sessions.delete(connectionId);
    for (const session of sessions.values()) {
      session.closed = true;
      await this.closeHandle(session);
      await this.discard(session);
    }
  }

  /** 宿主收尾：把所有连接的上传都清掉 */
  async dispose(): Promise<void> {
    const connectionIds = [...this.sessions.keys()];
    for (const connectionId of connectionIds) {
      await this.abortConnection(connectionId);
    }
  }

  /** 这条连接上还有几个未完成的上传（测试与诊断用） */
  pendingCount(connectionId?: string): number {
    if (connectionId !== undefined) return this.sessions.get(connectionId)?.size ?? 0;
    let total = 0;
    for (const sessions of this.sessions.values()) total += sessions.size;
    return total;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 让这段会话先成为库里的行（幂等由注入方保证）。
   *
   * 业务错误（`not_found` 之类）原样上抛：客户端要按码说人话，不能让「会话不存在」在出网时
   * 变成一句 internal。其余异常（写库失败这类）收敛成 `internal` 并留一个原因，原始错误同时
   * 交给 `onError` 进日志。
   */
  private async persistSession(sessionId: string, language: Language): Promise<void> {
    const ensure = this.ensureSession;
    if (!ensure) return;
    try {
      await ensure(sessionId, language);
    } catch (error) {
      if (HostError.is(error)) throw error;
      this.onError?.(error, "让会话落库失败");
      throw new HostError("internal", {
        detail: { reason: "session_persist_failed", sessionId },
        cause: error,
      });
    }
  }

  private sessionMap(connectionId: string): Map<string, UploadSession> {
    let sessions = this.sessions.get(connectionId);
    if (!sessions) {
      sessions = new Map<string, UploadSession>();
      this.sessions.set(connectionId, sessions);
    }
    return sessions;
  }

  /**
   * 问一句「库里有没有同一份字节」。
   *
   * 查询本身失败时当作「没命中」：去重是省一次上传的优化，不能因为它的存储出错就把整个上传拒掉。
   */
  private async lookupExisting(input: {
    sha256: string;
    bytes: number;
  }): Promise<AssetRef | null> {
    const find = this.findExisting;
    if (!find) return null;
    try {
      return await find(input);
    } catch (error) {
      this.onError?.(error, "查询重复素材失败");
      return null;
    }
  }

  private detach(session: UploadSession): void {
    const sessions = this.sessions.get(session.connectionId);
    sessions?.delete(session.uploadId);
    if (sessions && sessions.size === 0) this.sessions.delete(session.connectionId);
  }

  /** 追加一片：排在上一片之后写，累积摘要与已收字节数 */
  private append(session: UploadSession, chunk: Uint8Array): Promise<number> {
    const next = session.chain.then(async () => {
      if (session.closed) {
        throw new HostError("not_found", {
          params: { entity: "upload" },
          detail: { uploadId: session.uploadId, reason: "upload_closed" },
        });
      }
      if (chunk.byteLength === 0) return session.receivedBytes;
      // 先算长度再写：超过声明总长的分片不留痕（临时文件随后整份删掉）
      const nextBytes = session.receivedBytes + chunk.byteLength;
      if (nextBytes > session.declaredBytes) {
        session.closed = true;
        this.detach(session);
        await this.closeHandle(session);
        await this.discard(session);
        throw new HostError("payload_too_large", {
          params: {
            size: formatBytes(nextBytes),
            limit: formatBytes(session.declaredBytes),
          },
          detail: {
            reason: "exceeds_declared_bytes",
            uploadId: session.uploadId,
            declaredBytes: session.declaredBytes,
            receivedBytes: nextBytes,
          },
        });
      }
      await session.handle.write(chunk);
      session.hash.update(chunk);
      session.receivedBytes = nextBytes;
      return session.receivedBytes;
    });
    // 链条只用来排队：某一片失败不该把后面的分片也判成失败（它们各自会报自己的错）
    session.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async closeHandle(session: UploadSession): Promise<void> {
    await session.handle.close().catch((error: unknown) => {
      this.onError?.(error, "关闭上传临时文件失败");
    });
  }

  /** 删临时文件（不存在不算错：清理动作要能重复执行） */
  private async discard(session: UploadSession): Promise<void> {
    session.closed = true;
    await fs.rm(session.tempPath, { force: true }).catch((error: unknown) => {
      this.onError?.(error, "删除上传临时文件失败");
    });
  }
}

// ---------------------------------------------------------------------------
// 二进制帧
// ---------------------------------------------------------------------------

/**
 * 拼一个 `asset.chunk` 二进制帧（客户端按同一份实现编码，测试也用它）。
 *
 * 导出它是为了让「帧长什么样」只有一处定义：客户端与宿主各写一份编码器迟早会错开一个字段。
 */
export function encodeChunkFrame(uploadId: string, chunk: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ uploadId }));
  const frame = new Uint8Array(HEADER_LENGTH_BYTES + header.byteLength + chunk.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, HEADER_LENGTH_BYTES);
  frame.set(chunk, HEADER_LENGTH_BYTES + header.byteLength);
  return frame;
}

/**
 * 解一个 `asset.chunk` 二进制帧。
 *
 * 坏帧一律 `invalid_params` 并带 `detail.reason`：帧是二进制的，客户端拼错时唯一能帮上忙的
 * 就是「哪一步不对」（头长度越界、头不是 JSON、头里没有 `uploadId`）。
 */
export function decodeChunkFrame(frame: Uint8Array): { uploadId: string; chunk: Uint8Array } {
  if (frame.byteLength < HEADER_LENGTH_BYTES) {
    throw new HostError("invalid_params", {
      detail: { reason: "frame_too_short", bytes: frame.byteLength },
    });
  }
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    0,
    false,
  );
  if (headerLength === 0 || headerLength > HEADER_LIMIT_BYTES) {
    throw new HostError("invalid_params", {
      detail: { reason: "bad_header_length", headerLength },
    });
  }
  if (HEADER_LENGTH_BYTES + headerLength > frame.byteLength) {
    throw new HostError("invalid_params", {
      detail: {
        reason: "truncated_header",
        headerLength,
        bytes: frame.byteLength - HEADER_LENGTH_BYTES,
      },
    });
  }

  const headerBytes = frame.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
  } catch {
    throw new HostError("invalid_params", { detail: { reason: "header_not_json" } });
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new HostError("invalid_params", { detail: { reason: "header_not_an_object" } });
  }
  const uploadId = (header as Record<string, unknown>).uploadId;
  if (typeof uploadId !== "string" || uploadId.trim() === "") {
    throw new HostError("invalid_params", { detail: { reason: "header_without_upload_id" } });
  }
  return { uploadId: uploadId.trim(), chunk: frame.subarray(HEADER_LENGTH_BYTES + headerLength) };
}

// ---------------------------------------------------------------------------
// 参数校验与格式化
// ---------------------------------------------------------------------------

function requirePurpose(value: unknown): AssetPurpose {
  if (typeof value === "string" && (PURPOSES as readonly string[]).includes(value)) {
    return value as AssetPurpose;
  }
  throw new HostError("invalid_params", {
    params: { field: "purpose" },
    detail: { field: "purpose", got: value ?? null, allowed: PURPOSES },
  });
}

function requireMime(value: unknown): string {
  if (typeof value === "string" && MIME_PATTERN.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  throw new HostError("invalid_params", {
    params: { field: "mime" },
    detail: { field: "mime", got: value ?? null },
  });
}

function requireDeclaredBytes(value: unknown, limit: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HostError("invalid_params", {
      params: { field: "bytes" },
      detail: { field: "bytes", got: value ?? null, reason: "not_a_positive_integer" },
    });
  }
  if (value > limit) {
    throw new HostError("payload_too_large", {
      params: { size: formatBytes(value), limit: formatBytes(limit) },
      detail: { reason: "over_asset_limit", bytes: value, limit },
    });
  }
  return value;
}

/**
 * 上传必须归属一段会话。
 *
 * `asset.begin` 要这段会话在库里存在（草稿先落库），因为素材的引用关系（`session_assets`）
 * 与「图片按引用清理」都按会话走；没有归属的上传只能留下一个没人认领的文件。所以这里直接拒
 * （而不是先收完再失败）。
 */
function requireSessionId(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new HostError("invalid_params", {
    params: { field: "sessionId" },
    detail: { field: "sessionId", reason: "session_required" },
  });
}

function requireUploadId(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new HostError("invalid_params", {
    params: { field: "uploadId" },
    detail: { field: "uploadId", reason: "missing_upload_id" },
  });
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name === "" ? null : name;
}

function normalizeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new HostError("invalid_params", {
      params: { field: "sha256" },
      detail: { field: "sha256", reason: "not_a_sha256_digest" },
    });
  }
  return value.trim().toLowerCase();
}

/**
 * 字节数的人话形式（错误文案里的 `{size}` / `{limit}`）。
 *
 * 单位用 1024 进制、最多一位小数：`20 MB`、`8.5 MB`、`512 KB` —— 与用户看到文件大小时的口径一致。
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
