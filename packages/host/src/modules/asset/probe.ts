/**
 * 从字节里量一次宽高（只认 PNG 与 JPEG 的文件头）；解不出就是 `undefined`，不重试、不告警。
 *
 * 「量不到就是空」是需求原话（`dev-docs/prd/09-attachments.md`「尺寸」那一行），**不是兜底**：
 * 尺寸只给界面排版用 —— 有了它，占位框能在图还没到的时候按比例撑开；没有它，界面按「未知」
 * 排一行就是了。为此去解码整张图（一张 4MB 的截图）、或者为一张认不出格式的文件报一次警，
 * 代价都比「这两个数字拿不到」大得多。
 *
 * 所以这里只读文件头：PNG 认签名之后的 IHDR，JPEG 顺着段链找到第一个 `SOFn`。别的格式、
 * 字节不够、结构对不上，一律 `undefined`。
 */
export function probeImageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  return probePng(bytes) ?? probeJpeg(bytes);
}

/** PNG 签名：8 个固定字节，IHDR 紧跟在它后面 */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `IHDR` 四个字节（偏移 12，块头里长度之后的块名） */
const PNG_IHDR: readonly number[] = [0x49, 0x48, 0x44, 0x52];

/**
 * PNG：8 字节签名 + 第一块 IHDR，宽度在偏移 16、高度在 20（大端 32 位）。
 *
 * 至少得 24 字节（签名 8 + 块长 4 + 块名 4 + 宽 4 + 高 4）；第一块不是 IHDR 就不当成 PNG ——
 * 规范要求它在那儿，不在就是结构对不上。
 */
function probePng(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (!matchesAt(bytes, 0, PNG_SIGNATURE)) return undefined;
  if (!matchesAt(bytes, 12, PNG_IHDR)) return undefined;

  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/**
 * JPEG：跳过段直到 `SOFn`（`0xFFC0`–`0xFFCF` 里除 `C4` / `C8` / `CC`），高度在段内偏移 5、
 * 宽度 7（大端 16 位，偏移从那个 `0xFF` 算起）。
 *
 * `C4`（DHT）/ `C8`（JPG）/ `CC`（DAC）与 `C0`–`CF` 共用这个号段，但它们不是帧头：里面同样
 * 位置的两个字节不是宽高，认错了会量出一个荒唐的数。
 *
 * 段链要顺着段长跳（`FF xx len16 payload`），跳出去就是结构不合约。`FF01` 与 `FFD0`–`FFD9`
 * 这些没有长度的独立标记单独跳两个字节，否则会把它们的标记号当段长。
 */
function probeJpeg(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 最小的一张也得有 SOI（FFD8）加一点东西
  if (bytes.length < 4) return undefined;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;

    // 填充字节：`0xFF` 可以重复出现，跳过它继续读真正的标记
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // 没有长度的独立标记：`TEM`（FF01）与 `RSTn` / `SOI` / `EOI`（FFD0–FFD9）
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    if (offset + 4 > bytes.length) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // 段长本身占两个字节，比 2 小的值不可能是长度
    if (length < 2) return undefined;

    if (isFrameHeader(marker)) {
      // 帧头段：精度 1 + 高 2 + 宽 2，从 `0xFF` 那个字节算起就是 9 个字节
      if (offset + 9 > bytes.length) return undefined;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width === 0 || height === 0) return undefined;
      return { width, height };
    }

    offset += 2 + length;
  }

  return undefined;
}

/** 帧头（`SOF0`–`SOF15`）里除去三个同名号段的「假帧头」，见 `probeJpeg` 的注释 */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function matchesAt(bytes: Uint8Array, at: number, expected: readonly number[]): boolean {
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[at + i] !== expected[i]) return false;
  }
  return true;
}

function readUint32(bytes: Uint8Array, at: number): number {
  // 最高那一位用乘法而不是 `<<`：`<<` 在 32 位上做有符号运算，高位一到就成负数
  return bytes[at]! * 0x1000000 + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
}
