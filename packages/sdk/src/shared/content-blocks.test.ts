import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_MAX_INLINE_BYTES,
  clearUploadCache,
  fileToContentSection,
  mimeOf,
  resolveModelAndEndpoint,
  supportsFilesApi,
  toDataUrl,
} from "./content-blocks.js";
import type { AppConfig, Endpoint, Model } from "../types/index.js";

const deepseek: Endpoint = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  capabilities: { filesApi: true },
};

const openai: Endpoint = {
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
};

async function tmpImage(content = "PNGDATA", ext = ".png"): Promise<string> {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `img${ext}`);
  await fs.writeFile(file, content);
  return file;
}

beforeEach(() => clearUploadCache());

describe("基础工具函数", () => {
  it("mimeOf 按扩展名（大小写不敏感），未知返回 undefined", () => {
    expect(mimeOf("/a/b.PNG")).toBe("image/png");
    expect(mimeOf("/a/b.jpeg")).toBe("image/jpeg");
    expect(mimeOf("/a/b.pdf")).toBe("application/pdf");
    expect(mimeOf("/a/b.exe")).toBeUndefined();
    expect(mimeOf("/a/b")).toBeUndefined();
  });

  it("toDataUrl 与 supportsFilesApi", () => {
    expect(toDataUrl("AAA", "image/png")).toBe("data:image/png;base64,AAA");
    expect(supportsFilesApi(deepseek)).toBe(true);
    expect(supportsFilesApi(openai)).toBe(false);
    expect(supportsFilesApi(null)).toBe(false);
    expect(supportsFilesApi(undefined)).toBe(false);
  });

  it("resolveModelAndEndpoint 按「发给 API 的模型名」反查；未命中返回 null 端点", () => {
    const config = {
      endpoints: [deepseek, openai],
      models: [
        { id: "deepseek-flash", name: "DS", endpointId: "deepseek", modelName: "deepseek-flash", vision: true },
        { id: "gpt-x", name: "GPT", endpointId: "openai" },
      ],
    } as unknown as AppConfig;

    expect(resolveModelAndEndpoint(config, "gpt-x").endpoint?.id).toBe("openai");
    // 未命中 → 不做任何隐式回退（模型真相源在 Agent 定义上，配置层无默认模型）
    expect(resolveModelAndEndpoint(config, "unknown").endpoint).toBeNull();
    expect(resolveModelAndEndpoint(config, undefined).endpoint).toBeNull();
  });
});

