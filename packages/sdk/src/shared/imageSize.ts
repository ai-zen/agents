/**
 * 只从文件头部读出图片的宽高 —— 不解码、不引依赖。
 *
 * 为什么自己写：要判「宽或高超过上限」只需要几个字节，而为此拉一个图像库（native 的 sharp、
 * 或者纯 JS 但很大的 jimp）会给分发面加一笔长期账。四种格式的尺寸都在头部，读法固定：
 *
 * - PNG：IHDR 里两个 32 位大端；
 * - JPEG：SOFn 段里两个 16 位大端（要跳过前面的 APPn 段）；
 * - GIF：逻辑屏幕描述符里两个 16 位小端；
 * - WebP：三个变体各不一样（有损 VP8、无损 VP8L、扩展 VP8X）。
 *
 * 认不出就返回 `undefined`（不管）：这层只负责挡住正常情况，不当安全边界 —— 头坏掉、头跑出
 * 传入的字节范围，都交给下游端点去报它自己的错。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** 从字节里读宽高；四种格式之外、或者头不完整，返回 `undefined` */
export function imageSizeOf(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) return undefined;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return undefined;
  // 8..11 是块长度，12..15 必须是 "IHDR"
  if (readAscii(bytes, 12, 4) !== "IHDR") return undefined;
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** SOF0..SOF15，去掉 DHT（C4）、JPG（C8）、DAC（CC）这三个同段位的 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      // 段之间不该有别的字节；见到了就说明这不是本仓认得的 JPEG，不再猜
      return undefined;
    }
    let marker = bytes[i + 1]!;
    if (marker === 0xff) {
      // 填充字节：跳过，继续看下一个
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // 没有长度字段的那些标记
      i += 2;
      continue;
    }
    const segmentLength = readU16BE(bytes, i + 2);
    if (segmentLength < 2) return undefined;
    if (isStartOfFrame(marker)) {
      // 段内：长度(2) 精度(1) 高(2) 宽(2)
      if (i + 9 >= bytes.length) return undefined;
      const height = readU16BE(bytes, i + 5);
      const width = readU16BE(bytes, i + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    i += 2 + segmentLength;
  }
  return undefined;
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined;
  const signature = readAscii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
  // 容器头 20 字节：RIFF + 长度 + WEBP + 四字符块名 + 块长度
  if (bytes.length < 20) return undefined;
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") return undefined;

  const chunk = readAscii(bytes, 12, 4);
  // 三个变体的数据都从第 20 字节开始
  if (chunk === "VP8X") {
    // 1 字节标志 + 3 字节保留，之后各 3 字节的「宽-1」「高-1」
    if (bytes.length < 30) return undefined;
    const width = readU24LE(bytes, 24) + 1;
    const height = readU24LE(bytes, 27) + 1;
    return { width, height };
  }
  if (chunk === "VP8 ") {
    // 3 字节帧标签，然后同步码 9D 01 2A，之后两个 16 位小端（低 14 位是宽高）
    if (bytes.length < 30) return undefined;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    const width = readU16LE(bytes, 26) & 0x3fff;
    const height = readU16LE(bytes, 28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === "VP8L") {
    // 0x2F 之后 4 字节小端：低 14 位宽-1，再 14 位高-1（最小的无损文件就 25 字节）
    if (bytes.length < 25) return undefined;
    if (bytes[20] !== 0x2f) return undefined;
    const bits = readU32LE(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return undefined;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
}
