/**
 * 图片尺寸解码的验收：PNG（IHDR）、JPEG（SOF 段）读出真值，其余情形回 `null`。
 *
 * 造字节的帮手只写「解尺寸要看的那几处」：签名、块头 / 段头与宽高字段，后面的图像数据
 * 与校验和对解码没有意义，所以留零。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, type TempDir } from "../net/TestSupport.js";
import { IMAGE_HEAD_BYTES, readImageSize, readImageSizeFromFile } from "./imageSize.js";

/** 一份 33 字节的 PNG 头：8 签名 + IHDR 块（长 13、类型 "IHDR"、宽高、位深 / 颜色类型） */
function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; // 位深
  buffer[25] = 2; // 颜色类型（真彩色）
  return buffer;
}

/**
 * 一份 JPEG：`SOI` + 一段 APP1（16 字节数据，模拟 EXIF）+ 帧头段 + `SOS`。
 *
 * 帧头段按真实布局写：长 17、精度 8、高 2 字节、宽 2 字节、分量数 3。
 */
function jpegBytes(
  width: number,
  height: number,
  options: { marker?: number; frameBeforeApp?: boolean } = {},
): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  const app = Buffer.alloc(4 + 16);
  app[0] = 0xff;
  app[1] = 0xe1;
  app.writeUInt16BE(18, 2); // 段长含它自己那两字节
  app.write("Exif", 4, "latin1");

  const frame = Buffer.alloc(4 + 15);
  frame[0] = 0xff;
  frame[1] = options.marker ?? 0xc0;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8; // 精度
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3; // 分量数

  if (options.frameBeforeApp === true) parts.push(frame, app);
  else parts.push(app, frame);

  // SOS 之后是扫描数据：解尺寸不该走到这里
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0x00]));
  return Buffer.concat(parts);
}

describe("readImageSize", () => {
  it("PNG：从 IHDR 读出 120×80", () => {
    expect(readImageSize(pngBytes(120, 80))).toEqual({ width: 120, height: 80 });
  });

  it("PNG：大尺寸（uint32 高位）也照读", () => {
    expect(readImageSize(pngBytes(4096, 2160))).toEqual({ width: 4096, height: 2160 });
  });

  it("JPEG（SOF0）：跳过前面的 APP1 段，读出 120×80", () => {
    expect(readImageSize(jpegBytes(120, 80))).toEqual({ width: 120, height: 80 });
  });

  it("JPEG（SOF1 / SOF2，渐进式也是这几种段）同样读得出", () => {
    expect(readImageSize(jpegBytes(64, 32, { marker: 0xc1 }))).toEqual({ width: 64, height: 32 });
    expect(readImageSize(jpegBytes(64, 32, { marker: 0xc2 }))).toEqual({ width: 64, height: 32 });
  });

  it("JPEG：段长不对（0）时不往下读，回 null", () => {
    const broken = jpegBytes(120, 80);
    broken.writeUInt16BE(0, 4); // APP1 的段长改成 0
    expect(readImageSize(broken)).toBeNull();
  });

  it("JPEG：帧头段之前就到 SOS（没有尺寸信息），回 null", () => {
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it("非图片字节回 null", () => {
    const text = Buffer.from("这不是图片，只是一段文字。", "utf8");
    expect(readImageSize(text)).toBeNull();
    expect(readImageSize(Buffer.alloc(0))).toBeNull();
  });

  it("认得的容器之外的格式（GIF / WebP）回 null", () => {
    expect(readImageSize(Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1"))).toBeNull();
    expect(
      readImageSize(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])),
    ).toBeNull();
  });

  it("截断的 PNG（只到签名与块头）回 null", () => {
    expect(readImageSize(pngBytes(120, 80).subarray(0, 20))).toBeNull();
  });

  it("截断的 JPEG（帧头段只到了高、没到宽）回 null", () => {
    const full = jpegBytes(120, 80);
    // SOI(2) + APP1(20) + 帧头段头(4) + 精度(1) + 高(2)：宽还没进来
    expect(readImageSize(full.subarray(0, 29))).toBeNull();
  });

  it("宽高为 0 的 PNG 当作解不出来（位置读错才会出现）", () => {
    expect(readImageSize(pngBytes(0, 80))).toBeNull();
  });
});

describe("readImageSizeFromFile", () => {
  let dir: TempDir | undefined;

  afterEach(async () => {
    await dir?.remove();
    dir = undefined;
  });

  it("读文件的头一段就能解码，不要求整份文件进内存", async () => {
    dir = await makeTempDir("image-size");
    const path = join(dir.path, "big.png");
    // 头 + 远大于文件头窗口的其余字节：解码只看开头
    const padding = Buffer.alloc(IMAGE_HEAD_BYTES * 2, 0x42);
    await fs.writeFile(path, Buffer.concat([pngBytes(120, 80), padding]));

    expect(await readImageSizeFromFile(path)).toEqual({ width: 120, height: 80 });
  });

  it("文件不存在时回 null（不抛）", async () => {
    dir = await makeTempDir("image-size");
    expect(await readImageSizeFromFile(join(dir.path, "missing.png"))).toBeNull();
  });

  it("空文件回 null", async () => {
    dir = await makeTempDir("image-size");
    const path = join(dir.path, "empty.png");
    await fs.writeFile(path, Buffer.alloc(0));
    expect(await readImageSizeFromFile(path)).toBeNull();
  });
});
