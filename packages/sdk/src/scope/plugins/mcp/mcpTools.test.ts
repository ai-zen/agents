import { beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// Files API 上传走 OpenAI SDK：用 mock 顶掉，避免测试真的发网络请求
const { mockFilesCreate, mockToFile } = vi.hoisted(() => ({
  mockFilesCreate: vi.fn(),
  mockToFile: vi.fn(async (data: unknown, filename: string) => ({ data, filename })),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    files = { create: mockFilesCreate };
  },
  toFile: mockToFile,
}));

import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./mcpTools.js";
import type { McpConnectionManager } from "./McpConnectionManager.js";
import type { AppConfig, McpServerConfig, ToolEnv } from "../../../types/index.js";
import { clearUploadCache } from "../../../shared/content-blocks.js";

/** 带 Files API 能力的端点 + 视觉模型（用于验证上传路径） */
function filesApiConfig(): Partial<AppConfig> {
  return {
    endpoints: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        capabilities: { filesApi: true },
      },
    ],
    models: [
      {
        id: "ds-vision",
        name: "DS Vision",
        endpointId: "deepseek",
        modelName: "ds-vision",
        tokenThresholds: { handoff: 1000, guard: 1500 },
        vision: true,
      },
    ] as AppConfig["models"],
  };
}

/** 纯文本模型配置（未声明 vision）：用于验证媒体退化 */
function textOnlyConfig(): Partial<AppConfig> {
  return {
    endpoints: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        capabilities: { filesApi: true },
      },
    ],
    models: [
      { id: "ds-chat", name: "DS Chat", endpointId: "deepseek", modelName: "ds-chat", tokenThresholds: { handoff: 1000, guard: 1500 } },
    ] as AppConfig["models"],
  };
}

beforeEach(() => {
  clearUploadCache();
  mockFilesCreate.mockReset();
  mockFilesCreate.mockResolvedValue({ id: "file-mcp-1" });
});

/** 构造测试用 ToolEnv（config 可按需覆盖，如 maxToolOutput） */
function makeEnv(config: Partial<AppConfig> = {}): ToolEnv {
  return { cwd: "/tmp", config: config as AppConfig };
}

/**
 * 工具运行上下文：模型名来自 `ctx.agent.model`（= Model.modelName ?? id）。
 *
 * 端点必须按当前模型反查（`file_id` 是端点维度资源），所以测试也必须把 ctx 传进去；
 * 配置层已无 `defaultModel`，不能再靠隐式回退找端点。
 */
const visionCtx = { agent: { model: "ds-vision" } } as any;
const chatCtx = { agent: { model: "ds-chat" } } as any;

function mockManager(overrides?: Partial<McpConnectionManager>): McpConnectionManager {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getState: vi.fn(),
    getManifest: vi.fn(),
    getClient: vi.fn(),
    touch: vi.fn(),
    ...overrides,
  } as unknown as McpConnectionManager;
}

const mcps: McpServerConfig[] = [
  { id: "github", name: "GitHub", description: "GitHub 文件与仓库工具", transport: "stdio", command: "gh" },
  { id: "slack", name: "Slack", description: "Slack 消息工具", transport: "http", url: "https://slack.example.com" },
];

