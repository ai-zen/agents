/**
 * 搜索服务的验收：按名称搜对话（含高亮片段与摘要顺序）、按内容全文搜消息
 * （中文子串、范围过滤、分页与总数），D16 / F-C6。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import type { Conversation } from "../storage/types.js";
import type { ConversationSummary } from "../wire/index.js";
import type { ConversationSummarizer } from "./SearchService.js";
import { SearchService } from "./SearchService.js";

let dir: string;
let db: Database;
let service: SearchService;
let conversations: ConversationRepository;
let messages: MessageRepository;

/**
 * 摘要由对话服务提供；这里按「入参顺序即出参顺序」的约定给一份最小实现，
 * 顺便记录服务是不是真的把它传了下来。
 */
function fakeSummarizer(): ConversationSummarizer & { calls: string[][] } {
  const calls: string[][] = [];
  const summarize = async (rows: Conversation[]): Promise<ConversationSummary[]> => {
    calls.push(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      nameIsAuto: false,
      pinned: row.pinned,
      agentId: row.agentId ?? "",
      modelId: row.modelId ?? "",
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      messageCount: 0,
      lastMessageAt: null,
      running: false,
      // 搜索服务不关心运行状态：这一格按「没在跑」给
      run: null,
      hasPendingQuestion: false,
    }));
  };
  return Object.assign(summarize, { calls });
}

let summarizer: ReturnType<typeof fakeSummarizer>;

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-search-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）。
  // `messages` 的 FTS 索引由 messages_fts_* 触发器跟着级联删除维护，不用手动同步。
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);

  const workspaces = new WorkspaceRepository(db);
  summarizer = fakeSummarizer();
  service = new SearchService({ conversations, messages, summarize: summarizer });

  await workspaces.create({ id: "w1", name: "项目一", cwd: "/tmp/one", createdAt: 1 });
  await workspaces.create({ id: "w2", name: "项目二", cwd: "/tmp/two", createdAt: 2 });
  await conversations.create({
    id: "c1",
    workspaceId: "w1",
    name: "数据库索引重构计划",
    agentId: "a1",
    modelId: "m1",
    createdAt: 10,
  });
  await conversations.create({
    id: "c2",
    workspaceId: "w2",
    name: "周末的闲聊",
    agentId: "a1",
    modelId: "m1",
    createdAt: 20,
  });

  await messages.upsert({
    id: "msg-1",
    conversationId: "c1",
    role: "user",
    status: "completed",
    content: "今天天气不错，我们去看海吧",
    createdAt: 100,
  });
  await messages.upsert({
    id: "msg-2",
    conversationId: "c2",
    role: "assistant",
    status: "completed",
    content: "第三个项目里提到了天气与海",
    createdAt: 200,
  });
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("SearchService.conversations（按名称）", () => {
  it("命中名字并回高亮片段，摘要按同一顺序带上", async () => {
    const result = await service.conversations({ query: "索引" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.conversation.id).toBe("c1");
    expect(result.hits[0]?.matchedName).toBe("索引");
    expect(summarizer.calls).toEqual([["c1"]]);
  });

  it("高亮片段取名字里命中的那一段（大小写无关）", async () => {
    await conversations.create({
      id: "c3",
      workspaceId: "w1",
      name: "Fix The Parser",
      agentId: "a1",
      modelId: "m1",
      createdAt: 30,
    });
    const result = await service.conversations({ query: "the" });
    expect(result.hits[0]?.matchedName).toBe("The");
  });

  it("可按 Workspace 过滤", async () => {
    await conversations.create({
      id: "c3",
      workspaceId: "w2",
      name: "索引笔记",
      agentId: "a1",
      modelId: "m1",
      createdAt: 30,
    });

    expect(
      (await service.conversations({ query: "索引" })).hits.map((hit) => hit.conversation.id),
    ).toEqual(["c3", "c1"]);
    expect(
      (await service.conversations({ query: "索引", workspaceId: "w1" })).hits.map(
        (hit) => hit.conversation.id,
      ),
    ).toEqual(["c1"]);
  });

  it("空查询回空结果，不当错误", async () => {
    expect(await service.conversations({ query: "   " })).toEqual({ hits: [] });
  });

  it("LIKE 的通配符不会变成任意匹配", async () => {
    await conversations.create({
      id: "c4",
      workspaceId: "w1",
      name: "完成度 100% 的那次",
      agentId: "a1",
      modelId: "m1",
      createdAt: 40,
    });
    expect((await service.conversations({ query: "100%" })).hits.map((hit) => hit.conversation.id)).toEqual([
      "c4",
    ]);
    expect((await service.conversations({ query: "%" })).hits.map((hit) => hit.conversation.id)).toEqual([
      "c4",
    ]);
  });

  it("limit 生效", async () => {
    const result = await service.conversations({ query: "的", limit: 1 });
    expect(result.hits).toHaveLength(1);
  });
});

describe("SearchService.messages（按内容）", () => {
  it("3 个字以上的中文子串能命中，并带上对话名与角色", async () => {
    const result = await service.messages({ query: "天气不" });
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["msg-1"]);
    expect(result.hits[0]).toMatchObject({
      conversationId: "c1",
      conversationName: "数据库索引重构计划",
      role: AgentNS.Role.User,
    });
    expect(result.hits[0]?.createdAt).toBe(new Date(100).toISOString());
    expect(result.hits[0]?.snippet).toContain("天气不");
  });

  it("2 个字的查询也能命中（STORAGE 层退化到 LIKE）", async () => {
    const result = await service.messages({ query: "天气" });
    expect(result.hits.map((hit) => hit.messageId).sort()).toEqual(["msg-1", "msg-2"]);
  });

  it("可按 Workspace 过滤", async () => {
    const result = await service.messages({ query: "天气", workspaceId: "w2" });
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["msg-2"]);
  });

  it("可按对话过滤", async () => {
    const result = await service.messages({ query: "天气", conversationId: "c1" });
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["msg-1"]);
  });

  it("空查询回空结果与零总数", async () => {
    expect(await service.messages({ query: "  " })).toEqual({ hits: [], total: 0 });
  });

  it("offset 由服务层切片：翻页取到的是不同的一条", async () => {
    const first = await service.messages({ query: "天气", limit: 1 });
    expect(first.hits).toHaveLength(1);

    const second = await service.messages({ query: "天气", limit: 1, offset: 1 });
    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]?.messageId).not.toBe(first.hits[0]?.messageId);
  });

  it("total 在取数上限内是准确条数，超了就是个下界（见 PRD R36）", async () => {
    expect((await service.messages({ query: "天气", limit: 10 })).total).toBe(2);
    // 只取 1 条时仓储没告诉我们一共有多少条，只能给出「至少这么多」
    expect((await service.messages({ query: "天气", limit: 1 })).total).toBe(1);
  });
});
