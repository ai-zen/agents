import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager, DEFAULT_APP_CONFIG } from "./ConfigManager.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../types/index.js";

let configManager: ConfigManager;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-config-test-"));
  configManager = new ConfigManager(join(dir, "config.json"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ConfigManager", () => {
  it("文件不存在时返回出厂默认配置", async () => {
    const cfg = await configManager.read();
    expect(cfg.endpoints.length).toBeGreaterThan(0);
    expect(cfg.models.length).toBeGreaterThan(0);
    // 模型真相源在 Agent 定义上，不再有 config.defaultModel
    expect("defaultModel" in cfg).toBe(false);
  });

  it("正常读取 JSON 配置", async () => {
    const data: AppConfig = {
      endpoints: [
        { id: "e1", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
      ],
      models: [
        {
          id: "m1",
          name: "GPT-4",
          endpointId: "e1",
          tokenThresholds: { handoff: 500000, guard: 750000 },
        },
      ],
    };
    await configManager.write(data);

    const cfg = await configManager.read();
    expect(cfg.endpoints).toHaveLength(1);
    expect(cfg.models).toHaveLength(1);
  });

  it("写入并再次读取一致", async () => {
    const data: AppConfig = {
      endpoints: [{ id: "e1", name: "Test", baseUrl: "https://test.com", apiKey: "key" }],
      models: [],
    };

    await configManager.write(data);
    const read = await configManager.read();
    expect(read.endpoints).toEqual(data.endpoints);
  });

  it("覆盖已有配置", async () => {
    await fs.writeFile(join(dir, "config.json"), JSON.stringify({ endpoints: [], models: [] }));
    await configManager.write({
      endpoints: [{ id: "new", name: "New", baseUrl: "https://new.com", apiKey: "k" }],
      models: [],
    });

    const read = await configManager.read();
    expect(read.endpoints).toHaveLength(1);
    expect(read.endpoints[0].id).toBe("new");
  });

  it("ensureDirs 创建标准子目录", async () => {
    await configManager.ensureDirs();
    const dirs = ["agents", "sub-agents", "skills", "tools", "mcp-oauth"];
    for (const sub of dirs) {
      await expect(fs.access(join(dir, sub))).resolves.toBeUndefined();
    }
  });

  it("ensureDefaultAgent 在空目录创建默认 Agent", async () => {
    await configManager.ensureDirs();
    const result = await configManager.ensureDefaultAgent();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("default");

    await expect(fs.access(join(dir, "agents", "default.json"))).resolves.toBeUndefined();
  });
});

describe("配置文件坏了就恢复出厂（D32）", () => {
  /** 带回调的管理器：恢复一次就往 `recovered` 里记一条路径 */
  function makeManager(): { manager: ConfigManager; recovered: string[] } {
    const recovered: string[] = [];
    const manager = new ConfigManager(join(dir, "config.json"), (path) => {
      recovered.push(path);
    });
    return { manager, recovered };
  }

  const BROKEN: [string, string][] = [
    ["坏 JSON", "{ 这不是 JSON"],
    ["数组", JSON.stringify([{ id: "e1" }])],
    ["null", "null"],
  ];

  for (const [name, content] of BROKEN) {
    it(`${name}：read 回出厂配置、磁盘被写成出厂配置、回调一次`, async () => {
      await fs.writeFile(join(dir, "config.json"), content);
      const { manager, recovered } = makeManager();

      const cfg = await manager.read();
      expect(cfg.endpoints).toEqual(DEFAULT_APP_CONFIG.endpoints);
      expect(cfg.models).toEqual(DEFAULT_APP_CONFIG.models);

      // 磁盘上已经不是那个坏文件了：下次启动直接读到合法配置
      const onDisk = JSON.parse(await fs.readFile(join(dir, "config.json"), "utf-8")) as AppConfig;
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(DEFAULT_APP_CONFIG)));
      expect(recovered).toEqual([join(dir, "config.json")]);
    });
  }

  it("第二次读不再触发恢复", async () => {
    await fs.writeFile(join(dir, "config.json"), "{ 坏掉了");
    const { manager, recovered } = makeManager();

    await manager.read();
    await manager.read();

    expect(recovered).toHaveLength(1);
  });

  it("好文件不触发恢复（回调一次也不调）", async () => {
    await configManager.write({ endpoints: [], models: [] });
    const { manager, recovered } = makeManager();

    await expect(manager.read()).resolves.toMatchObject({ endpoints: [], models: [] });
    expect(recovered).toEqual([]);
  });
});
