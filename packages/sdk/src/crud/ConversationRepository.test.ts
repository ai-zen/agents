import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { ConversationRepository } from "./ConversationRepository.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Conversation } from "../types/index.js";

let repo: ConversationRepository;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-crud-test-"));
  repo = new ConversationRepository(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function sampleConversation(id: string): Conversation {
  return {
    id,
    agentId: "agent-1",
    modelId: "model-1",
    messages: [{ role: AgentNS.Role.User, content: "hello" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("ConversationRepository", () => {
  it("write + read", async () => {
    const conv = sampleConversation("c1");
    await repo.write(conv);
    const read = await repo.read("c1");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("c1");
  });

  it("不存在的返回 null", async () => {
    expect(await repo.read("nope")).toBeNull();
  });

  it("列出全部", async () => {
    await repo.write(sampleConversation("a"));
    await repo.write(sampleConversation("b"));
    expect(await repo.list()).toHaveLength(2);
  });

  it("删除", async () => {
    await repo.write(sampleConversation("x"));
    await repo.delete("x");
    expect(await repo.read("x")).toBeNull();
  });

  it("lastPromptTokens 往返持久化", async () => {
    const conv = { ...sampleConversation("c1"), lastPromptTokens: 42000 };
    await repo.write(conv);
    const read = await repo.read("c1");
    expect(read).not.toBeNull();
    expect(read!.lastPromptTokens).toBe(42000);
  });

  it("lastPromptTokens 未设置时为 undefined", async () => {
    const conv = sampleConversation("c1");
    await repo.write(conv);
    const read = await repo.read("c1");
    expect(read).not.toBeNull();
    expect(read!.lastPromptTokens).toBeUndefined();
  });
});
