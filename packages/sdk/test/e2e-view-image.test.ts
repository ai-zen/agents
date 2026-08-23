/**
 * viewImage 端到端测试（需真实 DeepSeek API Key）。
 *
 * 覆盖两条真实链路：
 *   1. 工具链路：ViewImageTool 直接调用 → 本地图片经 Files API 上传 → file 内容块（retrieve 验证有效）
 *   2. Agent 链路：视觉模型 Agent 主动调用 viewImage 查看本地图片并描述内容
 *
 * 测试图片为测试内实时生成的简单 PNG（白底红圆，Node zlib 编码），
 * 自包含、无二进制资源、不依赖网络下载。
 *
 * 运行方式：
 *   npm test -- --testPathPattern "test/e2e-view-image"
 *
 * 跳过条件：未设置 DEEPSEEK_API_KEY 时自动跳过。
 */

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import { deflateSync } from "node:zlib";
import OpenAI from "openai";
import { Provider } from "../src/runtime/Provider";
import { createModel } from "../src/runtime/createModel";
import { SdkAgent } from "../src/runtime/SdkAgent";
import { ViewImageTool } from "../src/capabilities/implements/builtin/ViewImageTool";
import { BUILTIN_TOOL_CLASSES } from "../src/capabilities/implements/builtin/index";

// ---------------------------------------------------------------------------
// 简单图片生成（白底 + 红色实心圆，PNG）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成一张简单 PNG：size×size，白色背景 + 中心红色实心圆 */
function createRedCirclePng(size = 96, radius = 38): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 原始像素：每行前缀 1 字节 filter(0) + RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const r2 = radius * radius;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inside = dx * dx + dy * dy <= r2;
      const idx = rowStart + 1 + x * 3;
      if (inside) {
        raw[idx] = 220;
        raw[idx + 1] = 30;
        raw[idx + 2] = 30; // red
      } else {
        raw[idx] = 255;
        raw[idx + 1] = 255;
        raw[idx + 2] = 255; // white
      }
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 写一张简单图片到临时目录，返回绝对路径 */
async function writeTempImage(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "viewimg-e2e-"));
  const imgPath = join(dir, "red-circle.png");
  await fs.writeFile(imgPath, createRedCirclePng());
  return imgPath;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const skip = !API_KEY;

const VISION_MODEL_ID = "deepseek-v4-flash-vision-exp";

const config = {
  defaultModel: VISION_MODEL_ID,
  endpoints: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: API_KEY,
    },
  ],
  models: [
    {
      id: VISION_MODEL_ID,
      name: "DeepSeek V4 Flash Vision Exp",
      endpointId: "deepseek",
      modelName: VISION_MODEL_ID,
      maxContextTokens: 128_000,
      defaultParams: {},
      vision: true,
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      endpointId: "deepseek",
      modelName: "deepseek-v4-flash",
      maxContextTokens: 128_000,
      defaultParams: {},
    },
  ],
};

const provider = new Provider({
  config,
  agentsDir: join(tmpdir(), "ai-zen-e2e-view-image", "agents"),
});

const DEFINITION = (modelId: string, id: string, name: string) => ({
  id,
  name,
  messages: [
    {
      role: "system" as const,
      content:
        "你是一个视觉助手。查看图片后，用中文简洁描述图片中的颜色和形状，不要多余解释。",
    },
  ],
  modelId,
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe.runIf(!skip)("viewImage 端到端（真实 DeepSeek API）", () => {
  // Provider 装配用例依赖 builtinTools 候选集，先 init 填充
  beforeAll(async () => {
    await provider.init();
  });

  it("Provider 装配：仅视觉模型注入 viewImage", () => {
    // 视觉模型 → 工具列表含 viewImage
    const visionTools = provider.buildTools(DEFINITION(VISION_MODEL_ID, "v", "V"));
    expect(visionTools.map((t) => t.function.name)).toContain("viewImage");

    // 非视觉模型 → 不含 viewImage
    const textTools = provider.buildTools(
      DEFINITION("deepseek-v4-flash", "t", "T"),
    );
    expect(textTools.map((t) => t.function.name)).not.toContain("viewImage");
  });

  it("工具链路：本地简单图片经 Files API 上传并返回有效 file 块", async () => {
    const imgPath = await writeTempImage();
    try {
      // 从 BUILTIN_TOOL_CLASSES 装配（走真实 env）
      const tool = BUILTIN_TOOL_CLASSES.map(
        (Cls) => new Cls(provider.env),
      ).find((t) => t.function.name === "viewImage") as ViewImageTool;

      const result = await tool.call({ path_or_url: imgPath });
      expect(Array.isArray(result)).toBe(true);

      const sections = result as Array<Record<string, unknown>>;
      const fileSection = sections.find((s) => s.type === "file") as
        | { file_id: string }
        | undefined;
      expect(fileSection).toBeDefined();
      expect(fileSection!.file_id).toMatch(/^file-/);

      // 用官方 SDK 验证 file_id 真实有效
      const client = new OpenAI({
        apiKey: API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      });
      const remote = await client.files.retrieve(fileSection!.file_id);
      expect(remote.id).toBe(fileSection!.file_id);
      expect(remote.filename).toBe("red-circle.png");

      // text 块应提到 file_id
      const text = sections
        .filter((s) => s.type === "text")
        .map((s) => s.text)
        .join("\n");
      expect(text).toContain(fileSection!.file_id);
    } finally {
      await fs.rm(join(imgPath, ".."), { recursive: true, force: true });
    }
  }, 30_000);

  it("Agent 链路：视觉 Agent 调用 viewImage 查看本地图片并描述内容", async () => {
    const imgPath = await writeTempImage();
    try {
      const model = createModel(provider, VISION_MODEL_ID);
      const viewImageTool = BUILTIN_TOOL_CLASSES.map(
        (Cls) => new Cls(provider.env),
      ).find((t) => t.function.name === "viewImage")!;

      const agent = new SdkAgent({
        provider,
        definition: DEFINITION(VISION_MODEL_ID, "view-test", "View Test"),
        client: model.client,
        model: model.model,
        modelConfig: model.modelConfig,
        messages: [
          {
            role: "system",
            content:
              "你是一个视觉助手。必须使用 viewImage 工具查看用户给出的图片路径，然后用中文描述图片中的颜色和形状。",
          },
        ],
        tools: [viewImageTool],
      });

      const messages = await agent.send(
        `请使用 viewImage 工具查看这张图片：${imgPath}，然后告诉我图片的内容。`,
      );

      // 1. 链路完整性：消息历史中应出现 viewImage 工具调用与工具结果
      const toolCalled = messages.some(
        (m) =>
          m.role === "assistant" &&
          m.tool_calls?.some((tc) => tc.function?.name === "viewImage"),
      );
      const hasToolResult = messages.some(
        (m) => m.role === "tool" || m.role === "function",
      );
      expect(toolCalled).toBe(true);
      expect(hasToolResult).toBe(true);

      // 2. 最终回复非空且描述了图片内容（红色圆形）
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      const content = typeof lastMsg.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg.content);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toMatch(/红|圆|red|circle/i);
      console.log("视觉回复:", content.slice(0, 200));
    } finally {
      await fs.rm(join(imgPath, ".."), { recursive: true, force: true });
    }
  }, 90_000);
});

// 无 API Key 时的占位测试
describe.skipIf(!skip)("viewImage 端到端（跳过 — 未配置 API Key）", () => {
  it("占位", () => {
    expect(true).toBe(true);
  });
});
