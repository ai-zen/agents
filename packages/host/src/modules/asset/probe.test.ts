/**
 * 三条验收：PNG 量得出、JPEG 量得出、认不出的时候是 `undefined`。
 *
 * 第三条是这个模块的**全部难度**：它只读文件头，所以「字节不够」「结构对不上」是常态而不是
 * 异常 —— 报错或重试都会让一张本来能用（只是排不了版）的图传不上来。用例里的字节都是手搓的
 * 最小样本，不依赖任何图片文件。
 */

import { describe, expect, it } from "vitest";

import { probeImageSize } from "./probe.js";

/** PNG 的 24 字节头：签名 + 块头 + IHDR 里的宽高（再往后是 CRC，量尺寸用不到） */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8); // IHDR 的块长固定 13
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  writeUint32(bytes, 16, width);
  writeUint32(bytes, 20, height);
  return bytes;
}

/**
 * JPEG 头：SOI + 一个 APP0 段（用来验「顺着段链跳」）+ SOF0 段。
 *
 * APP0 的长度写在段里（16），跳过它靠的就是这一个数 —— 不跳的话 `SOFn` 永远找不到。
 */
function jpegHeader(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0x00)];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11, // 段长 17
    0x08, // 精度 8 位
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // 三个分量
    ...new Array<number>(9).fill(0x00),
  ];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof0]);
}

function writeUint32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >> 24) & 0xff;
  bytes[at + 1] = (value >> 16) & 0xff;
  bytes[at + 2] = (value >> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

describe("probeImageSize", () => {
  it("PNG：从 IHDR 里读出宽高", () => {
    expect(probeImageSize(pngHeader(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("JPEG：跳过 APP0、在 SOF0 段里读出宽高", () => {
    expect(probeImageSize(jpegHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("认不出的字节：`undefined`，不猜也不抛", () => {
    // 一段确定不是图片的字节（也不是 PNG / JPEG 的签名）
    const random = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 11) % 256);
    expect(probeImageSize(random)).toBeUndefined();
    expect(probeImageSize(new Uint8Array(0))).toBeUndefined();
    expect(probeImageSize(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeUndefined();
  });

  it("PNG 签名但长度不够：`undefined`（不够 24 字节就不去读 IHDR）", () => {
    expect(probeImageSize(pngHeader(10, 10).slice(0, 23))).toBeUndefined();
  });

  it("JPEG 头但第一段不是帧头、段链又断了：`undefined`", () => {
    // SOI + 一个声明长度超出字节范围的段：跳出去就不再往下猜
    expect(
      probeImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00])),
    ).toBeUndefined();
  });
});
