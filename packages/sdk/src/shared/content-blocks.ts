/**
 * 本地文件 → 消息内容块的唯一转换入口。
 *
 * 背景：这段逻辑原先散落三处，且各自为政 ——
 *   1. `ViewImageTool` 自己判断 `endpoint.id === "deepseek"` 再上传（端点 id 一变就失效）；
 *   2. `mcp/mcpTools.ts` 自己把 MCP 的 base64 归一成 `image_url` / `file` 块；
 *   3. CLI 侧又实现了一遍「上传 or base64」。
 *
 * 现在统一到这里，调用方只提供「文件 + 当前端点/模型」，传输方式由本模块决定：
 *
 * | 条件 | 结果 |
 * |------|------|
 * | http(s) URL | 直接 `image_url`（不上传、不内联） |
 * | 端点声明 `capabilities.filesApi` | 上传 Files API → `file` 块（`file_id`），失败降级为内联 |
 * | 其余端点 + 图片 | `image_url` + base64 data URL |
 * | 其余端点 + 非图片 | `file` 块 + `file_data`（base64 data URL） |
 * | 模型明确不支持视觉（`vision === false`）且是图片 | 退化为 `text`，只给路径提示 |
 * | 内联体积超过上限且无法上传 | 抛错（不静默塞进请求体） |
 */

import OpenAI, { toFile } from "openai";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentNS } from "@ai-zen/agents-core";
import type { AppConfig, Endpoint, Model } from "../types/index.js";

/** 扩展名 → MIME。图片走视觉通道，其余走 `file` 块 */
export const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/** 按扩展名推断 MIME；未知扩展名返回 undefined */
export function mimeOf(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return MIME_BY_EXT[filePath.slice(dot).toLowerCase()];
}

