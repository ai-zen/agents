import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { ConversationRepository } from "./ConversationRepository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Conversation } from "../types/index.js";

let repo: ConversationRepository;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-crud-test-"));
  repo = new ConversationRepository(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
  it("write + read", () => {
    const conv = sampleConversation("c1");
    repo.write(conv);
    const read = repo.read("c1");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("c1");
  });

  it("不存在的返回 null", () => {
    expect(repo.read("nope")).toBeNull();
  });

  it("列出全部", () => {
    repo.write(sampleConversation("a"));
    repo.write(sampleConversation("b"));
    expect(repo.list()).toHaveLength(2);
  });

  it("删除", () => {
    repo.write(sampleConversation("x"));
    repo.delete("x");
    expect(repo.read("x")).toBeNull();
  });

  it("lastPromptTokens 往返持久化", () => {
    const conv = { ...sampleConversation("c1"), lastPromptTokens: 42000 };
    repo.write(conv);
    const read = repo.read("c1");
    expect(read).not.toBeNull();
    expect(read!.lastPromptTokens).toBe(42000);
  });

  it("lastPromptTokens 未设置时为 undefined", () => {
    const conv = sampleConversation("c1");
    repo.write(conv);
    const read = repo.read("c1");
    expect(read).not.toBeNull();
    expect(read!.lastPromptTokens).toBeUndefined();
  });
});
