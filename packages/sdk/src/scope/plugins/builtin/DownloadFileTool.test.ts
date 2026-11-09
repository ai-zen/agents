import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { DownloadFileTool } from "./DownloadFileTool.js";
import { makeEnv } from "./test-helpers.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

const mockFetch = vi.fn();

/** 造一个 web ReadableStream（模拟 response.body） */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** 造一个成功的 mock Response */
function okResponse(contentType: string, body: ReadableStream<Uint8Array> | null) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => contentType },
    body,
  };
}

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanUpDir(dir: string, ...files: string[]): void {
  for (const file of files) {
    try {
      rmSync(join(dir, file), { recursive: true, force: true });
    } catch {}
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// 全局 stub 必须在文件范围内完成 stub/unstub：`isolate: false` 下同一进程的所有测试文件
// 共用全局对象，顶层 `vi.stubGlobal("fetch", …)` 会泄漏给后续文件（例如让别的文件里的
// 真实网络探测失败）。
describe("DownloadFileTool", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("工具名称和描述正确", () => {
    const tool = new DownloadFileTool(makeEnv());
    expect(tool.function.name).toBe("download_file");
    expect(tool.function.description).toContain("Download a file from a URL");
  });

  it("timeout 声明为必填参数", () => {
    const tool = new DownloadFileTool(makeEnv());
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("timeout");
    const required = (params.required as string[]) ?? [];
    expect(required).toContain("timeout");
  });

  it("缺失或非法 timeout 时抛出异常", async () => {
    const tool = new DownloadFileTool(makeEnv());
    await expect(tool.call({ url: "https://example.com/a.png" } as never)).rejects.toThrow(
      /timeout/,
    );
    await expect(tool.call({ url: "https://example.com/a.png", timeout: 0 })).rejects.toThrow(
      /timeout/,
    );
  });

  it("url 为空时抛出异常", async () => {
    const tool = new DownloadFileTool(makeEnv());
    await expect(tool.call({ url: "", timeout: 5000 })).rejects.toThrow(/url must not be empty/);
  });

  it("HTTP 请求失败时返回错误", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => "" },
      body: null,
    });

    const tool = new DownloadFileTool(makeEnv());
    const result = await tool.call({ url: "https://example.com/not-found", timeout: 5000 });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("HTTP 404");
  });

  it("成功下载文件（流式写盘）", async () => {
    mockFetch.mockResolvedValue(okResponse("image/png", streamOf(["fake-", "image-", "data"])));

    const tool = new DownloadFileTool(makeEnv());
    const dir = tmpDir();
    try {
      const result = await tool.call({
        url: "https://example.com/image.png",
        outputPath: join(dir, "test.png"),
        timeout: 5000,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);
      expect(parsed.contentType).toBe("image/png");
      expect(await readFile(join(dir, "test.png"), "utf-8")).toBe("fake-image-data");
    } finally {
      cleanUpDir(dir, "test.png");
    }
  });

  it("outputPath 为目录时自动拼接文件名", async () => {
    mockFetch.mockResolvedValue(okResponse("text/plain", streamOf(["data"])));

    const tool = new DownloadFileTool(makeEnv());
    const dir = tmpDir();
    try {
      const result = await tool.call({
        url: "https://example.com/file.txt",
        outputPath: dir,
        timeout: 5000,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain("file.txt");
    } finally {
      cleanUpDir(dir, "file.txt");
    }
  });

  it("未指定 outputPath 时保存到 env.cwd", async () => {
    mockFetch.mockResolvedValue(okResponse("text/plain", streamOf(["data"])));

    const dir = tmpDir();
    try {
      const tool = new DownloadFileTool(makeEnv(dir));
      const result = await tool.call({ url: "https://example.com/dl.txt", timeout: 5000 });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toContain("dl.txt");
    } finally {
      cleanUpDir(dir, "dl.txt");
    }
  });

  it("response 无 body 时返回错误，不留下空文件", async () => {
    mockFetch.mockResolvedValue(okResponse("text/plain", null));

    const tool = new DownloadFileTool(makeEnv());
    const dir = tmpDir();
    try {
      const result = await tool.call({
        url: "https://example.com/empty.txt",
        outputPath: join(dir, "empty.txt"),
        timeout: 5000,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("no body");
      expect(existsSync(join(dir, "empty.txt"))).toBe(false);
    } finally {
      cleanUpDir(dir, "empty.txt");
    }
  });

  it("中断（abort）不删除调用前已存在的文件", async () => {
    // 一个保存着用户数据的同名文件
    const dir = tmpDir();
    const target = join(dir, "keep.png");
    writeFileSync(target, "USER'S IMPORTANT DATA", "utf-8");

    mockFetch.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

    const controller = new AbortController();
    controller.abort();

    try {
      const tool = new DownloadFileTool(makeEnv(dir));
      const result = await tool.call(
        { url: "https://example.com/keep.png", outputPath: target, timeout: 5000 },
        { signal: controller.signal } as unknown as ToolCallContext,
      );
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(false);
      expect(parsed.aborted).toBe(true);

      // 关键：本次一个字节都没写，原文件必须原封不动
      expect(await readFile(target, "utf-8")).toBe("USER'S IMPORTANT DATA");
    } finally {
      cleanUpDir(dir, "keep.png");
    }
  });

  it("超过 timeout 时中止下载（fetch 自身对响应体没有时限）", async () => {
    mockFetch.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    );

    const tool = new DownloadFileTool(makeEnv());
    const dir = tmpDir();
    const start = Date.now();
    try {
      const result = await tool.call({
        url: "https://example.com/slow.bin",
        outputPath: join(dir, "slow.bin"),
        timeout: 150,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("timeout after 150ms");
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      cleanUpDir(dir, "slow.bin");
    }
  });
});
