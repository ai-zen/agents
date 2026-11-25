/**
 * 三条验收：会话行写进去读回来一模一样；置顶真的改变列表顺序（证明排序用的是库算出的生成列，
 * 而不是 JS 传下去的值）；`after` 从它本身开始而不是下一条（客户端重连时正在流式的那条内容
 * 已经变了，从下一条开始就会漏掉它）。
 *
 * 换记忆那一条在最后一节：三件事要么全成，要么一件都不留。
 */

import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { AgentNS, Message } from "@ai-zen/agents-core";

import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { workspaceTable } from "../workspace/table.js";
import { replaceMemory } from "./memory.js";
import { messageTable } from "./messages.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { NewSession, SessionRecord } from "./types.js";

/** 会话挂在外键上，所以每一个库都得先有一个项目行，不然插入会被 `foreign_keys` 拦住 */
function newDatabase() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  return db;
}

function newService(db = newDatabase()): SessionService {
  return new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t: createTranslator(() => "zh"),
  });
}

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameIsAuto: true,
  autoHandoff: false,
  lineage: null,
};

function message(id: string, text: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content: text,
  });
}

/** `seq` 不在任何一条读接口上（它只是排序用的），要断言它只能直接问库 */
function seqsOf(db: DatabaseSync, sessionId: string): number[] {
  return db
    .prepare("SELECT seq FROM messages WHERE sessionId = ? ORDER BY seq")
    .all(sessionId)
    .map((row) => Number(row.seq));
}

