import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// Mock fetch before importing the tool
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs/promises to avoid actual file writes in some tests
import * as fsp from "fs/promises";

const { downloadFileTool } = await import("./downloadFile.js");

describe("downloadFileTool", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("工具名称和描述正确", () => {
    expect(downloadFileTool.function.name).toBe("downloadFile");
    expect(downloadFileTool.function.description).toContain("下载文件");
  });

  it("url 为空时返回错误", async () => {
    const result = await downloadFileTool.callback({ url: "" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
  });

  it("HTTP 请求失败时返回错误", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => "" },
    });

    const result = await downloadFileTool.callback({ url: "https://example.com/not-found" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("HTTP 404");
  });

  it("成功下载文件", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => Buffer.from("fake-image-data"),
    });

    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    const result = await downloadFileTool.callback({
      url: "https://example.com/image.png",
      outputPath: join(dir, "test.png"),
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
    expect(parsed.contentType).toBe("image/png");

    // cleanup
    try { unlinkSync(join(dir, "test.png")); } catch {}
    try { unlinkSync(dir); } catch {}
  });

  it("outputPath 为目录时自动拼接文件名", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/plain" },
      arrayBuffer: async () => Buffer.from("data"),
    });

    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    try {
      const result = await downloadFileTool.callback({
        url: "https://example.com/file.txt",
        outputPath: dir,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain("file.txt");
    } finally {
      try { unlinkSync(join(dir, "file.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });
});
