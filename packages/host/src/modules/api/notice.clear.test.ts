/**
 * 四条验收，对着「清分三个粒度」那一节：
 *
 * 1. 清一条只影响那一条 —— 同一段会话里的另一条、别的会话那条都还在；推出去的事件也只带那一条的
 *    id 与会话 id，客户端据此只动那一个栏位。
 * 2. 清一条已经不存在的回「没改动」，不抛错、也不假装成功，并且一条事件都不发。
 * 3. 按会话清不碰全局的：全局通知不属于任何一段，按会话清碰不到它。
 * 4. 不给参数清全部，库里清干净。
 *
 * 台架与 `notice.test.ts` 同一个搭法：真内存库、真 `NoticeService`，调用从 `createCaller` 走，
 * 与客户端同一入口。会话行要先在库里 —— 会话内的通知挂在外键上，不然插入会被 `foreign_keys` 拦住。
 */

import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { NoticeService } from "../notice/service.js";
import { noticeTable } from "../notice/table.js";
import type { Notice } from "../notice/types.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { noticeRouter } from "./notice.js";
import { createTrpc } from "./trpc.js";

/** 不出声的日志口：这一份用例验的是清的粒度，日志那一档在 `notice.test.ts` 里 */
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function newHost() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  for (const id of ["s-1", "s-2"]) {
    sessionTable(db).put({
      id,
      workspaceId: "ws-1",
      name: id,
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
  }

  const events = createBus<HostEvent>();
  const cleared: HostEvent[] = [];
  events.subscribe((event) => {
    if (event.type === "notice.cleared") cleared.push(event);
  });

  const notices = new NoticeService({ notices: noticeTable(db), events, log: quietLog });
  const t = createTranslator(() => "zh");
  const api = createTrpc(t);
  const router = api.router({ notice: noticeRouter({ notices }, api) });
  const caller = router.createCaller({});

  /** 产生一条通知。`sessionId` 给 `null` 就是全局的那一档 */
  function push(sessionId: string | null): Notice {
    return notices.push({
      level: "info",
      code: "saved",
      message: "已保存",
      durationMs: null,
      sessionId,
    });
  }

  /** 库里那几条的 id，按字典序定序 —— `createdAt` 只到毫秒，同毫秒的先后不是这里要验的事 */
  function ids(rows: readonly Notice[]): string[] {
    return rows.map((row) => row.id).sort();
  }

  return { caller, push, ids, cleared };
}

describe("清通知的三个粒度", () => {
  it("清一条只影响那一条", async () => {
    const host = newHost();
    const first = host.push("s-1");
    const second = host.push("s-1");
    const elsewhere = host.push("s-2");

    await expect(host.caller.notice.clearOne({ id: second.id })).resolves.toEqual({
      changed: true,
    });

    expect(host.ids(await host.caller.notice.list({}))).toEqual(host.ids([first, elsewhere]));
    // 同一段会话里剩下的那一条也还在：清的是一条，不是一片
    expect(host.ids(await host.caller.notice.list({ sessionId: "s-1" }))).toEqual(
      host.ids([first]),
    );
    expect(host.cleared).toEqual([{ type: "notice.cleared", id: second.id, sessionId: "s-1" }]);
  });

  it("清一条已经不存在的回「没改动」，不发事件也不抛错", async () => {
    const host = newHost();
    const only = host.push("s-1");

    await expect(host.caller.notice.clearOne({ id: "not-a-notice" })).resolves.toEqual({
      changed: false,
    });

    expect(host.ids(await host.caller.notice.list({}))).toEqual([only.id]);
    expect(host.cleared).toEqual([]);
  });

  it("按会话清不碰全局的", async () => {
    const host = newHost();
    const global = host.push(null);
    host.push("s-1");
    const another = host.push("s-2");

    await host.caller.notice.clear({ sessionId: "s-1" });

    // 那一段只剩全局那条（全局通知哪一段都看得见），别的会话那条也不该被连坐
    expect(host.ids(await host.caller.notice.list({ sessionId: "s-1" }))).toEqual([global.id]);
    expect(host.ids(await host.caller.notice.list({}))).toEqual(host.ids([global, another]));
  });

  it("不给参数清全部，清干净", async () => {
    const host = newHost();
    host.push(null);
    host.push("s-1");
    host.push("s-2");

    await host.caller.notice.clear({});

    expect(await host.caller.notice.list({})).toEqual([]);
    expect(await host.caller.notice.list({ sessionId: "s-1" })).toEqual([]);
  });
});