describe("createLoadMcpTool", () => {
  it("工具名称和参数正确", () => {
    const manager = mockManager();
    const tool = createLoadMcpTool(manager, mcps);
    expect(tool.function.name).toBe("load_mcp");
    expect(tool.function.parameters.properties.server.enum).toEqual(["github", "slack"]);
    expect(tool.function.parameters.required).toContain("server");
    // 披露开关：可选参数，默认 true（不改变既有契约）
    expect(tool.function.parameters.properties.include_manifest.type).toBe("boolean");
    expect(tool.function.parameters.properties.include_manifest.default).toBe(true);
    expect(tool.function.parameters.required).not.toContain("include_manifest");
    // description 透传进参数描述，供 LLM 参考（对齐 load_skill）
    const serverDesc = tool.function.parameters.properties.server.description as string;
    expect(serverDesc).toContain("github: GitHub 文件与仓库工具");
    expect(serverDesc).toContain("slack: Slack 消息工具");
    expect(serverDesc).toContain("各 MCP 服务器说明");
  });

  it("服务器不存在时返回错误", async () => {
    const manager = mockManager();
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "non-existent" });
    expect(result).toContain("不存在");
  });

  it("已连接时直接返回 JSON 清单（不含 prompts）", async () => {
    const manifest = {
      tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } }],
      resources: [{ uri: "file:///data", name: "数据文件", description: "数据文件" }],
      prompts: [{ name: "greet", description: "问候" }],
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getManifest: vi.fn(() => manifest),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github" });
    const parsed = JSON.parse(result);
    expect(parsed.tools).toEqual(manifest.tools);
    expect(parsed.resources).toEqual(manifest.resources);
    expect(parsed).not.toHaveProperty("prompts");
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("未连接时调用 connect 并返回 JSON（不含 prompts）", async () => {
    const manifest = {
      tools: [{ name: "list", description: "列出文件", inputSchema: { type: "object", properties: {} } }],
      resources: [],
    };
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockResolvedValue(manifest),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github" });
    const parsed = JSON.parse(result);
    expect(parsed.tools).toEqual(manifest.tools);
    expect(parsed.resources).toEqual(manifest.resources);
    expect(parsed).not.toHaveProperty("prompts");
    expect(manager.connect).toHaveBeenCalledWith("github", mcps[0]);
  });

  it("连接失败时返回错误", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockRejectedValue(new Error("连接超时")),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github" });
    expect(result).toContain("无法连接");
    expect(result).toContain("连接超时");
  });

  it("include_manifest=false 且未连接时仅建连并返回摘要（不含工具定义）", async () => {
    const manifest = {
      tools: [
        { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
        { name: "sum", description: "求和", inputSchema: { type: "object", properties: {} } },
      ],
      resources: [{ uri: "file:///data", name: "数据文件" }],
    };
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockResolvedValue(manifest),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github", include_manifest: false });

    expect(manager.connect).toHaveBeenCalledWith("github", mcps[0]);
    expect(JSON.parse(result)).toEqual({
      server: "github",
      connected: true,
      tools: 2,
      resources: 1,
    });
    // 摘要不得携带任何工具/资源定义（否则节省 token 的目的落空）
    expect(result).not.toContain("inputSchema");
    expect(result).not.toContain("echo");
    expect(result).not.toContain("file:///data");
  });

  it("include_manifest=false 且已连接时返回摘要，不重复建连", async () => {
    const manifest = {
      tools: [
        { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
      ],
      resources: [],
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getManifest: vi.fn(() => manifest),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github", include_manifest: false });

    expect(manager.connect).not.toHaveBeenCalled();
    expect(manager.touch).toHaveBeenCalledWith("github");
    expect(JSON.parse(result)).toEqual({
      server: "github",
      connected: true,
      tools: 1,
      resources: 0,
    });
  });

  it("显式 include_manifest=true 时返回完整清单（同默认）", async () => {
    const manifest = {
      tools: [
        { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
      ],
      resources: [{ uri: "file:///data", name: "数据文件" }],
    };
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockResolvedValue(manifest),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github", include_manifest: true });
    const parsed = JSON.parse(result);

    expect(parsed.tools).toEqual(manifest.tools);
    expect(parsed.resources).toEqual(manifest.resources);
    expect(result).toContain("inputSchema");
  });

  it("include_manifest=false 但连接失败时仍返回错误（不返回摘要）", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockRejectedValue(new Error("连接超时")),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github", include_manifest: false });

    expect(result).toContain("无法连接");
    expect(result).toContain("连接超时");
    expect(result).not.toContain("connected");
  });
});

describe("createCallMcpTool", () => {
  it("工具名称和参数正确", () => {
    const manager = mockManager();
    const tool = createCallMcpTool(manager, makeEnv());
    expect(tool.function.name).toBe("call_mcp_tool");
    expect(tool.function.parameters.required).toContain("server");
    expect(tool.function.parameters.required).toContain("tool");
    expect(tool.function.parameters.required).toContain("arguments");
  });

  it("服务器未连接时提示先 load_mcp", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
    expect(result).toContain("请先使用 load_mcp");
  });

  it("客户端不可用时返回错误", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => null),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
    expect(result).toContain("不可用");
  });

  it("成功调用工具返回结果", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "hello world" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", tool: "echo", arguments: { message: "hello" } });
    expect(result).toBe("hello world");
    expect(mockClient.callTool).toHaveBeenCalledWith(
      {
        name: "echo",
        arguments: { message: "hello" },
      },
      undefined,
      { signal: undefined },
    );
  });

  it("isError 时返回错误信息", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "权限不足" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", tool: "write", arguments: {} });
    expect(result).toContain("工具执行出错");
    expect(result).toContain("权限不足");
  });

  it("调用时返回非 text 内容", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "image", data: "base64..." }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", tool: "draw", arguments: {} });
    // 图片不丢弃：转 image_url 内容块返回；无 mimeType 时缺省 image/png
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,base64..." } },
    ]);
  });

  it("调用失败时返回错误信息", async () => {
    const mockClient = {
      callTool: vi.fn().mockRejectedValue(new Error("网络错误")),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
    expect(result).toContain("失败");
    expect(result).toContain("网络错误");
  });

  describe("内容块映射", () => {
    /** 造一个返回指定 content 数组的 client */
    function managerWithContent(content: unknown[], extra: Record<string, unknown> = {}) {
      const mockClient = { callTool: vi.fn().mockResolvedValue({ content, ...extra }) };
      return mockManager({
        getState: vi.fn(() => "connected" as const),
        getClient: vi.fn(() => mockClient),
      });
    }

    it("文本与图片混排：首块为文本，图片块原样透传", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "text", text: "截图如下" },
          { type: "image", data: "BBBB", mimeType: "image/jpeg" },
        ]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "shot", arguments: {} });
      expect(result).toEqual([
        { type: "text", text: "截图如下" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
      ]);
    });

    it("音频转 file 块（file_data 内联 data URL）", async () => {
      const tool = createCallMcpTool(
        managerWithContent([{ type: "audio", data: "DDDD", mimeType: "audio/mpeg" }]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "speak", arguments: {} });
      expect(result).toEqual([
        { type: "file", file_data: "data:audio/mpeg;base64,DDDD", filename: expect.stringMatching(/^mcp-media-\d+\.mp3$/) },
      ]);
    });

    it("resource.text 并入正文（纯文本时仍返回字符串）", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "text", text: "前缀" },
          { type: "resource", resource: { uri: "file:///a.md", mimeType: "text/markdown", text: "# 内容" } },
        ]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "read", arguments: {} });
      expect(result).toBe("前缀\n# 内容");
    });

    it("resource.blob 按 mimeType 分流：图片走 image_url", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "resource", resource: { uri: "file:///p.png", mimeType: "image/png", blob: "EEEE" } },
        ]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "read", arguments: {} });
      expect(result).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,EEEE" } },
      ]);
    });

    it("resource.blob 非图片时走 file 块", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "resource", resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: "FFFF" } },
        ]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "read", arguments: {} });
      expect(result).toEqual([
        { type: "file", file_data: "data:application/pdf;base64,FFFF", filename: expect.stringMatching(/^mcp-media-\d+\.pdf$/) },
      ]);
    });

    it("端点声明 Files API 能力时，MCP 图片上传为 file 块（不再 base64 内联）", async () => {
      const tool = createCallMcpTool(
        managerWithContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]),
        makeEnv(filesApiConfig()),
      );
      const result = await tool.callback({ server: "github", tool: "shot", arguments: {} }, visionCtx);
      expect(result).toEqual([{ type: "file", file_id: "file-mcp-1" }]);
      expect(mockFilesCreate).toHaveBeenCalledTimes(1);
    });

    it("同一张图（相同字节）重复调用只上传一次（内容哈希缓存）", async () => {
      const manager = managerWithContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
      const tool = createCallMcpTool(manager, makeEnv(filesApiConfig()));
      await tool.callback({ server: "github", tool: "shot", arguments: {} }, visionCtx);
      await tool.callback({ server: "github", tool: "shot", arguments: {} }, visionCtx);
      expect(mockFilesCreate).toHaveBeenCalledTimes(1);
    });

    it("非视觉模型时 MCP 图片退化为文本提示（避免 4xx），且不上传", async () => {
      const tool = createCallMcpTool(
        managerWithContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]),
        makeEnv(textOnlyConfig()),
      );
      const result = await tool.callback({ server: "github", tool: "shot", arguments: {} }, chatCtx);
      // 唯一的内容块是文本 → 按既有契约退化为字符串
      expect(typeof result).toBe("string");
      expect(result as string).toContain("不支持图片输入");
      expect(mockFilesCreate).not.toHaveBeenCalled();
    });

    it("上传失败时降级为 base64 内联，媒体块不丢", async () => {
      mockFilesCreate.mockRejectedValueOnce(new Error("boom"));
      const tool = createCallMcpTool(
        managerWithContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]),
        makeEnv(filesApiConfig()),
      );
      const result = await tool.callback({ server: "github", tool: "shot", arguments: {} }, visionCtx);
      expect(result).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ]);
    });

    it("resource_link 转为文本线索", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "resource_link", name: "报告", uri: "file:///r.md", mimeType: "text/markdown" },
        ]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "list", arguments: {} });
      expect(result).toBe("[资源链接] 报告 · file:///r.md · text/markdown");
    });

    it("未知类型退化为 JSON 文本，不丢弃", async () => {
      const tool = createCallMcpTool(
        managerWithContent([{ type: "tool_use", name: "x", id: "1", input: {} }]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "t", arguments: {} });
      expect(result).toBe(JSON.stringify({ type: "tool_use", name: "x", id: "1", input: {} }));
    });

    it("文本不在首块时顺序完整保留（图片在前也不拎到前面）", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "上面的图" },
          { type: "image", data: "BBBB", mimeType: "image/png" },
        ]),
        makeEnv(),
      );
      const result = await tool.callback({ server: "github", tool: "shot", arguments: {} });
      expect(result).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "上面的图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ]);
    });

    it("文本与图片交错时逐块保持原序（不合并、不重排）", async () => {
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "text", text: "图1：" },
          { type: "image", data: "A", mimeType: "image/png" },
          { type: "text", text: "图2：" },
          { type: "image", data: "B", mimeType: "image/png" },
          { type: "text", text: "完" },
        ]),
        makeEnv(),
      );
      const result = (await tool.callback({ server: "github", tool: "shot", arguments: {} })) as any[];
      expect(result.map((s) => s.type)).toEqual([
        "text",
        "image_url",
        "text",
        "image_url",
        "text",
      ]);
      expect(result[0].text).toBe("图1：");
      expect(result[2].text).toBe("图2：");
      expect(result[4].text).toBe("完");
    });

    it("文本交叠落盘时，警告占据首个文本块的位置，其余文本块并到它身上", async () => {
      const big = "z".repeat(50_000);
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "image", data: "HEAD", mimeType: "image/png" },
          { type: "text", text: big },
          { type: "image", data: "TAIL", mimeType: "image/png" },
        ]),
        makeEnv({ maxToolOutput: 1000 }),
      );
      const result = (await tool.callback({ server: "github", tool: "dump", arguments: {} })) as any[];

      // 仍是 3 块，图片原位不动，警告落在原来的第 2 位
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("image_url");
      expect(result[1].type).toBe("text");
      expect(result[2].type).toBe("image_url");

      const warned = JSON.parse(result[1].text);
      expect(warned.outputTooLarge).toBe(true);
      expect(warned.chars).toBe(50_000);
      rmSync(dirname(warned.files["result.txt"]), { recursive: true, force: true });
    });

    it("多次文本超限时只保留一个警告块（其余文本已落盘）", async () => {
      const big = "q".repeat(30_000);
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "text", text: big },
          { type: "image", data: "MID", mimeType: "image/png" },
          { type: "text", text: big },
        ]),
        makeEnv({ maxToolOutput: 1000 }),
      );
      const result = (await tool.callback({ server: "github", tool: "dump", arguments: {} })) as any[];
      // 两段文本合并为一个警告块，图片夹在中间
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("text");
      expect(result[1].type).toBe("image_url");

      const warned = JSON.parse(result[0].text);
      expect(warned.chars).toBe(60_000);
      expect(readFileSync(warned.files["result.txt"], "utf-8")).toHaveLength(60_001); // 两段 + 换行
      rmSync(dirname(warned.files["result.txt"]), { recursive: true, force: true });
    });

    it("文本超限时只保护文本，图片仍原样透传", async () => {
      const big = "z".repeat(50_000);
      const tool = createCallMcpTool(
        managerWithContent([
          { type: "text", text: big },
          { type: "image", data: "GGGG", mimeType: "image/png" },
        ]),
        makeEnv({ maxToolOutput: 1000 }),
      );
      const result = (await tool.callback({
        server: "github",
        tool: "dump",
        arguments: {},
      })) as any[];

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      // 首块：文本已折叠为警告 + 头尾预览
      expect(result[0].type).toBe("text");
      const warned = JSON.parse(result[0].text);
      expect(warned.outputTooLarge).toBe(true);
      expect(warned.chars).toBe(50_000);
      expect(result[0].text.length).toBeLessThan(5_000);

      // 次块：图片不受影响
      expect(result[1]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,GGGG" },
      });

      rmSync(dirname(warned.files["result.txt"]), { recursive: true, force: true });
    });
  });

  describe("输出保护", () => {
    /** 造一个返回指定 text 的 client */
    function managerReturning(text: string, extra: Record<string, unknown> = {}) {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text }], ...extra }),
      };
      return mockManager({
        getState: vi.fn(() => "connected" as const),
        getClient: vi.fn(() => mockClient),
      });
    }

    it("超过 maxToolOutput 时落盘 result.txt 并只返回头尾预览", async () => {
      const big = "x".repeat(50_000);
      const tool = createCallMcpTool(managerReturning(big), makeEnv({ maxToolOutput: 1000 }));
      const raw = (await tool.callback({
        server: "github",
        tool: "dump",
        arguments: {},
      })) as string;

      const parsed = JSON.parse(raw);
      expect(parsed.outputTooLarge).toBe(true);
      expect(parsed.chars).toBe(50_000);
      expect(parsed.omitted).toBe(48_000);
      expect(parsed.head).toHaveLength(1000);
      expect(parsed.tail).toHaveLength(1000);
      expect(parsed.warning).toContain("1000");
      // 返回体本身不会把百万字符再塞回上下文
      expect(raw.length).toBeLessThan(5_000);

      // 完整内容已落盘
      const file = parsed.files["result.txt"];
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf-8")).toHaveLength(50_000);
      rmSync(dirname(file), { recursive: true, force: true });
    });

    it("未超过上限时原样返回，不落盘", async () => {
      const tool = createCallMcpTool(managerReturning("hello"), makeEnv({ maxToolOutput: 1000 }));
      const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
      expect(result).toBe("hello");
    });

    it("缺省 maxToolOutput 时以 DEFAULT_MAX_TOOL_OUTPUT 为上限（32768）", async () => {
      const atLimit = "y".repeat(32_768);
      const tool = createCallMcpTool(managerReturning(atLimit), makeEnv());
      const result = (await tool.callback({
        server: "github",
        tool: "dump",
        arguments: {},
      })) as string;
      // 正好等于上限不触发保护
      expect(result).toBe(atLimit);
    });

    it("超限且 isError 时警告体保留 isError 标记", async () => {
      const big = "e".repeat(50_000);
      const tool = createCallMcpTool(
        managerReturning(big, { isError: true }),
        makeEnv({ maxToolOutput: 1000 }),
      );
      const parsed = JSON.parse(
        (await tool.callback({ server: "github", tool: "fail", arguments: {} })) as string,
      );
      expect(parsed.outputTooLarge).toBe(true);
      expect(parsed.isError).toBe(true);
      rmSync(dirname(parsed.files["result.txt"]), { recursive: true, force: true });
    });
  });
});

