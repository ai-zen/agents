/**
 * 本地文件 → 消息内容块的唯一转换入口。
 *
 * 调用方只提供「文件 + 当前端点/模型」，传输方式由本模块决定：
 *
 * | 条件 | 结果 |
 * |------|------|
 * | http(s) URL | 直接 `image_url`（不上传、不内联） |
 * | 端点声明 `capabilities.filesApi` 且有 `apiKey` | 上传 Files API → `file` 块（`file_id`）；上传失败即抛，不换传输方式 |
 * | 其余端点 + 图片 | `image_url` + base64 data URL |
 * | 其余端点 + 非图片 | `file` 块 + `file_data`（base64 data URL） |
 * | 图片且模型不是视觉模型（`vision !== true`） | 退化为 `text`，只给路径提示 |
 * | 图片任一边超过 {@link MAX_IMAGE_EDGE} | 抛错（不把超大图丢给端点） |
 * | 内联体积超过上限且无法上传 | 抛错（不静默塞进请求体） |
 *
 * 本模块只负责**选路**与**上传这一个 HTTP 动作**：需要 `file_id` 时每次调用都真上传，
 * 不在进程里记「这个文件在这个端点上的 id 是什么」。要复用同一个 id 的是调用方 ——
 * 模块级 Map 这类记录既看不到（不可观测）、也扛不住重启，该由持有持久存储的一侧承担。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentNS } from "@ai-zen/agents-core";
import type {
  AppConfig,
  EndpointDefinition,
  ModelDefinition,
  ToolEnvDeps,
  UploadFn,
} from "../types/index.js";
import { imageSizeOf } from "./imageSize.js";

/** 上传函数类型（定义在 types，此处再导出方便既有引用） */
export type { UploadFn };

/** 图片任意一边的上限（像素）。超过它就不发，让调用方缩完再来 */
export const MAX_IMAGE_EDGE = 8192;

/** 读图片头时最多看这么多字节：四个格式的宽高都在这之内（JPEG 要跳过前面的 APPn 段） */
const IMAGE_HEAD_BYTES = 256 * 1024;

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

export interface FileToSectionInput {
  source: FileSource;
  /** 当前模型所用端点：决定能否走 Files API */
  endpoint?: EndpointDefinition | null;
  /** 当前模型：`vision === false` 时图片退化为文本提示 */
  model?: ModelDefinition | null;
  signal?: AbortSignal;
  /** 覆盖内联体积上限 */
  maxInlineBytes?: number;
  /** 依赖注入（测试 / 宿主用），缺省走 OpenAI SDK 的 Files API */
  deps?: ToolEnvDeps;
}

export interface FileToSectionResult {
  section: AgentNS.MessageContentSection;
  transport: ContentTransport;
  /** 实际处理的字节数（URL 来源为 0） */
  bytes: number;
  /**
   * 退化为文本提示时的人类可读说明，供上层拼提示。
   *
   * 唯一产生者是下面「模型看不见图 → 退化为文本」那一支（上传失败直接抛错，不走这里）。
   */
  warning?: string;
}

/**
 * 由「发给 API 的模型名」反查它绑定的模型定义与端点。
 *
 * 工具在 `call()` 阶段拿不到 Agent 定义，但 `ctx.agent.model` 就是发给 API 的
 * 模型名（`ModelDefinition.modelName ?? ModelDefinition.id`）。必须按**当前实际使用的模型**定位端点：
 * `file_id` 是端点维度资源，传错端点会得到 not found。
 */
export function resolveModelAndEndpoint(
  config: AppConfig,
  apiModelName?: string,
): { model?: ModelDefinition; endpoint?: EndpointDefinition | null } {
  const models = config.models ?? [];
  const endpoints = config.endpoints ?? [];
  const findEndpoint = (id?: string) => (id ? (endpoints.find((e) => e.id === id) ?? null) : null);

  const byApiName = apiModelName
    ? models.find((m) => (m.modelName ?? m.id) === apiModelName)
    : undefined;
  if (byApiName) return { model: byApiName, endpoint: findEndpoint(byApiName.endpointId) };

  return { endpoint: null };
}

/** 端点是否声明了 Files API 能力 */
export function supportsFilesApi(endpoint?: EndpointDefinition | null): boolean {
  return endpoint?.capabilities?.filesApi === true;
}

/** 内容哈希（sha256）；调用方想按内容去重时可以拿它当键 */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 默认上传实现：OpenAI 兼容的 `POST {baseUrl}/files`（`purpose=user_data`）。
 *
 * 用原生 `fetch` + `FormData`，不用 `openai` 包：这里要的只是「发一个 multipart、读回
 * `id`」，而那 20 MB 的 SDK 会随着本模块的**静态 import** 进入任何打包它的人的产物 ——
 * CLI 只为了粘贴一张图就得背上它。原生实现没有这个代价，HTTP 上完全等价。
 */
