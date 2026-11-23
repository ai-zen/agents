import { describe, it, expect } from "vitest";
import { imageSizeOf } from "./imageSize.js";

/**
 * 只造文件头：被测函数只读头部，不需要真的能解码。
 *
 * 每个构造器都按格式规范把「宽高在哪儿」摆对，其余字节留零 —— 造出错位的头，用例就变成在验
 * 构造器而不是验读法。
 */

function writeU16BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32BE(out, 8, 13); // IHDR 块长度
  out.set(ascii("IHDR"), 12);
  writeU32BE(out, 16, width);
  writeU32BE(out, 20, height);
  return out;
}

function jpeg(width: number, height: number): Uint8Array {
  const out = new Uint8Array(21);
  out.set([0xff, 0xd8], 0); // SOI
  out.set([0xff, 0xc0, 0x00, 0x11, 0x08], 2); // SOF0，段长 17，精度 8
  writeU16BE(out, 7, height);
  writeU16BE(out, 9, width);
  out.set([0x03], 11); // 三个分量（后面补零，读尺寸用不到）
  return out;
}

/** 前面垫一个 APP0 段：真 JPEG 几乎都有，读法必须能跳过去 */
function jpegWithApp0(width: number, height: number): Uint8Array {
  const app0 = new Uint8Array(18);
  app0.set([0xff, 0xe0, 0x00, 0x10], 0);
  app0.set(ascii("JFIF\0"), 4);
  const sof = jpeg(width, height);
  // SOI 仍在最前面：SOI + APP0 + SOF0
  const out = new Uint8Array(2 + app0.length + sof.length - 2);
  out.set([0xff, 0xd8], 0);
  out.set(app0, 2);
  out.set(sof.subarray(2), 2 + app0.length);
  return out;
}

function gif(width: number, height: number): Uint8Array {
  const out = new Uint8Array(13);
  out.set(ascii("GIF89a"), 0);
  out[6] = width & 0xff;
  out[7] = (width >>> 8) & 0xff;
  out[8] = height & 0xff;
  out[9] = (height >>> 8) & 0xff;
  return out;
}

function webpChunk(fourcc: string, payload: number[]): Uint8Array {
  const out = new Uint8Array(20 + payload.length);
  out.set(ascii("RIFF"), 0);
  writeU32BE(out, 4, 4 + 8 + payload.length);
  out.set(ascii("WEBP"), 8);
  out.set(ascii(fourcc), 12);
  writeU32BE(out, 16, payload.length);
  out.set(payload, 20);
  return out;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const payload = [0x00, 0x00, 0x00, 0x00]; // 标志 + 三个保留字节
  const w = width - 1;
  const h = height - 1;
  payload.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff);
  payload.push(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff);
  return webpChunk("VP8X", payload);
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return webpChunk("VP8L", [
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ]);
}

function webpVp8(width: number, height: number): Uint8Array {
  return webpChunk("VP8 ", [
    0x00,
    0x00,
    0x00, // 3 字节帧标签
    0x9d,
    0x01,
    0x2a, // 同步码
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
  ]);
}

describe("imageSizeOf：四种格式的宽高", () => {
  it("PNG 从 IHDR 里读两个 32 位大端", () => {
    expect(imageSizeOf(png(9000, 100))).toEqual({ width: 9000, height: 100 });
  });

  it("JPEG 从 SOFn 里读，能跳过前面的 APPn 段", () => {
    expect(imageSizeOf(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSizeOf(jpegWithApp0(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("GIF 从逻辑屏幕描述符里读两个 16 位小端", () => {
    expect(imageSizeOf(gif(320, 200))).toEqual({ width: 320, height: 200 });
  });

  it("WebP 的三个变体各读各的", () => {
    expect(imageSizeOf(webpVp8x(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageSizeOf(webpVp8l(1234, 567))).toEqual({ width: 1234, height: 567 });
    expect(imageSizeOf(webpVp8(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("WebP 的宽高是「值 + 1」，1×1 也要读对", () => {
    expect(imageSizeOf(webpVp8x(1, 1))).toEqual({ width: 1, height: 1 });
    expect(imageSizeOf(webpVp8l(1, 1))).toEqual({ width: 1, height: 1 });
  });
});

describe("imageSizeOf：认不出来就说不知道", () => {
  it("别的格式、空字节、半个头都返回 undefined", () => {
    expect(imageSizeOf(new Uint8Array(ascii("%PDF-1.7")))).toBeUndefined();
    expect(imageSizeOf(new Uint8Array(0))).toBeUndefined();
    expect(imageSizeOf(png(100, 100).subarray(0, 12))).toBeUndefined();
    expect(imageSizeOf(jpeg(100, 100).subarray(0, 5))).toBeUndefined();
  });

  it("PNG 签名对但 IHDR 不在该在的位置：也当不知道", () => {
    const broken = png(100, 100);
    broken.set(ascii("XXXX"), 12);
    expect(imageSizeOf(broken)).toBeUndefined();
  });
});
