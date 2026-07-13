import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDefaultAgent, DEFAULT_AGENT_ID, DEFAULT_AGENT_DEFINITION } from "./bootstrap";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ai-zen-bootstrap-"));
}

describe("ensureDefaultAgent", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("全新空目录 → 创建 agents/ 并写入 default.json", () => {
    testDir = tempDir();

    const result = ensureDefaultAgent(testDir)!;

    expect(result.id).toBe(DEFAULT_AGENT_ID);
    const agentPath = join(testDir, "agents", `${DEFAULT_AGENT_ID}.json`);
    expect(existsSync(agentPath)).toBe(true);

    const raw = JSON.parse(readFileSync(agentPath, "utf-8"));
    expect(raw.id).toBe(DEFAULT_AGENT_ID);
    expect(raw.name).toBe(DEFAULT_AGENT_DEFINITION.name);
    expect(raw.permissions.tools).toEqual({ allow: ["*"] });
    expect(raw.permissions.skills).toEqual({ allow: ["*"] });
    expect(raw.permissions.mcps).toEqual({ allow: ["*"] });
    expect(raw.permissions.subagents).toEqual({ allow: ["*"] });
    expect(raw.messages.length).toBeGreaterThanOrEqual(1);
    expect(raw.messages[0].role).toBe("system");
  });

  it("agents 目录已存在但为空 → 写入 default.json", () => {
    testDir = tempDir();
    const agentsDir = join(testDir, "agents");
    const { mkdirSync } = require("node:fs");
    mkdirSync(agentsDir, { recursive: true });

    const result = ensureDefaultAgent(testDir)!;

    expect(result.id).toBe(DEFAULT_AGENT_ID);
    expect(existsSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`))).toBe(true);
  });

  it("已有其他 agent → 不覆盖，返回 null", () => {
    testDir = tempDir();
    const agentsDir = join(testDir, "agents");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "my-agent.json"),
      JSON.stringify({ id: "my-agent", name: "My Agent", messages: [], createdAt: "", updatedAt: "" }),
    );

    const result = ensureDefaultAgent(testDir);

    expect(result).toBeNull();
    // 确认原有 agent 未被改动
    expect(existsSync(join(agentsDir, "my-agent.json"))).toBe(true);
    expect(existsSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`))).toBe(false);
  });

  it("default.json 已存在 → 幂等，不覆盖", () => {
    testDir = tempDir();
    const agentsDir = join(testDir, "agents");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(agentsDir, { recursive: true });

    const customContent = {
      id: DEFAULT_AGENT_ID,
      name: "我自定义的名字",
      messages: [{ role: "system" as const, content: "自定义提示词" }],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      permissions: { tools: { deny: ["*"] } },
    };
    writeFileSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`), JSON.stringify(customContent, null, 2));

    const result = ensureDefaultAgent(testDir);

    // 已存在则返回已存在的定义，不覆盖
    const raw = JSON.parse(readFileSync(join(agentsDir, `${DEFAULT_AGENT_ID}.json`), "utf-8"));
    expect(raw.name).toBe("我自定义的名字");
    expect(raw.permissions.tools).toEqual({ deny: ["*"] });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("我自定义的名字");
  });

  it("返回的 AgentDefinition 包含 createdAt 和 updatedAt", () => {
    testDir = tempDir();

    const result = ensureDefaultAgent(testDir)!;

    expect(result.createdAt).toBeTruthy();
    expect(result.updatedAt).toBeTruthy();
    // ISO 8601 格式
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
    expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
  });
});