const defaultUpload: UploadFn = async ({ endpoint, data, filename, signal }) => {
  // 拷一份：`data` 的类型是 `Uint8Array<ArrayBufferLike>`，而 `BlobPart` 只收
  // `ArrayBuffer` 支撑的（TS 5.7 起两者不再互相兼容）。上传是一次性的，拷一次
  // 相对一次网络往返可以忽略。
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);

  const form = new FormData();
  form.append("purpose", "user_data");
  form.append(
    "file",
    new Blob([bytes], { type: mimeOf(filename) ?? "application/octet-stream" }),
    filename,
  );
  const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.apiKey}` },
    body: form,
    signal,
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
 * - 端点声明了 Files API 但上传失败（HTTP 非 2xx、网络错误、取消）：不换成 base64 内联，
 *   原错误原样抛——换传输方式是调用方该知道的事，不该在这里静默发生
 * - 需要内联但体积超过上限，且端点不支持上传
 */
export async function fileToContentSection(
  input: FileToSectionInput,
): Promise<FileToSectionResult> {
  const { source, endpoint, model, signal } = input;
  const maxInline = input.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;

  // ---- 1. 网络 URL：直接引用，不经上传/内联 ----
  if ("url" in source) {
    if (!isRemoteUrl(source.url)) {
      throw new Error(
        `Unsupported local URL (${source.url}): the API provider cannot access it. For local files pass a file path, not a local link`,
      );
    }
    return {
      section: { type: "image_url", image_url: { url: source.url } },
      transport: "url",
      bytes: 0,
    };
  }

  // ---- 2. 取得字节与 MIME ----
  // 已经是 base64 的来源（MCP）：先不解码，内联时原样透传，只有真要上传时才解码
  let base64: string | null = null;
  let bytes: Uint8Array | null = null;
  let byteLength: number;
  let mime: string;
  let filename: string;
  let absPath: string | null = null;

  if ("path" in source) {
    absPath = path.isAbsolute(source.path) ? source.path : path.resolve(source.path);
    const st = await fs.stat(absPath);
    if (!st.isFile()) throw new Error(`"${absPath}" is not a file`);
    const inferred = mimeOf(absPath);
    if (!inferred) {
      throw new Error(
        `Unsupported file type: "${absPath}" (known types: ${Object.keys(MIME_BY_EXT).join(" ")})`,
      );
    }
    mime = inferred;
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

  /** 需要真实字节时才解码（上传） */
  const ensureBytes = (): Uint8Array => {
    if (!bytes) bytes = new Uint8Array(Buffer.from(base64 ?? "", "base64"));
    return bytes;
  };

  /**
   * 看尺寸用的那几个字节。
   *
   * 四个格式的宽高都在文件头部，所以 base64 来源只解前 {@link IMAGE_HEAD_BYTES} 字节对应的那一段
   * —— 一张 20 MiB 的图不该为了读 24 个字节先整张解码。解不出尺寸时 `imageSizeOf` 返回
   * `undefined`，调用方按「不知道」放过。
   */
  const headBytes = (): Uint8Array => {
    if (bytes) return bytes.subarray(0, IMAGE_HEAD_BYTES);
    // base64 每 4 个字符对 3 个字节，多取一点保证够
    const chars = Math.min((base64 ?? "").length, Math.ceil((IMAGE_HEAD_BYTES * 4) / 3));
    return new Uint8Array(Buffer.from((base64 ?? "").slice(0, chars), "base64"));
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
      section: textSection(
        `[Image] ${label} (the current model does not support image input; use a vision-capable model to view it)`,
      ),
      transport: "text",
      bytes: byteLength,
      warning: "The current model does not support image input; degraded to a text hint",
    };
  }

  // ---- 3.5 图片的宽高有上限：超了就不发 ----
  // 只在真要发图的时候判：非视觉模型那一条上面已经退化成一句提示，图根本不出门。
  // 读头只要前几十字节；base64 来源也只解这一小段，不必把整张图解码。
  if (isImage) {
    const size = imageSizeOf(headBytes());
    if (size !== undefined && (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE)) {
      throw new Error(
        `Image ${size.width}×${size.height} exceeds the ${MAX_IMAGE_EDGE} px limit on either side ` +
          `("${absPath ?? filename}"); scale it down and pass it again`,
      );
    }
  }

  // ---- 4. 端点支持 Files API：上传（每次调用都真上传），失败原样抛 ----
  if (supportsFilesApi(endpoint) && endpoint?.apiKey) {
    const upload = input.deps?.upload ?? defaultUpload;
    const fileId = await upload({ endpoint, data: ensureBytes(), filename, signal });
    return {
      section: { type: "file", file_id: fileId },
      transport: "files-api",
      bytes: byteLength,
    };
  }

  // ---- 5. 内联（base64 data URL）----
  if (byteLength > maxInline) {
    throw new Error(
      `File size ${(byteLength / 1024 / 1024).toFixed(1)} MiB exceeds the inline limit of ` +
        `${(maxInline / 1024 / 1024).toFixed(1)} MiB and the endpoint does not declare the Files API capability ` +
        `(capabilities.filesApi), so it cannot be sent`,
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
  };
}
