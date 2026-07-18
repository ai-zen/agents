import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { DraftRepository } from "./DraftRepository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Draft } from "../types/index.js";

let repo: DraftRepository;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-crud-test-"));
  repo = new DraftRepository(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleDraft(conversationId?: string): Draft {
  return {
    conversationId,
    agentId: "agent-1",
    modelId: "model-1",
    messages: [{ role: AgentNS.Role.User, content: "draft message" }],
    updatedAt: new Date().toISOString(),
  };
}

describe("DraftRepository", () => {
  it("已命名 draft write + read", () => {
    const draft = sampleDraft("conv-1");
    repo.write(draft);
    const read = repo.read("conv-1");
    expect(read).not.toBeNull();
    expect(read!.conversationId).toBe("conv-1");
  });

  it("未命名 draft（_current）", () => {
    const draft = sampleDraft();
    repo.write(draft);
    const read = repo.read();
    expect(read).not.toBeNull();
    expect(read!.conversationId).toBeUndefined();
  });

  it("不存在的 draft 返回 null", () => {
    expect(repo.read("none")).toBeNull();
  });

  it("deleteDraft", () => {
    repo.write(sampleDraft("conv-1"));
    repo.delete("conv-1");
    expect(repo.read("conv-1")).toBeNull();
  });
});
