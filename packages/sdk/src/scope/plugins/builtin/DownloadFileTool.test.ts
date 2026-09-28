import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { DownloadFileTool } from "./DownloadFileTool.js";
import { makeEnv } from "./test-helpers.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("DownloadFileTool", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("工具名称和描述正确", () => {
    const tool = new DownloadFileTool(makeEnv());
    expect(tool.function.name).toBe("downloadFile");
    expect(tool.function.description).toContain("下载文件");
  });

  it("url 为空时返回错误", async () => {
    const tool = new DownloadFileTool(makeEnv());
    const result = await tool.call({ url: "" });
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

    const tool = new DownloadFileTool(makeEnv());
    const result = await tool.call({ url: "https://example.com/not-found" });
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

    const tool = new DownloadFileTool(makeEnv());
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    const result = await tool.call({ url: "https://example.com/image.png", outputPath: join(dir, "test.png") });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
    expect(parsed.contentType).toBe("image/png");

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

    const tool = new DownloadFileTool(makeEnv());
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    try {
      const result = await tool.call({ url: "https://example.com/file.txt", outputPath: dir });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain("file.txt");
    } finally {
      try { unlinkSync(join(dir, "file.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("未指定 outputPath 时保存到 env.cwd", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/plain" },
      arrayBuffer: async () => Buffer.from("data"),
    });

    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    try {
      const tool = new DownloadFileTool(makeEnv(dir));
      const result = await tool.call({ url: "https://example.com/dl.txt" });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain("dl.txt");
    } finally {
      try { unlinkSync(join(dir, "dl.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("下载被中断（abort）时返回 aborted 并清理半成品", async () => {
    // fetch 收到 signal，abort 时抛 AbortError
    mockFetch.mockImplementation(async (url: string, init?: any) => {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      throw new Error("should not reach here");
    });

    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    const controller = new AbortController();
    controller.abort();

    try {
      const tool = new DownloadFileTool(makeEnv(dir));
      const result = await tool.call(
        { url: "https://example.com/aborted.png", outputPath: join(dir, "aborted.png") },
        { signal: controller.signal } as unknown as ToolCallContext,
      );
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(false);
      expect(parsed.aborted).toBe(true);
      // 半成品文件不应残留
      await expect(import("fs/promises").then((f) => f.stat(join(dir, "aborted.png")))).rejects.toThrow();
    } finally {
      try { unlinkSync(dir); } catch {}
    }
  });
});
