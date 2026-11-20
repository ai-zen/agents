/**
 * 三条验收：会话行写进去读回来一模一样；置顶真的改变列表顺序（证明排序用的是库算出的生成列，
 * 而不是 JS 传下去的值）；`after` 从它本身开始而不是下一条（客户端重连时正在流式的那条内容
 * 已经变了，从下一条开始就会漏掉它）。
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { AgentNS, Message } from "@ai-zen/agents-core";

import { createTranslator } from "../i18n/index.js";
import { workspaceTable } from "../workspace/table.js";
import { messageTable } from "./messages.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { NewSession } from "./types.js";

/** 会话挂在外键上，所以每一个库都得先有一个项目行，不然插入会被 `foreign_keys` 拦住 */
function newDatabase() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  return db;
}

function newService(): SessionService {
  return new SessionService({
    sessions: sessionTable(newDatabase()),
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

describe("会话行", () => {
  it("写进去读回来一模一样，改一格其余不变", () => {
    const service = newService();
    const created = service.create(input);
    expect(service.get(created.id)).toEqual(created);

    const renamed = service.update(created.id, { name: "新的名字" });
    expect(renamed).toEqual({ ...created, name: "新的名字", updatedAt: expect.any(Number) });
    expect(service.get(created.id)).toEqual(renamed);
  });

  it("置顶的会话排到前面，其余仍按创建时间倒序", async () => {
    const service = newService();
    const older = service.create(input);
    // `createdAt` 是毫秒：不隔开就分不出先后，倒序这条断言会变成掷骰子。
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = service.create(input);

    expect(service.list("ws-1")).toEqual([newer, older]);

    const pinned = service.update(older.id, { pinned: true });
    expect(service.list("ws-1")).toEqual([pinned, newer]);
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
      pendingHandoff: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const messages = messageTable(db);
    messages.upsertMany("s-1", [message("m-1", "第一句"), message("m-2", "第二句")]);

    // 同一条消息再写一次（流式追加）：整条覆盖，seq 不动，所以顺序里它还在原位。
    messages.upsert("s-1", message("m-1", "第一句改过"));

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