describe("会话行", () => {
  it("写进去读回来一模一样，改一格其余不变", () => {
    const service = newService();
    const created = service.create(input);
    expect(service.get(created.id)).toEqual(created);

    const renamed = service.update(created.id, { name: "新的名字" });
    expect(renamed).toEqual({ ...created, name: "新的名字", updatedAt: expect.any(Number) });
    expect(service.get(created.id)).toEqual(renamed);
  });

  /**
   * 删掉的那一格还留在旧库的 payload 里：那一行照样装得起来。
   *
   * 一张「一行一个 JSON」的表对多出来的键是宽容的（读路径整份 `JSON.parse` 之后按形状用），所以
   * 旧库不需要迁移；下一次写这一行时，那一格自然就没了。
   */
  it("旧库的行 payload 里还留着删掉的那一格，照样读得回来", () => {
    const db = newDatabase();
    // 先按现在这份形状建表，再直接写一行带旧键的 payload：这一行就是升级前那个版本留下的样子
    sessionTable(db);
    db.prepare("INSERT INTO sessions (id, payload) VALUES (?, ?)").run(
      "s-old",
      JSON.stringify({
        id: "s-old",
        workspaceId: "ws-1",
        name: "旧会话",
        nameIsAuto: false,
        pinned: false,
        agentId: "agent-1",
        modelId: "model-1",
        thinkingLevel: null,
        autoHandoff: false,
        lineage: null,
        handoffThreshold: null,
        guardThreshold: null,
        // 旧版本写下的那一格：读路径不认识它，也不该因此炸
        pendingHandoff: "self",
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const service = newService(db);
    expect(service.get("s-old")?.name).toBe("旧会话");
    expect(service.list("ws-1").map((session) => session.id)).toEqual(["s-old"]);

    // 改一格照常写回去：写的是这一份行本身（多出来的那个键跟着原样留着，谁也不读它）
    const renamed = service.update("s-old", { name: "改过的名字" });
    expect(renamed.name).toBe("改过的名字");
    expect(service.get("s-old")?.updatedAt).toBeGreaterThan(1);
  });

  it("置顶的会话排到前面，其余按最后动过的时刻倒序（不是创建时刻）", async () => {
    const service = newService();
    const older = service.create(input);
    // `createdAt` 是毫秒：不隔开就分不出先后，倒序这条断言会变成掷骰子。
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = service.create(input);

    // 刚建出来时谁后建谁在前面
    expect(service.list("ws-1")).toEqual([newer, older]);

    // 老的那一段又动了一次（`touch` 就是运行时在每一批活开始时干的事）：它排到最前面，
    // 哪怕它是先建的 —— 列表要回答的是「哪一段最近动过」
    await new Promise((resolve) => setTimeout(resolve, 2));
    service.touch(older.id);
    expect(service.list("ws-1").map((session) => session.id)).toEqual([older.id, newer.id]);

    // 置顶仍然压过一切
    const pinned = service.update(newer.id, { pinned: true });
    expect(service.list("ws-1")).toEqual([pinned, service.get(older.id)]);
  });
});

describe("消息", () => {
  it("seq 按写入顺序递增；after 从它本身开始；找不到时退回整段", () => {
    const db = newDatabase();
    sessionTable(db).put({
      id: "s-1",
      workspaceId: "ws-1",
      name: "1712345678000",
      nameIsAuto: true,
      pinned: false,
      agentId: "agent-1",
      modelId: "model-1",
      thinkingLevel: null,
      autoHandoff: false,
      lineage: null,
      handoffThreshold: null,
      guardThreshold: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const messages = messageTable(db);
    const first = message("m-1", "第一句");
    messages.upsertMany("s-1", [first, message("m-2", "第二句")]);

    // 同一条消息再写一次（流式追加）：整条覆盖，seq 不动，所以顺序里它还在原位。
    // 改的是**同一个对象**，与真实流式一致：`createdAt` 是 core 在构造那一刻给的，
    // 换一个新对象再写一遍会换掉那个时刻。
    first.content = "第一句改过";
    messages.upsert("s-1", first);

    expect(messages.listBySession("s-1").map((item) => item.id)).toEqual(["m-1", "m-2"]);
    expect(messages.listBySession("s-1", { after: "m-1" }).map((item) => item.id)).toEqual([
      "m-1",
      "m-2",
    ]);
    expect(messages.listBySession("s-1", { after: "不存在" })).toHaveLength(2);
    expect(messages.get("m-1")?.content).toBe("第一句改过");
    // `createdAt` 是生成列，值来自 core 构造消息时填的那一格；它如果没落到 payload 里，
    // 这里会安静地拿到 null —— 那是一个不报错也不工作的功能。
    expect(messages.lastAt("s-1")).toBe(messages.get("m-2")?.createdAt);
  });
});

describe("换记忆", () => {
  /**
   * 三件事一起发生、或者一件都不发生。只成前两件会留下「旧记忆已经存档、原会话却空着」那种
   * 第三种状态，而它不会被任何一条别的用例看见。
   */
  it("存档行建出来、旧消息改挂到它名下、新记忆在原会话里从 seq 1 起；中途炸掉就整批退回", () => {
    const db = newDatabase();
    const sessions = newService(db);
    const messages = messageTable(db);

    const original = sessions.create(input);
    messages.upsertMany(original.id, [message("m-1", "第一句"), message("m-2", "第二句")]);

    const archived: SessionRecord = {
      ...original,
      id: "archived-1",
      name: `已存档_${original.name}`,
    };
    const prompt = Message.System("You are a test assistant.");
    const breakpoint = new Message({
      role: AgentNS.Role.System,
      status: AgentNS.MessageStatus.Completed,
      content: "/tmp/handoff.md",
      hidden: true,
    });

    replaceMemory(db, {
      sessionId: original.id,
      archived,
      memory: [prompt, breakpoint],
      templateCount: 1,
    });

    expect(sessions.get("archived-1")).toEqual(archived);
    // 旧记忆整段搬过去：归属变了，`seq` 一个字不动
    expect(messages.listBySession("archived-1").map((item) => item.id)).toEqual(["m-1", "m-2"]);
    expect(seqsOf(db, "archived-1")).toEqual([1, 2]);
    // 原会话只剩断点那一条：AgentDefinition 带来的系统提示不落成行，否则下次装载会多一份
    expect(messages.listBySession(original.id).map((item) => item.id)).toEqual([breakpoint.id]);
    expect(seqsOf(db, original.id)).toEqual([1]);

    // 人为造一次失败：自引用的消息序列化不了，第三件写着的时候炸掉，看前两件有没有一起退回去
    const broken = message("m-3", "这一条写不进去");
    (broken as unknown as { self: unknown }).self = broken;
    const secondArchived: SessionRecord = { ...original, id: "archived-2" };

    expect(() =>
      replaceMemory(db, {
        sessionId: original.id,
        archived: secondArchived,
        memory: [message("m-4", "新的第一句"), broken],
        templateCount: 0,
      }),
    ).toThrow();

    expect(sessions.get("archived-2")).toBeUndefined();
    expect(messages.get("m-4")).toBeUndefined();
    expect(seqsOf(db, original.id)).toEqual([1]);
    expect(messages.listBySession(original.id).map((item) => item.id)).toEqual([breakpoint.id]);
    expect(messages.listBySession("archived-1").map((item) => item.id)).toEqual(["m-1", "m-2"]);
  });
});
