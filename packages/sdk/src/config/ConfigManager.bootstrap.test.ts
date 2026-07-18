import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigManager,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
} from "./ConfigManager.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ai-zen-bootstrap-"));
}

function makeManager(basePath: string) {
  return new ConfigManager(join(basePath, "config.json"));
}

// ==================================================================
// ensureDefaultAgent
// ==================================================================

describe("ConfigManager.ensureDefaultAgent", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("全新空目录 → 创建 agents/ 并写入 default.json", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);

    const result = mgr.ensureDefaultAgent()!;

    expect(result.id).toBe(DEFAULT_AGENT_ID);
    const agentPath = join(testDir, "agents", `${DEFAULT_AGENT_ID}.json`);
    expect(existsSync(agentPath)).toBe(true);

    const raw = JSON.parse(readFileSync(agentPath, "utf-8"));
    expect(raw.id).toBe(DEFAULT_AGENT_ID);
    expect(raw.name).toBe(DEFAULT_AGENT_DEFINITION.name);
    expect(raw.permissions.tools).toEqual({ allow: ["*"] });
    expect(raw.messages.length).toBeGreaterThanOrEqual(1);
    expect(raw.messages[0].role).toBe("system");
  });

  it("agents 目录已存在但为空 → 写入 default.json", () => {
    testDir = tempDir();
    const agentsDir = join(testDir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    const mgr = makeManager(testDir);
    const result = mgr.ensureDefaultAgent()!;

    expect(result.id).toBe(DEFAULT_AGENT_ID);
    expect(existsSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`))).toBe(true);
  });

  it("已有其他 agent → 不覆盖，返回 null", () => {
    testDir = tempDir();
    const agentsDir = join(testDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "my-agent.json"),
      JSON.stringify({ id: "my-agent", name: "My Agent", messages: [], createdAt: "", updatedAt: "" }),
    );

    const mgr = makeManager(testDir);
    const result = mgr.ensureDefaultAgent();

    expect(result).toBeNull();
    expect(existsSync(join(agentsDir, "my-agent.json"))).toBe(true);
    expect(existsSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`))).toBe(false);
  });

  it("default.json 已存在 → 幂等，不覆盖", () => {
    testDir = tempDir();
    const agentsDir = join(testDir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    const customContent = {
      id: DEFAULT_AGENT_ID,
      name: "我自定义的名字",
      messages: [{ role: "system" as any, content: "自定义提示词" }],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      permissions: { tools: { deny: ["*"] } },
    };
    writeFileSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`), JSON.stringify(customContent, null, 2));

    const mgr = makeManager(testDir);
    const result = mgr.ensureDefaultAgent();

    const raw = JSON.parse(readFileSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`), "utf-8"));
    expect(raw.name).toBe("我自定义的名字");
    expect(raw.permissions.tools).toEqual({ deny: ["*"] });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("我自定义的名字");
  });

  it("返回的 AgentDefinition 包含 createdAt 和 updatedAt", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);

    const result = mgr.ensureDefaultAgent()!;

    expect(result.createdAt).toBeTruthy();
    expect(result.updatedAt).toBeTruthy();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
    expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
  });
});

// ==================================================================
// ensureDefaultSubAgent
// ==================================================================

describe("ConfigManager.ensureDefaultSubAgent", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("全新空目录 → 创建 sub-agents/ 并写入 general-assistant.json", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);

    const result = mgr.ensureDefaultSubAgent()!;

    expect(result.id).toBe(DEFAULT_SUBAGENT_ID);
    expect(result.function!.name).toBe("general_assistant");
    const subPath = join(testDir, "sub-agents", `${DEFAULT_SUBAGENT_ID}.json`);
    expect(existsSync(subPath)).toBe(true);
  });

  it("文件已存在 → 幂等，不覆盖", () => {
    testDir = tempDir();
    const subDir = join(testDir, "sub-agents");
    mkdirSync(subDir, { recursive: true });

    const custom = {
      id: DEFAULT_SUBAGENT_ID,
      name: "我自定义的",
      messages: [],
      function: { name: "custom_func", description: "", parameters: { type: "object", properties: {}, required: [] } },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    writeFileSync(join(subDir, `${DEFAULT_SUBAGENT_ID}.json`), JSON.stringify(custom));

    const mgr = makeManager(testDir);
    const result = mgr.ensureDefaultSubAgent();

    expect(result).not.toBeNull();
    expect(result!.name).toBe("我自定义的");
    expect(result!.function!.name).toBe("custom_func");
  });

  it("已有其他 SubAgent → 返回 null", () => {
    testDir = tempDir();
    const subDir = join(testDir, "sub-agents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "other.json"),
      JSON.stringify({ id: "other", name: "Other", messages: [], createdAt: "", updatedAt: "" }),
    );

    const mgr = makeManager(testDir);
    const result = mgr.ensureDefaultSubAgent();

    expect(result).toBeNull();
    expect(existsSync(join(subDir, `${DEFAULT_SUBAGENT_ID}.json`))).toBe(false);
  });
});

// ==================================================================
// ensureDefaultConfig
// ==================================================================

describe("ConfigManager.ensureDefaultConfig", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("文件不存在时写入出厂默认配置", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);

    const cfg = mgr.ensureDefaultConfig();

    expect(cfg.defaultModel).toBe("deepseek-v4-flash");
    expect(cfg.endpoints.length).toBeGreaterThan(0);
    expect(cfg.models.length).toBeGreaterThan(0);
    expect(cfg.imageModels!.length).toBeGreaterThan(0);
    expect(existsSync(join(testDir, "config.json"))).toBe(true);
  });

  it("文件已存在 → 返回已有配置，不覆盖", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);
    mgr.write({ endpoints: [], models: [], defaultModel: "my-model" });

    const cfg = mgr.ensureDefaultConfig();

    expect(cfg.defaultModel).toBe("my-model");
    expect(cfg.endpoints).toEqual([]);
  });
});

// ==================================================================
// bootstrap — 一键初始化
// ==================================================================

describe("ConfigManager.bootstrap", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("全新目录 → 创建 config + agent + subAgent + 所有子目录", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);

    const result = mgr.bootstrap();

    // config
    expect(result.config.defaultModel).toBeTruthy();
    expect(existsSync(join(testDir, "config.json"))).toBe(true);

    // agent
    expect(result.agent).not.toBeNull();
    expect(result.agent!.id).toBe("default");
    expect(existsSync(join(testDir, "agents", "default.json"))).toBe(true);

    // subAgent
    expect(result.subAgent).not.toBeNull();
    expect(result.subAgent!.id).toBe("general-assistant");
    expect(existsSync(join(testDir, "sub-agents", "general-assistant.json"))).toBe(true);

    // dirs
    for (const sub of ["agents", "sub-agents", "skills", "tools", "mcp-oauth"]) {
      expect(existsSync(join(testDir, sub))).toBe(true);
    }
  });

  it("幂等 — 第二次调用不覆盖已有文件", () => {
    testDir = tempDir();
    const mgr = makeManager(testDir);

    mgr.bootstrap();

    // 修改 config
    mgr.write({ ...DEFAULT_APP_CONFIG, defaultModel: "my-custom-model" });

    const result = mgr.bootstrap();
    expect(result.config.defaultModel).toBe("my-custom-model");
  });
});
