/**
 * 消息服务的验收：A12 的三种取法（不给 / 命中 / 未命中）、`toolCallId` 过滤，
 * 以及「存储行 → core 消息」的还原（R21 / R22：字段名与取值全部照 core）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../storage/Database.js";
import { SessionRepository } from "../storage/SessionRepository.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { HostError } from "../wire/errors.js";
import { MessageService } from "./MessageService.js";

let dir: string;
let db: Database;
let service: MessageService;
let messages: MessageRepository;
let sessions: SessionRepository;

/**
 * 清表：整个文件共用一个库，每个用例开头把上一个用例写进去的行清掉。
 *
 * `meta` 不能清 —— `migrate` 靠 `meta.schemaVersion` 判断要不要跑迁移；
 * `messages_fts` 不用手动同步 —— `DELETE FROM workspaces` 级联删 `messages` 时触发器自己维护。
 */
async function clearTables(): Promise<void> {
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-messages-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  sessions = new SessionRepository(db);
  messages = new MessageRepository(db);
  service = new MessageService({ sessions, messages });
});

beforeEach(async () => {
  await clearTables();

  const workspaces = new WorkspaceRepository(db);
  await workspaces.create({ id: "w1", name: "项目一", cwd: "/tmp/one", createdAt: 1 });
  await sessions.create({
    id: "c1",
    workspaceId: "w1",
    name: "2026-11-12 10:00",
    agentId: "a1",
    modelId: "m1",
    createdAt: 10,
  });
  await sessions.create({
    id: "c2",
    workspaceId: "w1",
    name: "另一段",
    agentId: "a1",
    modelId: "m1",
    createdAt: 20,
  });

  await messages.upsert({
    id: "u1",
    sessionId: "c1",
    role: "user",
    status: "completed",
    content: "第一句",
    createdAt: 100,
  });
  await messages.upsert({
    id: "a1",
    sessionId: "c1",
    role: "assistant",
    status: "completed",
    content: "第一句的回复",
    createdAt: 200,
  });
  await messages.upsert({
    id: "u2",
    sessionId: "c1",
    role: "user",
    status: "completed",
    content: "第二句",
    createdAt: 300,
  });
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("MessageService.list 的取法（A12）", () => {
  it("不给 after 时返回整段历史，anchor 为空", async () => {
    const result = await service.list({ sessionId: "c1" });
    expect(result.sessionId).toBe("c1");
    expect(result.anchor).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("after 命中时从它本身开始（含它），并报出 anchor", async () => {
    const result = await service.list({ sessionId: "c1", after: "a1" });
    expect(result.anchor).toBe("a1");
    expect(result.messages.map((message) => message.id)).toEqual(["a1", "u2"]);
  });

  it("after 命中流式中那条时读到的是它最新的内容", async () => {
    await messages.upsert({
      id: "a2",
      sessionId: "c1",
      role: "assistant",
      status: "writing",
      content: "还没写完",
      createdAt: 400,
    });
    await messages.upsert({
      id: "a2",
      sessionId: "c1",
      role: "assistant",
      status: "completed",
      content: "写完了",
      createdAt: 400,
    });

    const result = await service.list({ sessionId: "c1", after: "a2" });
    expect(result.anchor).toBe("a2");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe("写完了");
    expect(result.messages[0]?.status).toBe(AgentNS.MessageStatus.Completed);
  });

  it("after 在库里不存在时返回全部，anchor 为空", async () => {
    const result = await service.list({ sessionId: "c1", after: "已经被删掉的 id" });
    expect(result.anchor).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("after 属于别的会话时也按「没命中」处理", async () => {
    await messages.upsert({
      id: "other",
      sessionId: "c2",
      role: "user",
      status: "completed",
      content: "别处的消息",
      createdAt: 50,
    });

    const result = await service.list({ sessionId: "c1", after: "other" });
    expect(result.anchor).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("会话不存在时报 not_found", async () => {
    await expect(service.list({ sessionId: "没有这段会话" })).rejects.toBeInstanceOf(HostError);
  });

  it("toolCallId 要subagent 那一栏：库里没有第二份可读，于是给空页（F-I7 / CORE §17）", async () => {
    // 那次委派本身：assistant 发出工具调用，工具结果也挂着同一个工具调用 id
    await messages.upsert({
      id: "tool-1",
      sessionId: "c1",
      role: "tool",
      status: "completed",
      content: "subagent 的结果",
      data: { tool_call_id: "call-1" },
      createdAt: 500,
    });

    // subagent 的话不入库（`CORE.md` §17）：这段没有 agent 时，那一栏就是空的 ——
    // 库里没有第二份（`parentToolCallId` 那一列已随 v5 删掉）
    const result = await service.list({ sessionId: "c1", toolCallId: "call-1" });
    expect(result.messages).toEqual([]);
  });

  it("hidden 的消息默认不返回，includeHidden 才给（F-D9 的 cwd 消息）", async () => {
    await messages.upsert({
      id: "cwd",
      sessionId: "c1",
      role: "user",
      status: "completed",
      content: "/tmp/one",
      data: { hidden: true },
      createdAt: 5,
    });

    const page = await service.list({ sessionId: "c1" });
    expect(page.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);

    const withHidden = await service.list({ sessionId: "c1", includeHidden: true });
    // 按 `seq` 排：这条最后写进去，所以排在三条之后
    expect(withHidden.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2", "cwd"]);
    const cwdMessage = withHidden.messages.at(-1);
    expect(cwdMessage?.hidden).toBe(true);
    expect(cwdMessage?.content).toBe("/tmp/one");
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
          thinkingLevel: null,
          compactedAt: null,
          compactionMode: null,
          // 草稿也是会话行形状：v4 那四列在草稿阶段就已定下（开关关、没有血缘）
          handoffThreshold: null,
          guardThreshold: null,
          autoHandoff: false,
          lineage: null,
          // 刚建出来 / 没答过交接题：没有待交接
          pendingHandoff: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);
    const withDrafts = new MessageService({
      sessions,
      messages,
      drafts: { get: (id: string) => drafts.get(id) },
    });

    const page = await withDrafts.list({ sessionId: "draft-1" });
    expect(page.messages).toEqual([]);
    await expect(withDrafts.list({ sessionId: "没有这段会话" })).rejects.toBeInstanceOf(
      HostError,
    );
  });
});

describe("活着读内存，死了读库（PLAN §7）", () => {
  /** 一份「内存里长这样」的口：给什么就回什么，`null` 表示我这边没有 */
  function liveOf(answer: (id: string, options?: { toolCallId?: string }) => AgentNS.Message[] | null) {
    return new MessageService({
      sessions,
      messages,
      live: { messagesOf: (id, options) => answer(id, options) },
    });
  }

  const inMemory: AgentNS.Message[] = [
    { id: "live-1", role: AgentNS.Role.User, status: AgentNS.MessageStatus.Completed, content: "内存第一条" },
    { id: "live-2", role: AgentNS.Role.Assistant, status: AgentNS.MessageStatus.Completed, content: "内存第二条" },
    { id: "live-hidden", role: AgentNS.Role.User, status: AgentNS.MessageStatus.Completed, content: "交接注入的", hidden: true },
    { id: "live-3", role: AgentNS.Role.User, status: AgentNS.MessageStatus.Completed, content: "内存第三条" },
  ];

  it("有 agent 就用内存那一份（顺序即数组顺序，不是库里的 seq）", async () => {
    const live = liveOf(() => inMemory);
    const page = await live.list({ sessionId: "c1" });
    // 库里那三条一条都不该出现：内存那份才是真身
    expect(page.messages.map((message) => message.id)).toEqual(["live-1", "live-2", "live-3"]);
    expect(page.anchor).toBeNull();
  });

  it("`after` / `around` / `includeHidden` 都在那个数组上算", async () => {
    const live = liveOf(() => inMemory);

    const after = await live.list({ sessionId: "c1", after: "live-2" });
    expect(after.anchor).toBe("live-2");
    expect(after.messages.map((message) => message.id)).toEqual(["live-2", "live-3"]);

    // `after` 不在 → 全量 + 空 anchor
    const miss = await live.list({ sessionId: "c1", after: "没有这条" });
    expect(miss.anchor).toBeNull();
    expect(miss.messages.map((message) => message.id)).toEqual(["live-1", "live-2", "live-3"]);

    // `around` 命中：窗口收在数组上（这几条全在窗口里）
    const around = await live.list({ sessionId: "c1", around: "live-2" });
    expect(around.anchor).toBe("live-2");
    expect(around.messages.map((message) => message.id)).toEqual([
      "live-1",
      "live-2",
      "live-3",
    ]);

    // `around` 不在 → 空页 + 空 anchor，不报错
    const empty = await live.list({ sessionId: "c1", around: "没有这条" });
    expect(empty).toEqual({ sessionId: "c1", anchor: null, messages: [] });

    // `hidden` 默认不给人看，要就显式要
    const withHidden = await live.list({ sessionId: "c1", includeHidden: true });
    expect(withHidden.messages.map((message) => message.id)).toEqual([
      "live-1",
      "live-2",
      "live-hidden",
      "live-3",
    ]);
  });

  it("subagent 那一栏：名册上有就取它自己的消息，没有才回落到库", async () => {
    const sub: AgentNS.Message[] = [
      { id: "sub-1", role: AgentNS.Role.User, status: AgentNS.MessageStatus.Completed, content: "派活" },
      { id: "sub-2", role: AgentNS.Role.Assistant, status: AgentNS.MessageStatus.Completed, content: "做完了" },
    ];
    const live = liveOf((_id, options) => (options?.toolCallId === "call-1" ? sub : null));

    const page = await live.list({ sessionId: "c1", toolCallId: "call-1" });
    expect(page.messages.map((message) => message.id)).toEqual(["sub-1", "sub-2"]);

    // 名册上没有这一项（那一批翻过去了 / 进程重启过）→ `null` → 读库（旧行那条路）
    const fallback = await live.list({ sessionId: "c1", toolCallId: "call-9" });
    expect(fallback.messages).toEqual([]);
  });
});

describe("MessageService.list 的 around（F-C6 的定位）", () => {
  /** 往一段新会话里灌 n 条按顺序的消息；`around` 要足够的条数才看得出「窗口」 */
  async function seedLong(count: number): Promise<void> {
    await sessions.create({
      id: "c-long",
      workspaceId: "w1",
      name: "很长的会话",
      agentId: "a1",
      modelId: "m1",
      createdAt: 30,
    });
    for (let i = 1; i <= count; i += 1) {
      await messages.upsert({
        id: `m${i}`,
        sessionId: "c-long",
        role: i % 2 === 0 ? "assistant" : "user",
        status: "completed",
        content: `第 ${i} 条`,
        createdAt: 1_000 + i,
      });
    }
  }

  it("以命中那条为中心取一窗：前后尽量均分，命中那条在里面", async () => {
    await seedLong(50);

    const page = await service.list({ sessionId: "c-long", around: "m25" });

    expect(page.sessionId).toBe("c-long");
    expect(page.anchor).toBe("m25");
    expect(page.messages).toHaveLength(40);
    // 前面 19 条、后面 20 条：命中那条左右都够看
    expect(page.messages[0]?.id).toBe("m6");
    expect(page.messages.at(-1)?.id).toBe("m45");
    expect(page.messages[19]?.id).toBe("m25");
  });

  it("命中靠近两端时窗口自然短一些（不往回补别的消息）", async () => {
    await seedLong(50);

    const head = await service.list({ sessionId: "c-long", around: "m1" });
    expect(head.anchor).toBe("m1");
    expect(head.messages[0]?.id).toBe("m1");
    expect(head.messages).toHaveLength(21);

    const tail = await service.list({ sessionId: "c-long", around: "m50" });
    expect(tail.anchor).toBe("m50");
    expect(tail.messages.at(-1)?.id).toBe("m50");
    expect(tail.messages).toHaveLength(20);
  });

  it("命中不存在时给空页，不报错（消息可能刚被撤回）", async () => {
    await seedLong(5);

    const gone = await service.list({ sessionId: "c-long", around: "已经撤回的 id" });
    expect(gone.sessionId).toBe("c-long");
    expect(gone.anchor).toBeNull();
    expect(gone.messages).toEqual([]);

    // 属于别的会话的 id 同样是「没命中」
    const other = await service.list({ sessionId: "c-long", around: "u1" });
    expect(other.anchor).toBeNull();
    expect(other.messages).toEqual([]);
  });

  it("与 after 同时给时 around 优先，after 被忽略", async () => {
    await seedLong(50);

    const both = await service.list({ sessionId: "c-long", around: "m25", after: "m40" });
    const only = await service.list({ sessionId: "c-long", around: "m25" });

    expect(both).toEqual(only);
    expect(both.anchor).toBe("m25");
    expect(both.messages.map((message) => message.id)).toEqual(
      only.messages.map((message) => message.id),
    );
  });

  it("hidden 的消息要不到就是空页，includeHidden 才定位得到它", async () => {
    await messages.upsert({
      id: "cwd",
      sessionId: "c1",
      role: "user",
      status: "completed",
      content: "/tmp/one",
      data: { hidden: true },
      createdAt: 5,
    });

    const hidden = await service.list({ sessionId: "c1", around: "cwd" });
    expect(hidden.anchor).toBeNull();
    expect(hidden.messages).toEqual([]);

    const withHidden = await service.list({
      sessionId: "c1",
      around: "cwd",
      includeHidden: true,
    });
    expect(withHidden.anchor).toBe("cwd");
    expect(withHidden.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2", "cwd"]);
  });

  it("toolCallId 那一栏在库里没有第二份：空页、不报错", async () => {
    const delegated = await service.list({
      sessionId: "c1",
      toolCallId: "call-1",
      around: "u1",
    });
    // subagent 的话不入库（`CORE.md` §17）：没有 agent 时那一栏就是空的
    expect(delegated.messages).toEqual([]);
  });

  it("around 为空串时按没给处理（照旧给整段历史）", async () => {
    const page = await service.list({ sessionId: "c1", around: "" });
    expect(page.anchor).toBeNull();
    expect(page.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });
});

describe("消息还原成 core 的形状（R21 / R22）", () => {
  it("内容段、工具调用、思考、用量、状态都按 core 的字段名还原", async () => {
    await messages.upsert({
      id: "rich",
      sessionId: "c1",
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

    // 这条带 `hidden`：默认读取不返回它，显式要才给（`hidden` = 这条不给人看）
    const result = await service.list({ sessionId: "c1", after: "rich", includeHidden: true });
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
      sessionId: "c1",
      role: "user",
      status: "completed",
      content,
      createdAt: 800,
    });

    const result = await service.list({ sessionId: "c1", after: "sections" });
    // 逐段重建会把 `index`、`detail`、`filename` 这类字段丢掉，这里是原样那一份
    expect(result.messages[0]?.content).toEqual(content);
  });

  it("没有正文的消息不带 content 键（core 的 content 是可选的）", async () => {
    await messages.upsert({
      id: "no-content",
      sessionId: "c1",
      role: "assistant",
      status: "completed",
      createdAt: 900,
    });

    const result = await service.list({ sessionId: "c1", after: "no-content" });
    expect(Object.keys(result.messages[0] ?? {})).not.toContain("content");
  });

  it("认不出的角色与状态归 unknown，不猜", async () => {
    await messages.upsert({
      id: "weird",
      sessionId: "c1",
      role: "外来角色",
      status: "外来状态",
      content: "x",
      createdAt: 700,
    });

    const result = await service.list({ sessionId: "c1", after: "weird" });
    expect(result.messages[0]?.role).toBe(AgentNS.Role.Unknown);
    expect(result.messages[0]?.status).toBe(AgentNS.MessageStatus.Unknown);
  });
});
