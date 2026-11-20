/**
 * `MessageRepository` 的验收：边流边写的 upsert、`payload` 原样往返、seq 单调、`after` 三种
 * 分支，以及全文检索在中文下的行为（>= 3 字走 FTS5 trigram，2 字退化到 LIKE）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError, AgentNS } from "@ai-zen/agents-core";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { MessageRepository } from "./MessageRepository.js";
import type { MessageUpsertInput } from "./types.js";

let dir: string;
let db: Database;
let repo: MessageRepository;

// 库与迁移整个文件只做一次（起 worker + migrate 是每条用例的大头），每个用例只清表。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-messages-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new MessageRepository(db);
});

beforeEach(async () => {
  await db.tx((tx) => [
    // meta 不清：migrate 靠它判断跑不跑
    tx.run("DELETE FROM notices"),
    // workspaces 必须在 assets 之前：删 workspace 级联删掉 session_assets 关系行，
    // 之后 assets 的 ON DELETE RESTRICT 才不会拦。messages 的 FTS 索引由触发器跟着维护
    tx.run("DELETE FROM workspaces"), // 级联 sessions → messages → session_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);

  // 两个 workspace，三个会话：搜索的三种范围都要有数据才测得出来
  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/project-one",
    1,
  ]);
  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w2",
    "项目二",
    "/tmp/project-two",
    2,
  ]);
  for (const [id, workspaceId, name, createdAt] of [
    ["c1", "w1", "会话一", 10],
    ["c2", "w1", "会话二", 20],
    ["c3", "w2", "会话三", 30],
  ] as const) {
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, workspaceId, name, "agent-1", "model-1", createdAt, createdAt],
    );
  }
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * 造一条写入：`message` 就是 core 的那一条（`id` 与这一行的 `id` 是同一个），
 * 仓储把它原样存进 `payload`。
 */
function message(input: {
  id: string;
  sessionId?: string;
  createdAt?: number;
  message?: Partial<AgentNS.Message>;
}): MessageUpsertInput {
  return {
    sessionId: "c1",
    createdAt: 100,
    ...input,
    message: {
      id: input.id,
      role: AgentNS.Role.User,
      status: AgentNS.MessageStatus.Completed,
      content: "",
      ...input.message,
    },
  };
}

