import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  listConversations,
  readConversation,
  writeConversation,
  deleteConversation,
} from "./conversations";
import { readDraft, writeDraft, deleteDraft } from "./drafts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Conversation, Draft } from "../types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-crud-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleConversation(id: string): Conversation {
  return {
    id,
    agentId: "agent-1",
    modelId: "model-1",
    messages: [{ role: "user", content: "hello" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function sampleDraft(conversationId?: string): Draft {
  return {
    conversationId,
    agentId: "agent-1",
    modelId: "model-1",
    messages: [{ role: "user", content: "draft message" }],
    updatedAt: new Date().toISOString(),
  };
}

// ---- Conversations ----

describe("conversations", () => {
  it("write + read", () => {
    const conv = sampleConversation("c1");
    writeConversation(dir, conv);
    const read = readConversation(dir, "c1");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("c1");
  });

  it("不存在的返回 null", () => {
    expect(readConversation(dir, "nope")).toBeNull();
  });

  it("列出全部", () => {
    writeConversation(dir, sampleConversation("a"));
    writeConversation(dir, sampleConversation("b"));
    expect(listConversations(dir)).toHaveLength(2);
  });

  it("删除", () => {
    writeConversation(dir, sampleConversation("x"));
    deleteConversation(dir, "x");
    expect(readConversation(dir, "x")).toBeNull();
  });
});

// ---- Drafts ----

describe("drafts", () => {
  it("已命名 draft write + read", () => {
    const draft = sampleDraft("conv-1");
    writeDraft(dir, draft);
    const read = readDraft(dir, "conv-1");
    expect(read).not.toBeNull();
    expect(read!.conversationId).toBe("conv-1");
  });

  it("未命名 draft（_current）", () => {
    const draft = sampleDraft(); // 无 conversationId
    writeDraft(dir, draft);
    const read = readDraft(dir);
    expect(read).not.toBeNull();
    expect(read!.conversationId).toBeUndefined();
  });

  it("不存在的 draft 返回 null", () => {
    expect(readDraft(dir, "none")).toBeNull();
  });

  it("deleteDraft", () => {
    writeDraft(dir, sampleDraft("conv-1"));
    deleteDraft(dir, "conv-1");
    expect(readDraft(dir, "conv-1")).toBeNull();
  });
});
