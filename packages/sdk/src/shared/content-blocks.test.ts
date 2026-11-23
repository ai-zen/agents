import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_MAX_INLINE_BYTES,
  fileToContentSection,
  mimeOf,
  resolveModelAndEndpoint,
  supportsFilesApi,
  toDataUrl,
} from "./content-blocks.js";
import type { AppConfig, EndpointDefinition, ModelDefinition } from "../types/index.js";

const deepseek: EndpointDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  capabilities: { filesApi: true },
};

const openai: EndpointDefinition = {
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
};

/** 本文件造过的临时目录：`afterEach` 里收掉（不收就是每次跑都往 /tmp 加几个） */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function tmpImage(content = "PNGDATA", ext = ".png"): Promise<string> {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  tempDirs.push(dir);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `img${ext}`);
  await fs.writeFile(file, content);
  return file;
}

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
        {
          id: "deepseek-flash",
          name: "DS",
          endpointId: "deepseek",
          modelName: "deepseek-flash",
          vision: true,
        },
        { id: "gpt-x", name: "GPT", endpointId: "openai" },
      ],
    } as unknown as AppConfig;

    expect(resolveModelAndEndpoint(config, "gpt-x").endpoint?.id).toBe("openai");
    // 未命中 → 这里的反查不兜底（模型兜底走 `resolveModel`）
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
    expect(r.section).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/a.png" },
    });
    expect(r.bytes).toBe(0);
  });

  it("本地 URL（file://）直接抛错", async () => {
    await expect(fileToContentSection({ source: { url: "file:///tmp/a.png" } })).rejects.toThrow(
      /Unsupported local URL/,
    );
  });

  it("端点支持 Files API：上传并返回 file 块（file_id）", async () => {
    const upload = vi.fn(async () => "file-from-api");
    const file = await tmpImage();
    const r = await fileToContentSection({
      source: { path: file },
      endpoint: deepseek,
      deps: { upload },
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(r.transport).toBe("files-api");
    expect(r.section).toEqual({ type: "file", file_id: "file-from-api" });
    expect(r.bytes).toBe(7);
  });

  it("同一文件每次转换都真上传（SDK 不记 id，去重由调用方决定）", async () => {
    const upload = vi.fn(async () => "file-each-time");
    const file = await tmpImage();
    await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });
    await fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } });
    // 换个端点再传一次：`file_id` 是端点维度资源，SDK 也不替调用方记
    const other: EndpointDefinition = { ...deepseek, id: "deepseek-2" };
    await fileToContentSection({ source: { path: file }, endpoint: other, deps: { upload } });
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("上传失败原样抛错，不换成 base64 内联", async () => {
    const upload = vi.fn(async () => {
      throw new Error("boom");
    });
    const file = await tmpImage();

    await expect(
      fileToContentSection({ source: { path: file }, endpoint: deepseek, deps: { upload } }),
    ).rejects.toThrow("boom");
    expect(upload).toHaveBeenCalledTimes(1);
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
    const model = {
      id: "text-only",
      name: "T",
      endpointId: "openai",
      vision: false,
    } as ModelDefinition;
    const r = await fileToContentSection({ source: { path: file }, endpoint: openai, model });
    expect(r.transport).toBe("text");
    expect((r.section as any).text).toContain(file);
    expect(r.warning).toMatch(/does not support image input/);
  });

  it("非视觉模型：内存来源（base64 / data）也退化为文本提示", async () => {
    const textOnly = { id: "text-only", name: "T", endpointId: "openai" } as ModelDefinition; // 缺省 vision
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
    const vision = { id: "v", name: "V", endpointId: "openai", vision: true } as ModelDefinition;
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
    ).rejects.toThrow(/exceeds the inline limit/);
  });

  it("文件不存在 / 非文件 / 未知扩展名分别报错", async () => {
    await expect(
      fileToContentSection({ source: { path: join(tmpdir(), "definitely-missing-xyz.png") } }),
    ).rejects.toThrow();

    const bad = await tmpImage("x", ".exe");
    await expect(fileToContentSection({ source: { path: bad } })).rejects.toThrow(
      /Unsupported file type/,
    );
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

/**
 * 默认上传实现走的是**真 HTTP**（`fetch` + `FormData`，不用 `openai` 包）。
 *
 * 这里用本地 `node:http` 假端点钉住线格式：路径、鉴权头、multipart 的两个字段名。
 * 换实现时这三样最容易悄悄错 —— 错了就是直接抛错，不会有人替它降级。
 */
describe("默认上传实现（真 HTTP，不注入 upload）", () => {
  async function fakeEndpoint(): Promise<{
    endpoint: EndpointDefinition;
    requests: Array<{ url?: string; auth?: string; body: string }>;
    reply: { status: number; body: string };
    close: () => Promise<void>;
  }> {
    const requests: Array<{ url?: string; auth?: string; body: string }> = [];
    const reply = { status: 200, body: JSON.stringify({ id: "file-from-http" }) };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        requests.push({
          url: req.url,
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: {
        id: `fake-${randomBytes(4).toString("hex")}`,
        name: "Fake",
        // 末尾多一个 `/`：实现必须自己收掉，否则会拼出 `//files`
        baseUrl: `http://127.0.0.1:${port}/v1/`,
        apiKey: "sk-fake",
        capabilities: { filesApi: true },
      },
      requests,
      reply,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("POST {baseUrl}/files，带 Bearer，multipart 里是 purpose=user_data + file", async () => {
    const fake = await fakeEndpoint();
    try {
      const file = await tmpImage("PNGDATA");
      const r = await fileToContentSection({ source: { path: file }, endpoint: fake.endpoint });

      expect(fake.requests).toHaveLength(1);
      const [request] = fake.requests;
      expect(request.url).toBe("/v1/files");
      expect(request.auth).toBe("Bearer sk-fake");
      expect(request.body).toContain('name="purpose"');
      expect(request.body).toContain("user_data");
      expect(request.body).toContain('name="file"');
      expect(request.body).toContain('filename="img.png"');
      expect(request.body).toContain("PNGDATA");
      expect(request.body).toContain("image/png");

      expect(r.transport).toBe("files-api");
      expect(r.section).toEqual({ type: "file", file_id: "file-from-http" });
    } finally {
      await fake.close();
    }
  });

  it("端点返回非 2xx：原样抛错，不换成 base64 内联", async () => {
    const fake = await fakeEndpoint();
    fake.reply.status = 500;
    fake.reply.body = JSON.stringify({ error: "nope" });
    try {
      const file = await tmpImage();
      await expect(
        fileToContentSection({ source: { path: file }, endpoint: fake.endpoint }),
      ).rejects.toThrow(/File upload failed: HTTP 500/);
    } finally {
      await fake.close();
    }
  });
});

// ---- 图片的宽高上限：8192 ----

/** 只造 PNG 头（签名 + IHDR），够读宽高 */
function pngHeader(width: number, height: number): Buffer {
  const out = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
  out.writeUInt32BE(13, 8);
  out.write("IHDR", 12, "ascii");
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

/** 只造 JPEG 头（SOI + SOF0） */
function jpegHeader(width: number, height: number): Buffer {
  const out = Buffer.alloc(21);
  out.writeUInt16BE(0xffd8, 0);
  out.writeUInt16BE(0xffc0, 2);
  out.writeUInt16BE(0x0011, 4);
  out.writeUInt8(0x08, 6);
  out.writeUInt16BE(height, 7);
  out.writeUInt16BE(width, 9);
  out.writeUInt8(0x03, 11);
  return out;
}

describe("fileToContentSection：图片宽高的上限", () => {
  it("本地文件超了：抛错并说清尺寸与上限", async () => {
    const file = await tmpImage();
    await fs.writeFile(file, pngHeader(9000, 100));

    await expect(
      fileToContentSection({ source: { path: file }, endpoint: openai }),
    ).rejects.toThrow(/Image 9000×100 exceeds the 8192 px limit on either side/);
  });

  it("base64 来源（MCP 那条路）一样挡：尺寸从解出来的头里读", async () => {
    await expect(
      fileToContentSection({
        source: {
          base64: jpegHeader(100, 9000).toString("base64"),
          mime: "image/jpeg",
          filename: "mcp-media-1.jpg",
        },
        endpoint: openai,
      }),
    ).rejects.toThrow(/Image 100×9000 exceeds the 8192 px limit/);
  });

  it("正好 8192 放过：边界按「超过」算", async () => {
    const file = await tmpImage();
    await fs.writeFile(file, pngHeader(8192, 8192));

    const r = await fileToContentSection({ source: { path: file }, endpoint: openai });
    expect(r.transport).toBe("inline");
    expect((r.section as any).type).toBe("image_url");
  });

  it("非视觉模型收到超大图：退化成一句提示，不抛错（图本来就不发）", async () => {
    const file = await tmpImage();
    await fs.writeFile(file, pngHeader(9000, 100));
    const textOnly = {
      id: "text-only",
      name: "T",
      endpointId: "openai",
      vision: false,
    } as ModelDefinition;

    const r = await fileToContentSection({
      source: { path: file },
      endpoint: openai,
      model: textOnly,
    });
    expect(r.transport).toBe("text");
  });

  it("头认不出来就放过：这层不当安全边界", async () => {
    const file = await tmpImage();
    await fs.writeFile(file, Buffer.from("not really a png"));

    const r = await fileToContentSection({ source: { path: file }, endpoint: openai });
    expect(r.transport).toBe("inline");
  });
});
