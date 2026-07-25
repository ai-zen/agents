import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "./AgentRepository.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition } from "../types/index.js";

let repo: AgentRepository;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-crud-test-"));
  repo = new AgentRepository(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
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
  it("写入后能读取", async () => {
    const agent = sampleAgent("test-agent");
    await repo.write(agent);

    const read = await repo.read("test-agent");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("test-agent");
    expect(read!.name).toBe("Agent test-agent");
  });

  it("不存在的 agent 返回 null", async () => {
    expect(await repo.read("nonexistent")).toBeNull();
  });

  it("空目录返回空数组", async () => {
    expect(await repo.list()).toEqual([]);
  });

  it("列出所有 agent", async () => {
    await repo.write(sampleAgent("a"));
    await repo.write(sampleAgent("b"));

    const list = await repo.list();
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });

  it("跳过非 JSON 文件", async () => {
    await repo.write(sampleAgent("a"));
    await fs.writeFile(join(dir, "notes.txt"), "hello");

    expect(await repo.list()).toHaveLength(1);
  });

  it("跳过格式错误的 JSON", async () => {
    await repo.write(sampleAgent("a"));
    await fs.writeFile(join(dir, "bad.json"), "{ not json }");

    expect(await repo.list()).toHaveLength(1);
  });

  it("删除后读取返回 null", async () => {
    await repo.write(sampleAgent("to-delete"));
    await repo.delete("to-delete");
    expect(await repo.read("to-delete")).toBeNull();
  });

  it("删除不存在的 agent 不抛异常", async () => {
    await expect(repo.delete("nonexistent")).resolves.not.toThrow();
  });
});