describe("fileToContentSection：传输方式选择", () => {
  it("http(s) URL 直接 image_url，不上传也不内联", async () => {
    const r = await fileToContentSection({
      source: { url: "https://example.com/a.png" },
      endpoint: deepseek,
      deps: { upload: vi.fn() },
    });
    expect(r.transport).toBe("url");
    expect(r.section).toEqual({ type: "image_url", image_url: { url: "https://example.com/a.png" } });
    expect(r.bytes).toBe(0);
  });

  it("本地 URL（file://）直接抛错", async () => {
    await expect(fileToContentSection({ source: { url: "file:///tmp/a.png" } })).rejects.toThrow(
      /不支持本地 URL/,
    );
  });

  it("端点支持 Files API：上传并返回 file 块（file_id）", async () => {
    const upload = vi.fn(async () => "file-from-api");
    const file = await tmpImage();
    const r = await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(r.transport).toBe("files-api");
    expect(r.section).toEqual({ type: "file", file_id: "file-from-api" });
    expect(r.bytes).toBe(7);
  });

  it("同一文件重复转换命中缓存，只上传一次", async () => {
    const upload = vi.fn(async () => "file-cached");
    const file = await tmpImage();
    await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });
    await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("不同端点不复用缓存（file_id 是端点维度资源）", async () => {
    const upload = vi.fn(async () => "file-x");
    const file = await tmpImage();
    const other: Endpoint = { ...deepseek, id: "deepseek-2" };
    await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });
    await fileToContentSection({ source: { path: file }, endpoint: other, deps: { upload } });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("上传失败自动降级为 base64 内联，并给出 warning", async () => {
    const upload = vi.fn(async () => {
      throw new Error("boom");
    });
    const file = await tmpImage();
    const r = await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });

    expect(r.transport).toBe("inline");
    expect(r.warning).toMatch(/上传 Files API 失败/);
    const section = r.section as { type: string; image_url: { url: string } };
    expect(section.type).toBe("image_url");
    expect(section.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("端点不支持 Files API：图片走 image_url + base64", async () => {
    const file = await tmpImage();
    const r = await fileToContentSection({ source: { path: file }, endpoint: openai });
    expect(r.transport).toBe("inline");
    expect((r.section as any).type).toBe("image_url");
    expect((r.section as any).image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("端点不支持 Files API：非图片走 file 块 + file_data", async () => {
    const file = await tmpImage("PDFDATA", ".pdf");
    const r = await fileToContentSection({ source: { path: file }, endpoint: openai });
    expect(r.transport).toBe("inline");
    expect(r.section).toEqual({
      type: "file",
      file_data: `data:application/pdf;base64,${Buffer.from("PDFDATA").toString("base64")}`,
      filename: "img.pdf",
    });
  });

  it("模型明确不支持视觉：图片退化为文本路径提示", async () => {
    const file = await tmpImage();
    const model = { id: "text-only", name: "T", endpointId: "openai", vision: false } as Model;
    const r = await fileToContentSection({ source: { path: file }, endpoint: openai, model });
    expect(r.transport).toBe("text");
    expect((r.section as any).text).toContain(file);
    expect(r.warning).toMatch(/不支持图片输入/);
  });

  it("非视觉模型：内存来源（base64 / data）也退化为文本提示", async () => {
    const textOnly = { id: "text-only", name: "T", endpointId: "openai" } as Model; // 缺省 vision
    const fromBase64 = await fileToContentSection({
      source: { base64: "AAAA", mime: "image/png", filename: "mcp-media-1.png" },
      endpoint: openai,
      model: textOnly,
    });
    expect(fromBase64.transport).toBe("text");
    expect((fromBase64.section as any).text).toContain("mcp-media-1.png");

    const fromBytes = await fileToContentSection({
      source: { data: new Uint8Array([1]), mime: "image/png", filename: "a.png" },
      endpoint: openai,
      model: textOnly,
    });
    expect(fromBytes.transport).toBe("text");

    // 视觉模型则照常内联
    const vision = { id: "v", name: "V", endpointId: "openai", vision: true } as Model;
    const ok = await fileToContentSection({
      source: { base64: "AAAA", mime: "image/png" },
      endpoint: openai,
      model: vision,
    });
    expect(ok.transport).toBe("inline");
  });

  it("内联超限且无法上传时报错（不静默塞进请求体）", async () => {
    const file = await tmpImage("0123456789");
    await expect(
      fileToContentSection({ source: { path: file }, endpoint: openai, maxInlineBytes: 4 }),
    ).rejects.toThrow(/超过内联上限/);
  });

  it("文件不存在 / 非文件 / 未知扩展名分别报错", async () => {
    await expect(
      fileToContentSection({ source: { path: join(tmpdir(), "definitely-missing-xyz.png") } }),
    ).rejects.toThrow();

    const bad = await tmpImage("x", ".exe");
    await expect(fileToContentSection({ source: { path: bad } })).rejects.toThrow(/不支持的文件类型/);
  });

  it("内存字节来源（MCP 场景）也能转换", async () => {
    const r = await fileToContentSection({
      source: { data: new Uint8Array([1, 2, 3]), mime: "image/png", filename: "a.png" },
      endpoint: openai,
    });
    expect(r.transport).toBe("inline");
    expect((r.section as any).image_url.url).toBe("data:image/png;base64,AQID");
  });

  it("默认内联上限为 8 MiB", () => {
    expect(DEFAULT_MAX_INLINE_BYTES).toBe(8 * 1024 * 1024);
  });
});
