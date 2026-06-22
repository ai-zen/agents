import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  defaultConfig,
  ensureConfigDir,
  readConfig,
  saveConfig,
  CONFIG_DIR,
  CONVERSATIONS_DIR,
  AGENTS_DIR,
  SUB_AGENTS_DIR,
  SKILLS_DIR,
  TOOLS_DIR,
  CONFIG_FILE,
} from "./config.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ==================== Mock 文件系统 ====================

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const vol = new Map<string, string>(); // path -> content
  const dirs = new Set<string>();

  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      // 对 node_modules 和 真实路径放行
      if (path.includes("node_modules")) return actual.existsSync(path);
      return dirs.has(path) || vol.has(path);
    }),
    mkdirSync: vi.fn((path: string, options?: any) => {
      dirs.add(path);
    }),
    readFileSync: vi.fn((path: string, encoding?: any) => {
      if (path.includes("node_modules")) return actual.readFileSync(path, encoding);
      if (!vol.has(path)) throw new Error(`ENOENT: ${path}`);
      return vol.get(path)!;
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      vol.set(path, content);
    }),
    unlinkSync: vi.fn((path: string) => {
      vol.delete(path);
    }),
    readdirSync: vi.fn((path: string) => {
      // 返回 vol 中匹配 path 的文件名列表
      const prefix = path.endsWith("/") ? path : path + "/";
      const files: string[] = [];
      for (const key of vol.keys()) {
        if (key.startsWith(prefix)) {
          files.push(key.slice(prefix.length));
        }
      }
      return files;
    }),
  };
});

// ==================== before ====================

beforeEach(() => {
  // 重置 mock 状态
  vi.clearAllMocks();
});

// ==================== defaultConfig ====================

describe("defaultConfig", () => {
  it("有预置的端点", () => {
    expect(defaultConfig.endpoints.length).toBeGreaterThanOrEqual(3);
    const ids = defaultConfig.endpoints.map((e) => e.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("bigmodelcn");
    expect(ids).toContain("deepseek");
  });

  it("有预置的对话模型", () => {
    expect(defaultConfig.models.length).toBeGreaterThan(0);
  });

  it("有默认 Agent 指向 default", () => {
    expect(defaultConfig.defaultAgent).toBe("default");
  });

  it("有默认模型", () => {
    expect(defaultConfig.defaultModel).toBeTruthy();
  });

  it("有图片生成模型", () => {
    expect(defaultConfig.imageModels?.length).toBeGreaterThan(0);
    expect(defaultConfig.defaultImageModel).toBeTruthy();
  });

  it("有 MCP 服务器配置（默认为空数组）", () => {
    expect(defaultConfig.mcpServers).toBeDefined();
    expect(Array.isArray(defaultConfig.mcpServers)).toBe(true);
    expect(defaultConfig.mcpServers!.length).toBe(0);
  });

  it("子 Agent 默认为空（由文件系统发现）", () => {
    expect(defaultConfig.subAgents).toBeDefined();
    expect(Array.isArray(defaultConfig.subAgents)).toBe(true);
    expect(defaultConfig.subAgents!.length).toBe(0);
  });
});

// ==================== ensureConfigDir ====================

describe("ensureConfigDir", () => {
  it("创建配置目录、子目录和默认子 Agent 文件", () => {
    ensureConfigDir();
    expect(mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    expect(mkdirSync).toHaveBeenCalledWith(CONVERSATIONS_DIR, {
      recursive: true,
    });
    expect(mkdirSync).toHaveBeenCalledWith(AGENTS_DIR, { recursive: true });
    expect(mkdirSync).toHaveBeenCalledWith(SUB_AGENTS_DIR, { recursive: true });
    expect(mkdirSync).toHaveBeenCalledWith(SKILLS_DIR, { recursive: true });
    expect(mkdirSync).toHaveBeenCalledWith(TOOLS_DIR, { recursive: true });
    // 首次运行应写入默认通用助手文件
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("general-assistant.json"),
      expect.any(String),
      "utf-8",
    );
  });
});

// ==================== saveConfig / readConfig ====================

describe("saveConfig / readConfig", () => {
  beforeEach(() => {
    // 确保目录存在
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it("保存的配置可以读回", () => {
    const config = { ...defaultConfig, defaultModel: "test-model" };
    saveConfig(config);

    expect(writeFileSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringContaining("test-model"),
      "utf-8",
    );

    // 验证 JSON 格式正确
    const writtenContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.defaultModel).toBe("test-model");
  });

  it("读取不存在的配置时返回默认配置", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const config = readConfig();
    expect(config.defaultModel).toBe(defaultConfig.defaultModel);
    expect(config.agents).toBeDefined();
  });

  it("读取损坏的配置时返回默认配置", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValueOnce("{invalid json}");
    const config = readConfig();
    // 出错时返回默认配置
    expect(config.defaultModel).toBe(defaultConfig.defaultModel);
  });

  it("合并数组字段，确保默认项存在", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        defaultModel: "my-model",
        agents: [],
        subAgents: [],
        endpoints: [],
        models: [],
      }),
    );
    const config = readConfig();
    // agents 已迁移到文件系统，config 中为空
    expect(config.agents?.length).toBe(0);
    // subAgents 默认为空（由文件系统发现）
    expect(config.subAgents?.length).toBe(0);
  });
});
