import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS, Message } from "@ai-zen/agents-core";
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
    messages: [Message.System("You are helpful.")],
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

/**
 * 实体 id 不得逃出仓储目录（L2 / L31）。
 *
 * 用**两级**临时目录：`root/agents` 是仓储目录，逃逸产物只会落到 `root` 下，
 * 断言能看见它，也不会污染 `/tmp` 根目录。
 */
describe("AgentRepository：id 逃不出目录", () => {
  let root: string;
  let repo: AgentRepository;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "ai-zen-entity-traversal-"));
    repo = new AgentRepository(join(root, "agents"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("`../` 逃逸被拦，且没有文件被写到目录外", async () => {
    await expect(repo.write({ ...sampleAgent("x"), id: "../escaped" })).rejects.toThrow(/id/i);
    await expect(fs.access(join(root, "escaped.json"))).rejects.toThrow();
  });

  it("兄弟目录前缀绕过（`<dir>-evil`）同样拦得住", async () => {
    // 裸 `startsWith(root)` 会放行：`<root>/agents-evil/x.json` 以 `<root>/agents` 开头
    await expect(repo.write({ ...sampleAgent("x"), id: "../agents-evil/x" })).rejects.toThrow(
      /id/i,
    );
    await expect(fs.access(join(root, "agents-evil"))).rejects.toThrow();
  });

  it("read / delete 与 write 同一道门（都走 `path()`）", async () => {
    await expect(repo.read("../x")).rejects.toThrow(/id/i);
    await expect(repo.delete("../x")).rejects.toThrow(/id/i);
  });

  it("绝对路径被拦（必须是 `resolve` 而不是 `join`）", async () => {
    await expect(repo.read("/etc/passwd")).rejects.toThrow(/id/i);
  });

  it("正常 id 不受影响", async () => {
    await repo.write(sampleAgent("ok"));
    expect((await repo.read("ok"))?.id).toBe("ok");
    await repo.delete("ok");
    expect(await repo.read("ok")).toBeNull();
  });
});
