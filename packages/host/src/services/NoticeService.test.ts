/**
 * 通知服务的验收：独立通道（F-I8）、持久化（L3）、持续时间的两套单位（R15）、
 * 三档语气（R4）、按语言渲染（D8）、清掉的方式（手动清 / 到点消失）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NoticeRepository } from "../storage/NoticeRepository.js";
import { Database } from "../storage/Database.js";
import { migrate } from "../storage/migrations.js";
import type { NoticeRow } from "../storage/types.js";
import { EventMap, EventName } from "../wire/events.js";
import { NoticeService, createEventLocalizer } from "./NoticeService.js";

interface Harness {
  dir: string;
  dbFile: string;
  db: Database;
  notices: NoticeRepository;
  service: NoticeService;
  /** 推出去的事件（事件名 + 载荷） */
  events: Array<{ name: EventName; payload: unknown }>;
  /** 手动推进的时钟（毫秒） */
  clock: { value: number };
}

/** 一条通知服务的实例级状态（事件数组、时钟）在用例之间重建就够，库不用重建 */
function buildHarness(dir: string, db: Database, notices: NoticeRepository): Harness {
  const events: Harness["events"] = [];
  const clock = { value: 1_700_000_000_000 };
  const service = new NoticeService({
    notices,
    now: () => clock.value,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
  });
  return { dir, dbFile: join(dir, "ai-zen.db"), db, notices, service, events, clock };
}

