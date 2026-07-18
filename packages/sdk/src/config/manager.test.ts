import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readConfig, writeConfig, getDefaultConfig } from "./manager.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../types/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function configPath(filename = "config.json"): string {
  return join(dir, filename);
}

describe("getDefaultConfig", () => {
  it("返回空 endpoints 和 models", () => {
    const cfg = getDefaultConfig();
    expect(cfg.endpoints).toEqual([]);
    expect(cfg.models).toEqual([]);
    expect(cfg.defaultModel).toBeUndefined();
  });
});

describe("readConfig", () => {
  it("文件不存在时返回默认配置", () => {
    const cfg = readConfig(configPath("nonexistent.json"));
    expect(cfg.endpoints).toEqual([]);
    expect(cfg.models).toEqual([]);
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
    writeFileSync(configPath(), JSON.stringify(data, null, 2));

    const cfg = readConfig(configPath());
    expect(cfg.defaultModel).toBe("m1");
    expect(cfg.endpoints).toHaveLength(1);
    expect(cfg.models).toHaveLength(1);
  });

  it("JSON 格式错误时抛出异常", () => {
    writeFileSync(configPath(), "{ bad json }");
    expect(() => readConfig(configPath())).toThrow();
  });
});

describe("writeConfig", () => {
  it("写入并再次读取一致", () => {
    const data: AppConfig = {
      endpoints: [
        { id: "e1", name: "Test", baseUrl: "https://test.com", apiKey: "key" },
      ],
      models: [],
    };

    writeConfig(configPath(), data);
    const read = readConfig(configPath());
    expect(read.endpoints).toEqual(data.endpoints);
  });

  it("覆盖已有配置", () => {
    writeFileSync(configPath(), JSON.stringify({ endpoints: [], models: [] }));
    writeConfig(configPath(), {
      endpoints: [
        { id: "new", name: "New", baseUrl: "https://new.com", apiKey: "k" },
      ],
      models: [],
    });

    const read = readConfig(configPath());
    expect(read.endpoints).toHaveLength(1);
    expect(read.endpoints[0].id).toBe("new");
  });
});
