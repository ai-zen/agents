import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "./ConfigManager.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../types/index.js";

let configManager: ConfigManager;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-config-test-"));
  configManager = new ConfigManager(join(dir, "config.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ConfigManager", () => {
  it("文件不存在时返回出厂默认配置", () => {
    const cfg = configManager.read();
    expect(cfg.defaultModel).toBe("deepseek-v4-flash");
    expect(cfg.endpoints.length).toBeGreaterThan(0);
    expect(cfg.models.length).toBeGreaterThan(0);
  });

  it("正常读取 JSON 配置", () => {
    const data: AppConfig = {
      defaultModel: "m1",
      endpoints: [
        { id: "e1", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
      ],
      models: [
        { id: "m1", name: "GPT-4", endpointId: "e1", maxContextTokens: 500000 },
      ],
    };
    configManager.write(data);

    const cfg = configManager.read();
    expect(cfg.defaultModel).toBe("m1");
    expect(cfg.endpoints).toHaveLength(1);
    expect(cfg.models).toHaveLength(1);
  });

  it("JSON 格式错误时抛出异常", () => {
    writeFileSync(join(dir, "config.json"), "{ bad json }");
    expect(() => configManager.read()).toThrow();
  });

  it("写入并再次读取一致", () => {
    const data: AppConfig = {
      endpoints: [
        { id: "e1", name: "Test", baseUrl: "https://test.com", apiKey: "key" },
      ],
      models: [],
    };

    configManager.write(data);
    const read = configManager.read();
    expect(read.endpoints).toEqual(data.endpoints);
  });

  it("覆盖已有配置", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ endpoints: [], models: [] }));
    configManager.write({
      endpoints: [
        { id: "new", name: "New", baseUrl: "https://new.com", apiKey: "k" },
      ],
      models: [],
    });

    const read = configManager.read();
    expect(read.endpoints).toHaveLength(1);
    expect(read.endpoints[0].id).toBe("new");
  });

  it("ensureDirs 创建标准子目录", () => {
    configManager.ensureDirs();
    const dirs = ["agents", "sub-agents", "skills", "tools", "mcp-oauth"];
    for (const sub of dirs) {
      const { existsSync } = require("node:fs");
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  it("ensureDefaultAgent 在空目录创建默认 Agent", () => {
    configManager.ensureDirs();
    const result = configManager.ensureDefaultAgent();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("default");

    const { existsSync, readFileSync } = require("node:fs");
    expect(existsSync(join(dir, "agents", "default.json"))).toBe(true);
  });
});