describe("createReadMcpResourceTool", () => {
  it("工具名称和参数正确", () => {
    const manager = mockManager();
    const tool = createReadMcpResourceTool(manager, makeEnv());
    expect(tool.function.name).toBe("read_mcp_resource");
    expect(tool.function.parameters.required).toContain("server");
    expect(tool.function.parameters.required).toContain("uri");
  });

  it("服务器未连接时提示先 load_mcp", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", uri: "file:///README.md" });
    expect(result).toContain("请先使用 load_mcp");
  });

  it("成功读取资源", async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: "# 文档内容" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", uri: "file:///README.md" });
    expect(result).toBe("# 文档内容");
  });

  it("读取失败时返回错误", async () => {
    const mockClient = {
      readResource: vi.fn().mockRejectedValue(new Error("资源不存在")),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", uri: "file:///missing" });
    expect(result).toContain("失败");
    expect(result).toContain("资源不存在");
  });

  it("二进制资源不再被丢弃：无上传能力时内联为 image_url", async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: "file:///p.png", mimeType: "image/png", blob: "GGGG" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv());
    const result = await tool.callback({ server: "github", uri: "file:///p.png" });
    expect(result).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,GGGG" } },
    ]);
  });

  it("端点声明 Files API 能力时，资源图片上传为 file 块", async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: "file:///p.png", mimeType: "image/png", blob: "GGGG" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv(filesApiConfig()));
    const result = await tool.callback({ server: "github", uri: "file:///p.png" }, visionCtx);
    expect(result).toEqual([{ type: "file", file_id: "file-mcp-1" }]);
    expect(mockFilesCreate).toHaveBeenCalledTimes(1);
  });

  it("文本资源超限时落盘 result.txt 并只返回头尾预览（与 call_mcp_tool 同一闸门）", async () => {
    const long = "x".repeat(500);
    const tool = createReadMcpResourceTool(
      mockManager({
        getState: vi.fn(() => "connected" as const),
        getClient: vi.fn(() => ({
          readResource: vi.fn().mockResolvedValue({
            contents: [{ uri: "file:///big.txt", mimeType: "text/plain", text: long }],
          }),
        })),
      }),
      makeEnv({ maxToolOutput: 50 } as Partial<AppConfig>),
    );
    const result = await tool.callback({ server: "github", uri: "file:///big.txt" });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("输出过大");
    expect(result as string).toContain("result.txt");
  });

  it("文本与二进制混排时保持原序，且纯文本仍返回字符串", async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [
          { uri: "file:///a.txt", mimeType: "text/plain", text: "第一段" },
          { uri: "file:///p.png", mimeType: "image/png", blob: "GGGG" },
          { uri: "file:///b.txt", mimeType: "text/plain", text: "第二段" },
        ],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv());
    const mixed = (await tool.callback({ server: "github", uri: "file:///x" })) as any[];
    expect(mixed.map((s) => s.type)).toEqual(["text", "image_url", "text"]);

    const textOnly = createReadMcpResourceTool(
      mockManager({
        getState: vi.fn(() => "connected" as const),
        getClient: vi.fn(() => ({
          readResource: vi.fn().mockResolvedValue({
            contents: [
              { uri: "file:///a.txt", text: "甲" },
              { uri: "file:///b.txt", text: "乙" },
            ],
          }),
        })),
      }),
      makeEnv(),
    );
    expect(await textOnly.callback({ server: "github", uri: "file:///y" })).toBe("甲\n乙");
  });
});

describe("signal 透传", () => {
  it("call_mcp_tool 将 ctx.signal 透传给 client.callTool 的 options", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager, makeEnv());
    const controller = new AbortController();
    await tool.callback(
      { server: "github", tool: "echo", arguments: { message: "hi" } },
      { signal: controller.signal } as any,
    );
    expect(mockClient.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      undefined,
      { signal: controller.signal },
    );
  });

  it("read_mcp_resource 将 ctx.signal 透传给 client.readResource 的 options", async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager, makeEnv());
    const controller = new AbortController();
    await tool.callback(
      { server: "github", uri: "file:///README.md" },
      { signal: controller.signal } as any,
    );
    expect(mockClient.readResource).toHaveBeenCalledWith(
      { uri: "file:///README.md" },
      { signal: controller.signal },
    );
  });
});
