import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockFilesCreate, mockToFile } = vi.hoisted(() => ({
  mockFilesCreate: vi.fn(),
  mockToFile: vi.fn(async (data: unknown, filename: string) => ({
    data,
    filename,
  })),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    files = { create: mockFilesCreate };
  },
  toFile: mockToFile,
}));

import { ViewImageTool } from "./ViewImageTool.js";
import { makeEnv } from "./test-helpers.js";
import type { AppConfig } from "../../../types/index.js";

const deepseekConfig: AppConfig = {
  defaultModel: "m1",
  endpoints: [
    {
      id: "deepseek",
      name: "DeepSeek",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
    },
  ],
  models: [],
};

afterEach(() => {
  mockFilesCreate.mockReset();
  mockToFile.mockReset();
});

describe("ViewImageTool", () => {
  it("工具名称与描述正确", () => {
    const tool = new ViewImageTool(makeEnv("/ws"));
    expect(tool.function.name).toBe("viewImage");
    expect(tool.function.description).toContain("查看");
  });

  it("URL 输入时直接返回 image_url 内容块（不上传）", async () => {
    const tool = new ViewImageTool(makeEnv("/ws"));
    const result = await tool.call({
      path_or_url: "https://example.com/a.jpg",
    });

    expect(result).toEqual([
      { type: "text", text: "已获取网络图片：https://example.com/a.jpg" },
      { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
    ]);
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["file:// 协议（含盘符）", "file:///C:/images/pic.png"],
    ["file:// 协议（不含盘符）", "file:///tmp/pic.png"],
    ["localhost", "http://localhost/a.png"],
    ["127.0.0.1", "http://127.0.0.1/a.png"],
    ["[::1]", "http://[::1]/a.png"],
    ["0.0.0.0", "http://0.0.0.0/a.png"],
  ])("本地 URL 拒绝：%s", async (_label, url) => {
    const tool = new ViewImageTool(makeEnv("/ws"));
    const result = await tool.call({ path_or_url: url });
    expect(result).toContain("不支持本地 URL");
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it("参数说明中声明了不支持本地 URL", () => {
    const tool = new ViewImageTool(makeEnv("/ws"));
    expect(tool.function.description).toContain("不支持本地 URL");
    const paramDesc =
      (tool.function.parameters.properties.path_or_url as { description?: string })
        .description ?? "";
    expect(paramDesc).toContain("不支持本地 URL");
  });

  it("本地图片自动通过 Files API 上传并返回 file 内容块", async () => {
    mockFilesCreate.mockResolvedValue({ id: "file-api-12345" });

    const dir = await fs.mkdtemp(join(tmpdir(), "viewimg-"));
    const imgPath = join(dir, "cat.png");
    await fs.writeFile(imgPath, Buffer.from([1, 2, 3]));

    try {
      const tool = new ViewImageTool(makeEnv(dir, deepseekConfig));
      const result = await tool.call({ path_or_url: "cat.png" });

      expect(mockToFile).toHaveBeenCalledWith(expect.any(Buffer), "cat.png");
      expect(mockFilesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "user_data" }),
        expect.anything(),
      );
      expect(result).toEqual([
        { type: "text", text: expect.stringContaining("file-api-12345") },
        { type: "file", file_id: "file-api-12345" },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("本地绝对路径也可上传", async () => {
    mockFilesCreate.mockResolvedValue({ id: "file-api-abc" });

    const dir = await fs.mkdtemp(join(tmpdir(), "viewimg-"));
    const imgPath = join(dir, "pic.jpeg");
    await fs.writeFile(imgPath, Buffer.from([1]));

    try {
      const tool = new ViewImageTool(makeEnv(dir, deepseekConfig));
      const result = await tool.call({ path_or_url: imgPath });
      expect(result).toContainEqual({ type: "file", file_id: "file-api-abc" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("本地文件不存在时返回错误", async () => {
    const tool = new ViewImageTool(makeEnv("/ws", deepseekConfig));
    const result = await tool.call({ path_or_url: "missing.png" });
    expect(result).toContain("不存在");
  });

  it("不支持的图片格式返回错误", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "viewimg-"));
    const txtPath = join(dir, "note.txt");
    await fs.writeFile(txtPath, "hello");

    try {
      const tool = new ViewImageTool(makeEnv(dir, deepseekConfig));
      const result = await tool.call({ path_or_url: "note.txt" });
      expect(result).toContain("不支持的图片格式");
      expect(mockFilesCreate).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("未配置 deepseek 端点时本地上传返回错误（URL 场景不受影响）", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "viewimg-"));
    const imgPath = join(dir, "a.png");
    await fs.writeFile(imgPath, Buffer.from([1]));

    try {
      const tool = new ViewImageTool(makeEnv(dir, {} as AppConfig));
      const local = await tool.call({ path_or_url: "a.png" });
      expect(local).toContain("未配置 deepseek 端点");

      const url = await tool.call({ path_or_url: "https://example.com/a.png" });
      expect(url).toEqual([
        { type: "text", text: "已获取网络图片：https://example.com/a.png" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("isAvailable: 仅视觉模型为 true（definition.modelId 或默认模型）", () => {
    const config: AppConfig = {
      ...deepseekConfig,
      defaultModel: "m1",
      models: [
        { id: "v1", name: "V", endpointId: "deepseek", modelName: "v1", maxContextTokens: 1000, vision: true },
        { id: "m1", name: "M", endpointId: "deepseek", modelName: "m1", maxContextTokens: 1000 },
      ],
    };
    const tool = new ViewImageTool(makeEnv("/ws", config));
    const def = (modelId?: string) => ({
      id: "t",
      name: "T",
      messages: [{ role: "system", content: "x" }],
      modelId,
      createdAt: "",
      updatedAt: "",
    });

    // 显式指定视觉模型 → 可用
    expect(tool.isAvailable!(config, def("v1") as any)).toBe(true);
    // 显式指定非视觉模型 → 不可用
    expect(tool.isAvailable!(config, def("m1") as any)).toBe(false);
    // 未指定模型 → 用默认模型（m1，非视觉）→ 不可用
    expect(tool.isAvailable!(config, def() as any)).toBe(false);
  });

  it("缺少 path_or_url 参数时返回错误", async () => {
    const tool = new ViewImageTool(makeEnv("/ws"));
    const result = await tool.call({});
    expect(result).toContain("path_or_url");
  });
});
