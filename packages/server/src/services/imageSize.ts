/**
 * 图片的像素尺寸：从文件头解出 `width` / `height`（PRD F-H8 / 裁定 R76）。
 *
 * 客户端拿到这两个数就能先摆好占位框，不必等字节下载完再量，图片加载时界面不会跳。
 *
 * 认的容器只有两种，各读一处现成的字段：
 *
 *   - **PNG**：8 字节签名之后第一个块就是 IHDR，它的第 4–11 字节是大端宽高；
 *   - **JPEG**：`SOI` 之后按段长逐段往后跳，碰到 `SOF0` / `SOF1` / `SOF2` 等帧头段就读它的高宽。
 *
 * 其它容器（以及截断、认不出的字节）回 `null`，尺寸这一栏就留空。
 *
 * {@link readImageSize} 是纯函数（Buffer 进、尺寸出），{@link readImageSizeFromFile} 负责把
 * 文件头读进来再交给它 —— 原图可能有 20MB（D5），这里只读开头一小段。
 */

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/** 像素尺寸 */
export interface ImageSize {
  width: number;
  height: number;
}

/** PNG 的 8 字节签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG 读到 IHDR 末尾需要的字节数（8 签名 + 4 块长 + 4 块类型 + 4 宽 + 4 高） */
const PNG_HEADER_BYTES = 24;

/**
 * 读文件头时取多少字节。
 *
 * PNG 的尺寸在头 24 字节里；JPEG 的帧头段前面可能排着 APP1（EXIF，里面还常带一张缩略图）
 * 这类段，几十 KB 的也见过。64 KiB 覆盖常见情况，又不会为了量尺寸把整份原图读进内存。
 */
export const IMAGE_HEAD_BYTES = 64 * 1024;

/**
 * 从文件头（前若干字节）解出像素尺寸；解不出来回 `null`。
 *
 * 入参可以是文件开头的一段，不要求是整份文件：两份解码都只往后读固定的几处字节，
 * 不够长（截断）时按「解不出来」处理。
 */
export function readImageSize(header: Buffer): ImageSize | null {
  return pngSize(header) ?? jpegSize(header);
}

/**
 * 读一个文件的头部字节，解出像素尺寸；打不开或解不出来都回 `null`。
 *
 * 这一步发生在素材已经改名落盘、登记入库之前，它的结论只影响 `assets.width` / `height`
 * 两列，所以读失败不往外抛：素材该落的照样落。
 */
export async function readImageSizeFromFile(absolutePath: string): Promise<ImageSize | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(absolutePath, "r");
    const head = Buffer.alloc(IMAGE_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, IMAGE_HEAD_BYTES, 0);
    return readImageSize(head.subarray(0, bytesRead));
  } catch {
    // 文件不存在 / 读不了：当作量不到，尺寸留空
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/**
 * PNG：签名 + 第一个块 IHDR 里的宽高（大端 uint32）。
 *
 * 签名对不上、第一块不是 IHDR（块长固定 13）、字节不够长，都回 `null`。
 */
function pngSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < PNG_HEADER_BYTES) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (buffer[index] !== PNG_SIGNATURE[index]) return null;
  }
  // 块长恒为 13、块类型恒为 "IHDR"：两处都对上才说明布局是 PNG 那一种
  if (buffer.readUInt32BE(8) !== 13) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return positiveSize(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** 一个标记占两字节：`FF` + 标记值 */
const MARKER_BYTES = 2;

/** 段长字段本身占两字节，所以合法的段长至少是 2 */
const MIN_SEGMENT_LENGTH = 2;

/** 帧头段（SOF）：段内顺序是精度(1) + 高(2) + 宽(2) + 分量数(1)… */
const SOF_DATA_BYTES = 5;

/** 帧头标记：C0–CF 里除了 C4（DHT）、C8（JPG）、CC（DAC）这三个非 SOF 的 */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG：从 `SOI` 开始按段长往后走，走到帧头段就取高宽。
 *
 * 段长让这里不必认每一个标记是什么意思（APPn / DQT / DHT 大小各不相同），跳过去就行。
 * 走上 `SOS`（扫描数据开始）说明帧头段已经错过，字节不够长说明文件被截断 —— 两种都回 `null`。
 */
function jpegSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    let marker = buffer[offset + 1];
    // 标记前面允许重复填 0xFF（编码器会这么写）
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= buffer.length) return null;
      marker = buffer[offset + 1];
    }
    // 不带长度字段的独立标记：TEM(01) / RSTn(D0–D7) / SOI(D8) / EOI(D9)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += MARKER_BYTES;
      continue;
    }
    // SOS(DA)：图像数据从这里开始，尺寸只能在前面的帧头段里
    if (marker === 0xda) return null;

    if (offset + 4 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < MIN_SEGMENT_LENGTH) return null;

    if (isFrameHeader(marker)) {
      const dataOffset = offset + 4;
      if (dataOffset + SOF_DATA_BYTES > buffer.length) return null;
      const height = buffer.readUInt16BE(dataOffset + 1);
      const width = buffer.readUInt16BE(dataOffset + 3);
      return positiveSize(width, height);
    }

    // 下一段 = 这一段的标记两字节 + 段长（段长从它自己那两字节算起）
    offset += MARKER_BYTES + segmentLength;
  }
  return null;
}

/** 宽高都要是正数；0 或负值只可能来自读错了位置，按「解不出来」处理 */
function positiveSize(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}
