import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "./AgentRepository.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition } from "../types/index.js";

let repo: AgentRepository;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-crud-test-"));
  repo = new AgentRepository(dir);
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

describe("AgentRepository", () => {
  it("写入后能读取", () => {
    const agent = sampleAgent("test-agent");
    repo.write(agent);

    const read = repo.read("test-agent");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("test-agent");
    expect(read!.name).toBe("Agent test-agent");
  });

  it("不存在的 agent 返回 null", () => {
    expect(repo.read("nonexistent")).toBeNull();
  });

  it("空目录返回空数组", () => {
    expect(repo.list()).toEqual([]);
  });

  it("列出所有 agent", () => {
    repo.write(sampleAgent("a"));
    repo.write(sampleAgent("b"));

    const list = repo.list();
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });

  it("跳过非 JSON 文件", () => {
    repo.write(sampleAgent("a"));
    writeFileSync(join(dir, "notes.txt"), "hello");

    expect(repo.list()).toHaveLength(1);
  });

  it("跳过格式错误的 JSON", () => {
    repo.write(sampleAgent("a"));
    writeFileSync(join(dir, "bad.json"), "{ not json }");

    expect(repo.list()).toHaveLength(1);
  });

  it("删除后读取返回 null", () => {
    repo.write(sampleAgent("to-delete"));
    repo.delete("to-delete");
    expect(repo.read("to-delete")).toBeNull();
  });

  it("删除不存在的 agent 不抛异常", () => {
    expect(() => repo.delete("nonexistent")).not.toThrow();
  });
});
