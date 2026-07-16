import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { autoDraft, checkDraftForRestore } from "./auto-draft";
import { readDraft } from "../crud/drafts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

function mockAgent(opts: { messages?: any[]; tools?: any[]; model?: any }): any {
  return {
    runtime: {
      config: {
        defaultModel: "m1",
        models: [{ id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 }],
        endpoints: [],
      },
    },
    lastUsage: undefined,
    messages: opts.messages ?? [{ role: "system", content: "You are a helper." }],
    tools: opts.tools ?? [],
    model: opts.model ?? {},
    send: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("autoDraft", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-zen-autodraft-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("返回一个 AgentPlugin（有 onAfterSend）", () => {
    const plugin = autoDraft({ draftsDir: dir, agentId: "agent-1" });
    expect(plugin).toBeDefined();
    expect(typeof plugin.onAfterSend).toBe("function");
  });

  it("onAfterSend 后写入 draft 文件（未命名 → _current.json）", async () => {
    const agent = mockAgent({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });

    const plugin = autoDraft({ draftsDir: dir, agentId: "agent-1" });
    await plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages });

    // 读取 _current.json
    const draft = readDraft(dir); // 无 conversationId → _current.json
    expect(draft).not.toBeNull();
    expect(draft!.agentId).toBe("agent-1");
    expect(draft!.conversationId).toBeUndefined();
    expect(draft!.messages).toHaveLength(3);
    expect(draft!.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(draft!.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(draft!.updatedAt).toBeDefined();
  });

  it("已命名对话写入 {conversationId}.json", async () => {
    const agent = mockAgent({
      messages: [{ role: "system", content: "Hi" }],
    });

    const plugin = autoDraft({
      draftsDir: dir,
      agentId: "agent-1",
      conversationId: "conv-123",
    });
    await plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages });

    const draft = readDraft(dir, "conv-123");
    expect(draft).not.toBeNull();
    expect(draft!.conversationId).toBe("conv-123");
  });

  it("多次 onAfterSend 会覆盖之前的 draft", async () => {
    const agent = mockAgent({
      messages: [{ role: "system", content: "Round 1" }],
    });

    const plugin = autoDraft({ draftsDir: dir, agentId: "agent-1" });
    await plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages });

    // 修改消息后再次保存
    agent.messages = [
      { role: "system", content: "Round 1" },
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ];
    await plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages });

    const draft = readDraft(dir);
    expect(draft!.messages).toHaveLength(3);
  });

  it("agent.messages 中的 tool 角色映射为 user", async () => {
    const agent = mockAgent({
      messages: [
        { role: "system", content: "Hi" },
        { role: "user", content: "read file" },
        { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "readFile" } }] },
        { role: "tool", content: "file contents..." },
        { role: "assistant", content: "File says: hello" },
      ],
    });

    const plugin = autoDraft({ draftsDir: dir, agentId: "agent-1" });
    await plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages });

    const draft = readDraft(dir);
    expect(draft).not.toBeNull();
    // tool 角色被映射为 user
    const roles = draft!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
  });

  it("写盘失败时不抛异常（目录不存在时自动创建）", async () => {
    const agent = mockAgent({
      messages: [{ role: "system", content: "Hi" }],
    });

    // 使用嵌套不存在的目录，writeDraft 应自动创建
    const nestedDir = join(dir, "sub1", "sub2");
    const plugin = autoDraft({ draftsDir: nestedDir, agentId: "agent-1" });

    // 不应抛异常
    await expect(
      plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages }),
    ).resolves.toBeUndefined();

    const draft = readDraft(nestedDir);
    expect(draft).not.toBeNull();
  });
});

// ==================================================================
// checkDraftForRestore
// ==================================================================

describe("checkDraftForRestore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-zen-autodraft-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("_current.json 不存在时返回 null", () => {
    const result = checkDraftForRestore(dir);
    expect(result).toBeNull();
  });

  it("_current.json 存在且未过期时返回 Draft", async () => {
    // 先写入一个 draft
    const agent = mockAgent({
      messages: [{ role: "system", content: "Unfinished work" }],
    });
    const plugin = autoDraft({ draftsDir: dir, agentId: "agent-1" });
    await plugin.onAfterSend!({ agent, content: "hello", messages: agent.messages });

    const result = checkDraftForRestore(dir);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-1");
    expect(result!.messages[0].content).toBe("Unfinished work");
  });

  it("过期后自动清理并返回 null", async () => {
    // 写入一个 8 天前的 draft（手动构造）
    const { writeDraft } = await import("../crud/drafts");
    const dayjs = (await import("dayjs")).default;
    const oldDate = dayjs().subtract(8, "day").toISOString();

    writeDraft(dir, {
      agentId: "old-agent",
      modelId: "m1",
      messages: [{ role: "system", content: "Old" }],
      updatedAt: oldDate,
    });

    const result = checkDraftForRestore(dir);
    expect(result).toBeNull();

    // _current.json 已被删除
    const draft = readDraft(dir);
    expect(draft).toBeNull();
  });
});