/** base64 二进制转 data URL（`image_url` 与 `file.file_data` 均接受） */
export function toDataUrl(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * base64 字符串对应的字节数（不含空白）。
 *
 * 用于「只看体积、不想解码」的场景：内联上限检查与日志统计。
 */
export function base64ByteLength(base64: string): number {
  const len = base64.replace(/\s/g, "").length;
  if (len === 0) return 0;
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

/** 内联（base64）体积上限，默认 8 MiB；超过且端点不支持上传时直接报错 */
export const DEFAULT_MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** 实际采用的传输方式（供调用方组织提示文案 / 日志） */
export type ContentTransport = "url" | "files-api" | "inline" | "text";

/** 文件来源：本地路径 / 网络 URL / 已在内存里的字节 */
export type FileSource =
  | { path: string }
  | { url: string }
  | { data: Uint8Array; mime: string; filename?: string }
  /** 已经是 base64 的字节（MCP 等协议给的就是 base64）：内联时原样透传，不做解码再编码 */
  | { base64: string; mime: string; filename?: string };

/** Files API 上传函数签名（可注入，便于测试与替换实现） */
export type UploadFn = (input: {
  endpoint: Endpoint;
  data: Uint8Array;
  filename: string;
  signal?: AbortSignal;
}) => Promise<string>;

export interface FileToSectionInput {
  source: FileSource;
  /** 当前模型所用端点：决定能否走 Files API */
  endpoint?: Endpoint | null;
  /** 当前模型：`vision === false` 时图片退化为文本提示 */
  model?: Model | null;
  signal?: AbortSignal;
  /** 覆盖内联体积上限 */
  maxInlineBytes?: number;
  /** 依赖注入（测试用），默认走 OpenAI SDK 的 Files API */
  deps?: { upload?: UploadFn };
}

export interface FileToSectionResult {
  section: AgentNS.MessageContentSection;
  transport: ContentTransport;
  /** 实际处理的字节数（URL 来源为 0） */
  bytes: number;
  /** 降级 / 退化时的人类可读说明，供上层拼提示 */
  warning?: string;
}

/**
 * 由「发给 API 的模型名」反查它绑定的模型定义与端点。
 *
 * 工具在 `call()` 阶段拿不到 Agent 定义，但 `ctx.agent.model` 就是发给 API 的
 * 模型名（`Model.modelName ?? Model.id`）。必须按**当前实际使用的模型**定位端点：
 * `file_id` 是端点维度资源，传错端点会得到 not found。
 */
export function resolveModelAndEndpoint(
  config: AppConfig,
  apiModelName?: string,
): { model?: Model; endpoint?: Endpoint | null } {
  const models = config.models ?? [];
  const endpoints = config.endpoints ?? [];
  const findEndpoint = (id?: string) => (id ? endpoints.find((e) => e.id === id) ?? null : null);

  const byApiName = apiModelName
    ? models.find((m) => (m.modelName ?? m.id) === apiModelName)
    : undefined;
  if (byApiName) return { model: byApiName, endpoint: findEndpoint(byApiName.endpointId) };

  const fallback = models.find((m) => m.id === config.defaultModel);
  if (fallback) return { model: fallback, endpoint: findEndpoint(fallback.endpointId) };

  return { endpoint: null };
}

/** 端点是否声明了 Files API 能力 */
export function supportsFilesApi(endpoint?: Endpoint | null): boolean {
  return endpoint?.capabilities?.filesApi === true;
}

/**
 * 上传缓存：`端点id + 绝对路径 + mtime + size` → `file_id`。
 *
 * file_id 是**端点维度**的资源，所以 key 必须带端点 id —— 同一张图传到两个端点
 * 会得到两个不同的 id，混用会让另一端返回 not found。
 */
const uploadCache = new Map<string, string>();

/** 清空上传缓存（测试用；进程内长期运行无需清理，条目有上限） */
export function clearUploadCache(): void {
  uploadCache.clear();
}

const UPLOAD_CACHE_LIMIT = 200;

/** 内容哈希（sha256），用于给「内存里的字节」做上传缓存键 */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheKey(endpoint: Endpoint, absPath: string, stat: { mtimeMs: number; size: number }): string {
  return `${endpoint.id}\u0000${absPath}\u0000${stat.mtimeMs}\u0000${stat.size}`;
}

/** 内存来源的缓存键：没有路径与 mtime，改用内容哈希（同一张图不会重复上传） */
function contentCacheKey(endpoint: Endpoint, hash: string): string {
  return `${endpoint.id}\u0000sha256:${hash}`;
}

function rememberUpload(key: string, fileId: string): void {
  uploadCache.set(key, fileId);
  while (uploadCache.size > UPLOAD_CACHE_LIMIT) {
    const oldest = uploadCache.keys().next();
    if (oldest.done) break;
    uploadCache.delete(oldest.value);
  }
}

/** 默认上传实现：OpenAI 兼容的 `POST {baseUrl}/files`（`purpose=user_data`） */
const defaultUpload: UploadFn = async ({ endpoint, data, filename, signal }) => {
  const client = new OpenAI({ apiKey: endpoint.apiKey, baseURL: endpoint.baseUrl });
  const file = await toFile(Buffer.from(data), filename);
  const uploaded = await client.files.create({ file, purpose: "user_data" }, { signal });
  return uploaded.id;
};

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function textSection(text: string): AgentNS.MessageContentSection {
  return { type: "text", text };
}

/**
 * 把文件转成内容块。
 *
 * 抛错场景（均由调用方决定如何呈现给模型）：
 * - `source.url` 不是 http(s)（本地 URL 服务商访问不到）
 * - 本地文件不存在 / 不是文件 / 扩展名不支持
 * - 需要内联但体积超过上限，且端点不支持上传
 */
export async function fileToContentSection(input: FileToSectionInput): Promise<FileToSectionResult> {
  const { source, endpoint, model, signal } = input;
  const maxInline = input.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;

  // ---- 1. 网络 URL：直接引用，不经上传/内联 ----
  if ("url" in source) {
    if (!isRemoteUrl(source.url)) {
      throw new Error(
        `不支持本地 URL（${source.url}）：API 服务商无法访问。本地文件请传文件路径，而不是本地链接。`,
      );
    }
    return {
      section: { type: "image_url", image_url: { url: source.url } },
      transport: "url",
      bytes: 0,
    };
  }

  // ---- 2. 取得字节与 MIME ----
  // 已经是 base64 的来源（MCP）：先不解码，内联时原样透传，只有真要上传/算哈希时才解码
  let base64: string | null = null;
  let bytes: Uint8Array | null = null;
  let byteLength: number;
  let mime: string;
  let filename: string;
  let absPath: string | null = null;
  let stat: { mtimeMs: number; size: number } | null = null;

  if ("path" in source) {
    absPath = path.isAbsolute(source.path) ? source.path : path.resolve(source.path);
    const st = await fs.stat(absPath);
    if (!st.isFile()) throw new Error(`"${absPath}" 不是文件。`);
    const inferred = mimeOf(absPath);
    if (!inferred) {
      throw new Error(`不支持的文件类型："${absPath}"（已知类型：${Object.keys(MIME_BY_EXT).join(" ")}）`);
    }
    mime = inferred;
    stat = { mtimeMs: st.mtimeMs, size: st.size };
    bytes = new Uint8Array(await fs.readFile(absPath));
    byteLength = bytes.byteLength;
    filename = path.basename(absPath);
  } else if ("base64" in source) {
    mime = source.mime;
    base64 = source.base64;
    byteLength = base64ByteLength(base64);
    filename = source.filename ?? "file";
  } else {
    mime = source.mime;
    bytes = source.data;
    byteLength = bytes.byteLength;
    filename = source.filename ?? "file";
  }

  /** 需要真实字节时才解码（上传、算内容哈希） */
  const ensureBytes = (): Uint8Array => {
    if (!bytes) bytes = new Uint8Array(Buffer.from(base64 ?? "", "base64"));
    return bytes;
  };

  const isImage = mime.startsWith("image/");

  // ---- 3. 模型看不见图：退化为文本提示 ----
  // 判定口径与 `ViewImageTool.isAvailable` 一致：只有 `vision === true` 才算视觉模型，
  // 缺省视为不支持（模型未提供 model 时不做判断，交给调用方）。
  // 对任何来源都生效（本地路径给路径，内存来源给文件名）：非视觉模型收到 image_url
  // 可能直接 4xx，宁可退化成一行提示。
  if (isImage && model && model.vision !== true) {
    const label = absPath ?? filename;
    return {
      section: textSection(`[图片] ${label}（当前模型不支持图片输入，如需查看请改用视觉模型）`),
      transport: "text",
      bytes: byteLength,
      warning: "当前模型不支持图片输入，已退化为文本提示",
    };
  }

  // ---- 4. 端点支持 Files API：上传（带缓存），失败降级内联 ----
  let warning: string | undefined;
  if (supportsFilesApi(endpoint) && endpoint?.apiKey) {
    const key = absPath && stat
      ? cacheKey(endpoint, absPath, stat)
      : contentCacheKey(endpoint, contentHash(ensureBytes()));
    const cached = uploadCache.get(key);
    if (cached) {
      return {
        section: { type: "file", file_id: cached },
        transport: "files-api",
        bytes: byteLength,
      };
    }
    try {
      const upload = input.deps?.upload ?? defaultUpload;
      const fileId = await upload({ endpoint, data: ensureBytes(), filename, signal });
      rememberUpload(key, fileId);
      return {
        section: { type: "file", file_id: fileId },
        transport: "files-api",
        bytes: byteLength,
      };
    } catch (error: any) {
      if (signal?.aborted) throw error;
      warning = `上传 Files API 失败，已改为 base64 内联：${error?.message ?? error}`;
    }
  }

  // ---- 5. 内联（base64 data URL）----
  if (byteLength > maxInline) {
    throw new Error(
      `文件体积 ${(byteLength / 1024 / 1024).toFixed(1)} MiB 超过内联上限 ` +
        `${(maxInline / 1024 / 1024).toFixed(1)} MiB，且端点未声明 Files API 能力` +
        `（capabilities.filesApi），无法发送。`,
    );
  }
  // base64 来源直接透传，不重新编码（保证字节级一致，也省一次编解码）
  const dataUrl = toDataUrl(base64 ?? Buffer.from(ensureBytes()).toString("base64"), mime);
  return {
    section: isImage
      ? { type: "image_url", image_url: { url: dataUrl } }
      : { type: "file", file_data: dataUrl, filename },
    transport: "inline",
    bytes: byteLength,
    warning,
  };
}
