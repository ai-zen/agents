import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { listAgents, readAgent, writeAgent, deleteAgent } from "./agents.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition } from "../types/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-crud-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleAgent(id: string): AgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("writeAgent + readAgent", () => {
  it("写入后能读取", () => {
    const agent = sampleAgent("test-agent");
    writeAgent(dir, agent);

    const read = readAgent(dir, "test-agent");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("test-agent");
    expect(read!.name).toBe("Agent test-agent");
  });

  it("不存在的 agent 返回 null", () => {
    expect(readAgent(dir, "nonexistent")).toBeNull();
  });
});

describe("listAgents", () => {
  it("空目录返回空数组", () => {
    expect(listAgents(dir)).toEqual([]);
  });

  it("列出所有 agent", () => {
    writeAgent(dir, sampleAgent("a"));
    writeAgent(dir, sampleAgent("b"));

    const list = listAgents(dir);
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });

  it("跳过非 JSON 文件", () => {
    writeAgent(dir, sampleAgent("a"));
    writeFileSync(join(dir, "notes.txt"), "hello");

    expect(listAgents(dir)).toHaveLength(1);
  });

  it("跳过格式错误的 JSON", () => {
    writeAgent(dir, sampleAgent("a"));
    writeFileSync(join(dir, "bad.json"), "{ not json }");

    expect(listAgents(dir)).toHaveLength(1);
  });
});

describe("deleteAgent", () => {
  it("删除后读取返回 null", () => {
    writeAgent(dir, sampleAgent("to-delete"));
    deleteAgent(dir, "to-delete");
    expect(readAgent(dir, "to-delete")).toBeNull();
  });

  it("删除不存在的 agent 不抛异常", () => {
    expect(() => deleteAgent(dir, "nonexistent")).not.toThrow();
  });
});
