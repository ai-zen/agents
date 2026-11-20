/**
 * 上传分片的**二进制帧**（`asset.chunk`）的编解码。
 *
 * 形状与宿主 `packages/host/src/net/UploadReceiver.ts` 的 `encodeChunkFrame` / `decodeChunkFrame`
 * 逐字节一致：
 *
 * ```
 * | 4 字节大端无符号整数 N | N 字节 UTF-8 JSON 头 {"uploadId": "..."} | 若干字节片段 |
 * ```
 *
 * ## 为什么在客户端库里也要有一份
 *
 * 宿主那一份是运行期实现，客户端包不能 import 它（那个包的包根会把整个宿主拉进产物）。
 * 而帧的形状是**两侧共同的约定**：各自写一份编码器迟早会差一个字段，出错的表现又是「宿主说
 * 帧坏了」这种离现场很远的抱怨。所以编码与解码都收在这一个文件里。
 *
 * 头里带 `uploadId` 而不是「一条连接同时只有一个上传」：一次拖进四张图就是四个并发的上传，
 * `uploadId` 是它们之间唯一的区分。头做成「长度前缀 + JSON」而不是定长二进制 id，是为了让帧在
 * 抓包与日志里仍然可读，也不绑定 `uploadId` 的编码方式。
 */

/** 帧头里那个长度字段占多少字节（大端无符号整数） */
export const CHUNK_HEADER_LENGTH_BYTES = 4;

/** 头部 JSON 的长度上限（与宿主同口径：防一个坏帧声称自己有 4GB 的头） */
const HEADER_LIMIT_BYTES = 4096;

/** 拼一帧：头（`{"uploadId":"..."}`）+ 片段字节 */
export function encodeChunkFrame(uploadId: string, chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(JSON.stringify({ uploadId }));
  const frame = new Uint8Array(CHUNK_HEADER_LENGTH_BYTES + header.byteLength + chunk.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, CHUNK_HEADER_LENGTH_BYTES);
  frame.set(chunk, CHUNK_HEADER_LENGTH_BYTES + header.byteLength);
  return frame;
}

/**
 * 拆一帧：解出上传句柄与片段。
 *
 * 坏帧抛 `Error` 而不是 `ClientError`：这个函数在客户端这一侧只有两种用法 —— 用例里检查
 * 「写出去的字节长什么样」，以及调试工具里回看抓到的帧。坏帧在那里是**断言失败**，不是一次
 * 可以展示给用户的失败。真正的拒绝归宿主，它的话由 `ClientError` 原样带回来。
 */
export function decodeChunkFrame(frame: Uint8Array): { uploadId: string; chunk: Uint8Array } {
  if (frame.byteLength < CHUNK_HEADER_LENGTH_BYTES) {
    throw new Error(`上传分片帧太短：${frame.byteLength} 字节`);
  }
  // DataView 要带上 byteOffset：`frame` 可能是别的大缓冲上的一个视图
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    0,
    false,
  );
  if (headerLength === 0 || headerLength > HEADER_LIMIT_BYTES) {
    throw new Error(`上传分片帧的头长度不合法：${headerLength}`);
  }
  if (CHUNK_HEADER_LENGTH_BYTES + headerLength > frame.byteLength) {
    throw new Error(`上传分片帧的头被截断：声明 ${headerLength} 字节`);
  }

  const headerBytes = frame.subarray(
    CHUNK_HEADER_LENGTH_BYTES,
    CHUNK_HEADER_LENGTH_BYTES + headerLength,
  );
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
  } catch {
    throw new Error("上传分片帧的头不是 JSON");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new Error("上传分片帧的头不是一个对象");
  }
  const uploadId = (header as Record<string, unknown>).uploadId;
  if (typeof uploadId !== "string" || uploadId.trim() === "") {
    throw new Error("上传分片帧的头里没有 uploadId");
  }
  return {
    uploadId: uploadId.trim(),
    chunk: frame.subarray(CHUNK_HEADER_LENGTH_BYTES + headerLength),
  };
}