describe("MessageRepository.upsert", () => {
  it("写入后能原样读回整条消息（正文、附加字段、omit 都在它身上）", async () => {
    await repo.upsert(
      message({
        id: "m1",
        message: { content: "你好，世界", omit: true, name: "user", hidden: false },
      }),
    );

    const stored = await repo.get("m1");
    expect(stored?.message.content).toBe("你好，世界");
    expect(stored?.message.omit).toBe(true);
    expect(stored?.message.name).toBe("user");
    expect(stored?.message.hidden).toBe(false);
    expect(stored?.seq).toBe(1);
  });

  it("`payload` 一个键都不动：不认识的字段照样存、照样读回来", async () => {
    // core 的 `Message` 上没这一格；能原样回来才说明「写进去什么、读出来还是什么」
    const payload = {
      id: "m-raw",
      role: AgentNS.Role.Assistant,
      status: AgentNS.MessageStatus.Completed,
      content: "整条存",
      subAgentUsage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      将来的字段: { 嵌套: true },
    } as unknown as AgentNS.Message;

    await repo.upsert({ id: "m-raw", sessionId: "c1", createdAt: 100, message: payload });

    const stored = await repo.get("m-raw");
    expect(stored?.message).toEqual(payload);
  });

  it("消息自带的 `error` 跟着 payload 走：存进去什么就回来什么", async () => {
    const error = new AgentError("request-failed", "连不上端点");
    await repo.upsert(message({ id: "m1", message: { content: "半截", error } }));

    const stored = await repo.get("m1");
    // `AgentError.toJSON()` 就是 `{ code, message }`（栈与 cause 不落库）
    expect(stored?.message.error).toEqual({ code: "request-failed", message: "连不上端点" });
  });

  it("同一条消息反复写：整条覆盖，但 seq 与 createdAt 不变", async () => {
    await repo.upsert(
      message({
        id: "m1",
        createdAt: 100,
        message: { status: AgentNS.MessageStatus.Pending, content: "部分" },
      }),
    );
    const first = await repo.get("m1");

    await repo.upsert(
      message({
        id: "m1",
        createdAt: 999,
        message: {
          status: AgentNS.MessageStatus.Aborted,
          content: "部分内容（已中止）",
          omit: true,
        },
      }),
    );
    const second = await repo.get("m1");

    expect(second?.message.content).toBe("部分内容（已中止）");
    expect(second?.message.status).toBe(AgentNS.MessageStatus.Aborted);
    expect(second?.message.omit).toBe(true);
    // 流式过程中不能越写越往后跳
    expect(second?.seq).toBe(first?.seq);
    expect(second?.createdAt).toBe(100);
    // 覆盖不是新增
    expect(await repo.countBySession("c1")).toBe(1);
  });

  it("seq 在一段会话内单调递增，换一段会话重新从 1 开始", async () => {
    await repo.upsert(message({ id: "m1" }));
    await repo.upsert(message({ id: "m2" }));
    await repo.upsert(message({ id: "m3" }));
    await repo.upsert(message({ id: "other", sessionId: "c2" }));

    const seqs = await db.all<{ id: string; seq: number }>(
      "SELECT id, seq FROM messages WHERE sessionId = 'c1' ORDER BY seq",
    );
    expect(seqs).toEqual([
      { id: "m1", seq: 1 },
      { id: "m2", seq: 2 },
      { id: "m3", seq: 3 },
    ]);
    expect((await repo.get("other"))?.seq).toBe(1);
  });

  it("upsertMany 是一个事务：中途失败则整批不落库", async () => {
    await expect(
      repo.upsertMany([
        message({ id: "ok-1" }),
        // 会话不存在 → 外键失败 → 前一条也要回滚
        message({ id: "bad", sessionId: "nope" }),
      ]),
    ).rejects.toThrow();

    expect(await repo.countBySession("c1")).toBe(0);
  });
});

