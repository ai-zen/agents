/**
 * 消息服务的验收：A12 的三种取法（不给 / 命中 / 未命中）、`toolCallId` 过滤，
 * 以及「存储行 → core 消息」的还原（R21 / R22：字段名与取值全部照 core）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../storage/Database.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { ServerError } from "../wire/errors.js";
import { MessageService } from "./MessageService.js";

let dir: string;
let db: Database;
let service: MessageService;
let messages: MessageRepository;
let conversations: ConversationRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-messages-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  const workspaces = new WorkspaceRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  service = new MessageService({ conversations, messages });

  await workspaces.create({ id: "w1", name: "项目一", cwd: "/tmp/one", createdAt: 1 });
  await conversations.create({
    id: "c1",
    workspaceId: "w1",
    name: "2026-11-12 10:00",
    agentId: "a1",
    modelId: "m1",
    createdAt: 10,
  });
  await conversations.create({
    id: "c2",
    workspaceId: "w1",
    name: "另一段",
    agentId: "a1",
    modelId: "m1",
    createdAt: 20,
  });

  await messages.upsert({
    id: "u1",
    conversationId: "c1",
    role: "user",
    status: "completed",
    content: "第一句",
    createdAt: 100,
  });
  await messages.upsert({
    id: "a1",
    conversationId: "c1",
    role: "assistant",
    status: "completed",
    content: "第一句的回复",
    createdAt: 200,
  });
  await messages.upsert({
    id: "u2",
    conversationId: "c1",
    role: "user",
    status: "completed",
    content: "第二句",
    createdAt: 300,
  });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("MessageService.list 的取法（A12）", () => {
  it("不给 after 时返回整段历史，anchor 为空", async () => {
    const result = await service.list({ conversationId: "c1" });
    expect(result.conversationId).toBe("c1");
    expect(result.anchor).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("after 命中时从它本身开始（含它），并报出 anchor", async () => {
    const result = await service.list({ conversationId: "c1", after: "a1" });
    expect(result.anchor).toBe("a1");
    expect(result.messages.map((message) => message.id)).toEqual(["a1", "u2"]);
  });

  it("after 命中流式中那条时读到的是它最新的内容", async () => {
    await messages.upsert({
      id: "a2",
      conversationId: "c1",
      role: "assistant",
      status: "writing",
      content: "还没写完",
      createdAt: 400,
    });
    await messages.upsert({
      id: "a2",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      content: "写完了",
      createdAt: 400,
    });

    const result = await service.list({ conversationId: "c1", after: "a2" });
    expect(result.anchor).toBe("a2");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe("写完了");
    expect(result.messages[0]?.status).toBe(AgentNS.MessageStatus.Completed);
  });

  it("after 在库里不存在时返回全部，anchor 为空", async () => {
    const result = await service.list({ conversationId: "c1", after: "已经被删掉的 id" });
    expect(result.anchor).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("after 属于别的对话时也按「没命中」处理", async () => {
    await messages.upsert({
      id: "other",
      conversationId: "c2",
      role: "user",
      status: "completed",
      content: "别处的消息",
      createdAt: 50,
    });

    const result = await service.list({ conversationId: "c1", after: "other" });
    expect(result.anchor).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("对话不存在时报 not_found", async () => {
    await expect(service.list({ conversationId: "没有这段对话" })).rejects.toBeInstanceOf(ServerError);
  });

  it("toolCallId 取回子 Agent 自己的消息（按 parentToolCallId，F-I7）", async () => {
    // 那次委派本身：assistant 发出工具调用，工具结果也挂着同一个工具调用 id
    await messages.upsert({
      id: "tool-1",
      conversationId: "c1",
      role: "tool",
      status: "completed",
      content: "子 Agent 的结果",
      data: { tool_call_id: "call-1" },
      createdAt: 500,
    });
    // 子 Agent 自己说过的话：落库时记下它是哪次委派里说的
    for (const [id, role, content] of [
      ["sub-1", "user", "把方案 A 说一下"],
      ["sub-2", "assistant", "方案 A 是……"],
    ] as const) {
      await messages.upsert({
        id,
        conversationId: "c1",
        role,
        status: "completed",
        content,
        parentToolCallId: "call-1",
        createdAt: 510,
      });
    }

    const result = await service.list({ conversationId: "c1", toolCallId: "call-1" });
    expect(result.messages.map((message) => message.id)).toEqual(["sub-1", "sub-2"]);
    expect(result.messages.map((message) => message.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
    ]);
  });

  it("子 Agent 的消息不混进主线历史（否则模型下一轮会把别人的对话当上下文）", async () => {
    await messages.upsert({
      id: "sub-1",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      content: "子 Agent 说的",
      parentToolCallId: "call-1",
      createdAt: 900,
    });

    const result = await service.list({ conversationId: "c1" });
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("还没落库的草稿也能读：空消息、不是 not_found（R56）", async () => {
    const drafts = new Map([
      [
        "draft-1",
        {
          id: "draft-1",
          workspaceId: "w1",
          name: "2026-11-12 10:00",
          nameIsAuto: true,
          pinned: false,
          agentId: "a1",
          modelId: "m1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);
    const withDrafts = new MessageService({
      conversations,
      messages,
      drafts: { get: (id: string) => drafts.get(id) },
    });

    const page = await withDrafts.list({ conversationId: "draft-1" });
    expect(page.messages).toEqual([]);
    await expect(withDrafts.list({ conversationId: "没有这段对话" })).rejects.toBeInstanceOf(
      ServerError,
    );
  });
});

describe("消息还原成 core 的形状（R21 / R22）", () => {
  it("内容段、工具调用、思考、用量、状态都按 core 的字段名还原", async () => {
    await messages.upsert({
      id: "rich",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "https://example.test/a.png" } },
      ],
      data: {
        reasoning_content: "想了一下",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
        finish_reason: "tool_calls",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        hidden: true,
        omit: true,
        // 认不出的字段不该被搬到消息上
        未知字段: "x",
      },
      createdAt: 600,
    });

    const result = await service.list({ conversationId: "c1", after: "rich" });
    const message = result.messages[0];
    expect(message).toEqual({
      id: "rich",
      role: AgentNS.Role.Assistant,
      status: AgentNS.MessageStatus.Completed,
      omit: false,
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "https://example.test/a.png" } },
      ],
      reasoning_content: "想了一下",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      finish_reason: AgentNS.FinishReason.ToolCalls,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      hidden: true,
    });
    expect(Object.keys(message ?? {})).not.toContain("createdAt");
  });

  it("正文原样透传：内容段不逐段重建（R30）", async () => {
    const content = [
      { index: 0, type: "text" as const, text: "看这两个文件" },
      { index: 1, type: "image_url" as const, image_url: { url: "https://example.test/a.png", detail: "low" as const } },
      { index: 2, type: "file" as const, file_id: "file-1", filename: "a.pdf" },
    ];
    await messages.upsert({
      id: "sections",
      conversationId: "c1",
      role: "user",
      status: "completed",
      content,
      createdAt: 800,
    });

    const result = await service.list({ conversationId: "c1", after: "sections" });
    // 逐段重建会把 `index`、`detail`、`filename` 这类字段丢掉，这里是原样那一份
    expect(result.messages[0]?.content).toEqual(content);
  });

  it("没有正文的消息不带 content 键（core 的 content 是可选的）", async () => {
    await messages.upsert({
      id: "no-content",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      createdAt: 900,
    });

    const result = await service.list({ conversationId: "c1", after: "no-content" });
    expect(Object.keys(result.messages[0] ?? {})).not.toContain("content");
  });

  it("认不出的角色与状态归 unknown，不猜", async () => {
    await messages.upsert({
      id: "weird",
      conversationId: "c1",
      role: "外来角色",
      status: "外来状态",
      content: "x",
      createdAt: 700,
    });

    const result = await service.list({ conversationId: "c1", after: "weird" });
    expect(result.messages[0]?.role).toBe(AgentNS.Role.Unknown);
    expect(result.messages[0]?.status).toBe(AgentNS.MessageStatus.Unknown);
  });
});