let dir: string;
let db: Database;
let notices: NoticeRepository;
let harness: Harness;

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
// 真要「关库再重开」的两条用例自带库（见下面 describe("通知持久化")）。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-notices-"));
  const dbFile = join(dir, "ai-zen.db");
  db = new Database(dbFile);
  await migrate(db);
  notices = new NoticeRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  harness = buildHarness(dir, db, notices);
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("通知的持续时间（L3 / R15）", () => {
  it("给秒数就到点消失，契约是秒、库里是毫秒", async () => {
    const created = await harness.service.create({
      level: "info",
      code: "notice.settingsSaved",
      duration: 3,
    });
    expect(created.duration).toBe(3);

    const rows = await harness.db.all<NoticeRow>("SELECT durationMs FROM notices");
    expect(rows).toEqual([{ durationMs: 3000 }]);

    harness.clock.value += 2999;
    expect((await harness.service.list()).notices).toHaveLength(1);

    harness.clock.value += 1;
    expect((await harness.service.list()).notices).toHaveLength(0);
  });

  it("不给持续时间就是永久：时间怎么走都在，只能手动清", async () => {
    const created = await harness.service.create({
      level: "warning",
      code: "notice.logWarning",
      params: { summary: "MCP 没响应" },
    });
    expect(created.duration).toBeNull();

    harness.clock.value += 365 * 24 * 60 * 60 * 1000;
    expect((await harness.service.list()).notices.map((notice) => notice.id)).toEqual([created.id]);

    const dismissed = await harness.service.dismiss({ noticeId: created.id });
    expect(dismissed).toEqual({ dismissed: true });
    expect((await harness.service.list()).notices).toHaveLength(0);
  });

  it("到点之后被清掉的行不会留在库里", async () => {
    await harness.service.create({ level: "info", code: "notice.settingsSaved", duration: 1 });
    harness.clock.value += 1000;
    await harness.service.list();
    const rows = await harness.db.all<NoticeRow>("SELECT id FROM notices");
    expect(rows).toHaveLength(0);
  });

  it("非法持续时间按参数不对拒，不写库", async () => {
    await expect(
      harness.service.create({ level: "info", code: "notice.settingsSaved", duration: -1 }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      harness.service.create({
        level: "info",
        code: "notice.settingsSaved",
        duration: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(await harness.db.all<NoticeRow>("SELECT id FROM notices")).toEqual([]);
  });
});

describe("通知持久化（L3：重启不丢）", () => {
  /**
   * 这两条要真「关库再重开」。共享夹具下 close 会把整个文件共用的库关掉，
   * 所以它们各自带一个库：mkdtemp → migrate → 写 → close → 在同一份文件上重开。
   */
  it("永久通知换一个进程（重开库）之后还在", async () => {
    const ownDir = await mkdtemp(join(tmpdir(), "ai-zen-notices-reopen-"));
    const ownFile = join(ownDir, "ai-zen.db");
    let db2: Database | undefined;
    const first = new Database(ownFile);
    try {
      await migrate(first);
      const service = new NoticeService({ notices: new NoticeRepository(first) });
      const created = await service.create({
        level: "error",
        code: "notice.logError",
        params: { summary: "写库失败" },
      });

      await first.close();
      db2 = new Database(ownFile);
      await migrate(db2);
      const reopened = new NoticeService({ notices: new NoticeRepository(db2) });

      const listed = await reopened.list();
      expect(listed.notices.map((notice) => notice.id)).toEqual([created.id]);
      expect(listed.notices[0]?.text.messageKey).toBe("notice.logError");
      expect(listed.notices[0]?.text.params).toEqual({ summary: "写库失败" });
    } finally {
      await first.close();
      await db2?.close();
      await rm(ownDir, { recursive: true, force: true });
    }
  });

  it("带持续时间但还没到点的通知，重开库之后也还在", async () => {
    const ownDir = await mkdtemp(join(tmpdir(), "ai-zen-notices-reopen-"));
    const ownFile = join(ownDir, "ai-zen.db");
    const clock = { value: 1_700_000_000_000 };
    let db2: Database | undefined;
    const first = new Database(ownFile);
    try {
      await migrate(first);
      const service = new NoticeService({
        notices: new NoticeRepository(first),
        now: () => clock.value,
      });
      const created = await service.create({
        level: "info",
        code: "notice.settingsSaved",
        duration: 60,
      });

      await first.close();
      db2 = new Database(ownFile);
      await migrate(db2);
      const reopened = new NoticeService({
        notices: new NoticeRepository(db2),
        now: () => clock.value,
      });

      clock.value += 30_000;
      expect((await reopened.list()).notices.map((notice) => notice.id)).toEqual([created.id]);
      clock.value += 30_000;
      expect((await reopened.list()).notices).toHaveLength(0);
    } finally {
      await first.close();
      await db2?.close();
      await rm(ownDir, { recursive: true, force: true });
    }
  });
});

describe("三档语气（R4）", () => {
  it("info / warning / error 各存各的，读回来不变形", async () => {
    // 每条间隔一毫秒：列表按创建时间升序，同一毫秒内只能靠 id 排，断言就没有意义了
    await harness.service.create({ level: "info", code: "notice.settingsSaved", duration: 5 });
    harness.clock.value += 1;
    await harness.service.create({ level: "warning", code: "notice.logWarning", params: { summary: "w" } });
    harness.clock.value += 1;
    await harness.service.create({ level: "error", code: "notice.logError", params: { summary: "e" } });

    const listed = await harness.service.list();
    expect(listed.notices.map((notice) => notice.level)).toEqual(["info", "warning", "error"]);
  });

  it("按语气筛选", async () => {
    await harness.service.create({ level: "info", code: "notice.settingsSaved", duration: 5 });
    await harness.service.create({ level: "error", code: "notice.logError", params: { summary: "e" } });

    const errors = await harness.service.list({ level: "error" });
    expect(errors.notices).toHaveLength(1);
    expect(errors.notices[0]?.level).toBe("error");
  });

  it("语气不在三档里就按参数不对拒", async () => {
    await expect(
      // 越过类型的一档看宿主守不守
      harness.service.create({ level: "success" as unknown as "info", code: "notice.settingsSaved" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("按语言渲染（D8）", () => {
  it("同一条通知在不同语言的连接上读出不同的句子", async () => {
    const created = await harness.service.create({
      level: "info",
      code: "notice.handoffWritten",
      params: { path: "/proj/.ai-zen/handoffs/20260101-000000.md" },
    });

    const english = await harness.service.list({}, "en");
    const chinese = await harness.service.list({}, "zh");
    expect(english.notices[0]?.text.message).toContain("Handoff document written to");
    expect(chinese.notices[0]?.text.message).toContain("交接文档已写到");
    expect(chinese.notices[0]?.text.message).toContain("/proj/.ai-zen/handoffs/");
    // 码与参数两国语言完全一致：渲染只是把键换成句子
    expect(chinese.notices[0]?.text.code).toBe(english.notices[0]?.text.code);
    expect(chinese.notices[0]?.text.params).toEqual(english.notices[0]?.text.params);
    expect(created.text.messageKey).toBe("notice.handoffWritten");
  });

  it("库里存的是码 + 参数，不是渲染好的句子", async () => {
    await harness.service.create({
      level: "info",
      code: "notice.handoffWritten",
      params: { path: "/p/h.md" },
    });
    const rows = await harness.db.all<{ code: string; params: string }>(
      "SELECT code, params FROM notices",
    );
    expect(rows[0]?.code).toBe("notice.handoffWritten");
    expect(rows[0]?.params).not.toContain("Handoff document written");
    expect(JSON.parse(rows[0]?.params ?? "{}")).toEqual({ path: "/p/h.md" });
  });

  it("事件出网前按连接语言重渲染（WsHub 的 localizeEvent 注入点）", async () => {
    const created = await harness.service.create({
      level: "info",
      code: "notice.settingsSaved",
    });
    const payload: EventMap["notice"] = { notice: created, at: "2026-01-01T00:00:00.000Z" };
    const localize = createEventLocalizer();
    const chinese = localize("notice", payload, "zh");
    expect(chinese.notice.text.message).toBe("配置已保存。");
    const english = localize("notice", payload, "en");
    expect(english.notice.text.message).toBe("Settings saved.");
    // 只有带 `LocalizedText` 的事件过这一层：其余事件原样搬运（同一个对象，不复制）
    const other = { conversationId: "c1", status: "idle" } as unknown as EventMap["run.state"];
    expect(localize("run.state", other, "zh")).toBe(other);
  });
});

describe("通知是独立通道，绝不进消息（F-I8）", () => {
  it("发一条通知只推 notice 事件，库里没有任何消息行", async () => {
    await harness.service.create({ level: "info", code: "notice.settingsSaved", duration: 1 });

    expect(harness.events.map((event) => event.name)).toEqual(["notice"]);
    const messages = await harness.db.all<{ id: string }>("SELECT id FROM messages");
    expect(messages).toEqual([]);
    const conversations = await harness.db.all<{ id: string }>("SELECT id FROM conversations");
    expect(conversations).toEqual([]);
  });

  it("按对话挂着，也能按对话清掉", async () => {
    // 通知的对话归属是一列真值（外键开着），所以先要有那两个对话
    await harness.db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', 'p', '/tmp/p', 1)");
    for (const id of ["c1", "c2"]) {
      await harness.db.run(
        `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
         VALUES (?, 'w1', ?, 0, 'a', 'm', 1, 1)`,
        [id, id],
      );
    }

    await harness.service.create({
      level: "warning",
      code: "notice.logWarning",
      params: { summary: "一次" },
      conversationId: "c1",
    });
    await harness.service.create({
      level: "warning",
      code: "notice.logWarning",
      params: { summary: "另一段" },
      conversationId: "c2",
    });
    await harness.service.create({ level: "info", code: "notice.settingsSaved", duration: 5 });

    const scoped = await harness.service.list({ conversationId: "c1" });
    expect(scoped.notices).toHaveLength(1);
    // 归属在真列上（`NoticeView.conversationId`），渲染参数里只有文案自己的东西
    expect(scoped.notices[0]?.conversationId).toBe("c1");
    expect(scoped.notices[0]?.text.params).toEqual({ summary: "一次" });

    const cleared = await harness.service.clear({ conversationId: "c1" });
    expect(cleared).toEqual({ cleared: 1 });
    expect((await harness.service.list({ conversationId: "c1" })).notices).toHaveLength(0);
    expect((await harness.service.list({ conversationId: "c2" })).notices).toHaveLength(1);
    expect((await harness.service.list()).notices).toHaveLength(2);
  });

  it("clear 不给对话就清全部", async () => {
    await harness.service.create({ level: "info", code: "notice.settingsSaved", duration: 5 });
    await harness.service.create({ level: "error", code: "notice.logError", params: { summary: "e" } });
    expect(await harness.service.clear()).toEqual({ cleared: 2 });
    expect((await harness.service.list()).notices).toEqual([]);
  });

  it("清一条不存在的通知回 dismissed:false（这次有没有真改动库）", async () => {
    expect(await harness.service.dismiss({ noticeId: "没有这条" })).toEqual({ dismissed: false });
    await expect(harness.service.dismiss({ noticeId: "  " })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("日志上浮（F-J2）", () => {
  it("warn / error 各给一条永久通知", async () => {
    await harness.service.log("warning", "MCP 服务器断了");
    harness.clock.value += 1;
    await harness.service.log("error", "写库失败", "zh");

    const listed = await harness.service.list({}, "zh");
    expect(listed.notices.map((notice) => notice.level)).toEqual(["warning", "error"]);
    expect(listed.notices[0]?.duration).toBeNull();
    expect(listed.notices[1]?.text.message).toContain("写库失败");
  });
});