describe("一条取法：库里只有主线消息（CORE §17 / v5）", () => {
  it("list 与 count 数的是同一批行（没有第二套取法可对）", async () => {
    await repo.upsert(message({ id: "m1", createdAt: 100 }));
    await repo.upsert(
      message({ id: "m2", createdAt: 200, message: { role: AgentNS.Role.Assistant } }),
    );
    // `hidden` 两边都不算：它在界面上从来没出现过。这一格由 SQLite 从 `payload` 取
    await repo.upsert(message({ id: "cwd", createdAt: 50, message: { hidden: true } }));

    const listed = await repo.listBySession("c1");
    expect(listed.map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(await repo.countBySession("c1")).toBe(listed.length);
  });
});

describe("MessageRepository.search", () => {
  const seed = async (): Promise<void> => {
    await repo.upsert(
      message({
        id: "m1",
        sessionId: "c1",
        createdAt: 100,
        message: { role: AgentNS.Role.User, content: "今天天气不错，我们去看海吧" },
      }),
    );
    await repo.upsert(
      message({
        id: "m2",
        sessionId: "c1",
        createdAt: 200,
        message: { role: AgentNS.Role.Assistant, content: "好的，海边风景很好" },
      }),
    );
    await repo.upsert(
      message({
        id: "m3",
        sessionId: "c2",
        createdAt: 300,
        message: { role: AgentNS.Role.User, content: "另一段会话讲的是数据库索引" },
      }),
    );
    await repo.upsert(
      message({
        id: "m4",
        sessionId: "c3",
        createdAt: 400,
        message: { role: AgentNS.Role.User, content: "第三个项目里提到了天气与海" },
      }),
    );
  };

  it("3 个汉字的中文子串能命中（FTS5 trigram）", async () => {
    await seed();
    const hits = await repo.search(undefined, "天气不", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m1"]);
    expect(hits[0]?.snippet).toContain("天气不");
  });

  it("2 个汉字查询退化成 LIKE 也能命中", async () => {
    await seed();
    // trigram 下 2 个字符必然搜不到，这条用例盯的就是仓储里的退化分支
    const hits = await repo.search(undefined, "天气", 10);
    expect(hits.map((hit) => hit.id).sort()).toEqual(["m1", "m4"]);
  });

  it("命中项把整条 `payload` 带回来：角色从消息上取，不由 SQL 拆", async () => {
    await seed();
    const hits = await repo.search({ sessionId: "c1" }, "海边风景", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m2"]);
    const message = JSON.parse(hits[0]!.payload) as AgentNS.Message;
    expect(message.role).toBe(AgentNS.Role.Assistant);
    expect(message.content).toBe("好的，海边风景很好");
    expect(Object.keys(hits[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "payload",
      "sessionId",
      "sessionName",
      "snippet",
      "workspaceId",
    ]);
  });

  it("3 字查询也能叠加范围过滤（FTS 分支带 join）", async () => {
    await seed();
    // 3 个字 → 走 FTS5 分支，同时按会话 / 按 Workspace 过滤
    expect((await repo.search({ sessionId: "c1" }, "天气不", 10)).map((hit) => hit.id)).toEqual([
      "m1",
    ]);
    expect((await repo.search({ sessionId: "c2" }, "天气不", 10)).map((hit) => hit.id)).toEqual([]);
    expect((await repo.search({ workspaceId: "w1" }, "天气不", 10)).map((hit) => hit.id)).toEqual([
      "m1",
    ]);
    expect((await repo.search({ workspaceId: "w2" }, "天气不", 10)).map((hit) => hit.id)).toEqual(
      [],
    );
    // c3 明明含有「天气与海」，但它属于 w2，被 w1 的过滤条件挡住
    expect((await repo.search({ workspaceId: "w2" }, "天气与", 10)).map((hit) => hit.id)).toEqual([
      "m4",
    ]);
  });

  it("改过内容之后，旧词搜不到、新词搜得到（FTS 触发器跟着更新）", async () => {
    await seed();
    await repo.upsert(
      message({
        id: "m1",
        sessionId: "c1",
        createdAt: 100,
        message: { content: "今天下雨，不去看海了" },
      }),
    );

    expect(await repo.search(undefined, "天气不", 10)).toEqual([]);
    expect((await repo.search(undefined, "今天下雨", 10)).map((hit) => hit.id)).toEqual(["m1"]);
  });

  it("关键词里的特殊符号不会把查询语法搞坏", async () => {
    await seed();
    await repo.upsert(
      message({
        id: "m9",
        sessionId: "c1",
        createdAt: 500,
        message: { content: '他说 "完成度 100%" 就行了 AND OR NOT' },
      }),
    );

    await expect(repo.search(undefined, '100%"', 10)).resolves.toBeDefined();
    const hits = await repo.search(undefined, "完成度", 10);
    expect(hits.map((hit) => hit.id)).toEqual(["m9"]);
  });
});

describe("MessageRepository.deleteAfter（撤回，PRD D24）", () => {
  const seed = async (): Promise<void> => {
    await repo.upsert(message({ id: "m1", createdAt: 100 }));
    await repo.upsert(message({ id: "m2", createdAt: 200 }));
    await repo.upsert(message({ id: "m3", createdAt: 300 }));
    await repo.upsert(message({ id: "m4", createdAt: 400 }));
  };

  it("默认删掉锚点之后的消息", async () => {
    await seed();
    expect(await repo.deleteAfter("c1", "m2")).toBe(2);
    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("includeSelf 时连锚点一起删", async () => {
    await seed();
    expect(await repo.deleteAfter("c1", "m3", { includeSelf: true })).toBe(2);
    expect((await repo.listBySession("c1")).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("锚点不在该会话里时一条也不删", async () => {
    await seed();
    await repo.upsert(message({ id: "other", sessionId: "c2", createdAt: 500 }));
    expect(await repo.deleteAfter("c1", "other")).toBe(0);
    expect(await repo.countBySession("c1")).toBe(4);
  });
});
