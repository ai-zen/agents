/**
 * `notice.*` 的接线验收：语言从连接传下去（D8）、方法参数原样递给服务层。
 * 事件出网前的本地化（`createEventLocalizer`）归 `NoticeService.test.ts`，它才是那个实现的家。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../storage/Database.js";
import { NoticeRepository } from "../storage/NoticeRepository.js";
import { migrate } from "../storage/migrations.js";
import type { Language } from "../i18n/index.js";
import type { MethodCallContext } from "../net/WsHub.js";
import { isMethodName } from "../wire/index.js";
import type { EventMap, MethodName, MethodParams } from "../wire/index.js";
import { NoticeService } from "../services/NoticeService.js";
import { createNoticeHandlers } from "./noticeHandlers.js";

/** 一次调用的现场（连接 id + 连接语言；其余字段本域用不到） */
function call<M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  language: Language,
  connectionId = "conn-1",
): MethodCallContext<M> {
  return {
    method,
    params,
    connection: { id: connectionId, language, clientInfo: null, credentialId: null },
  };
}

interface Harness {
  dir: string;
  db: Database;
  notices: NoticeService;
  clock: { value: number };
}

async function setup(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-zen-notice-handlers-"));
  const db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  const clock = { value: 1_700_000_000_000 };
  const notices = new NoticeService({
    notices: new NoticeRepository(db),
    now: () => clock.value,
  });
  return { dir, db, notices, clock };
}

let harness: Harness;

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await harness.db.close();
  await rm(harness.dir, { recursive: true, force: true });
});

describe("notice.* 接线", () => {
  it("按连接的语言渲染（同一条通知，两条连接看到两种语言）", async () => {
    const handlers = createNoticeHandlers({ notices: harness.notices });
    await harness.notices.create({ level: "info", code: "notice.settingsSaved" });

    const english = await handlers["notice.list"]?.(call("notice.list", {}, "en"));
    const chinese = await handlers["notice.list"]?.(call("notice.list", {}, "zh"));

    expect(english?.notices[0]?.text.message).toBe("Settings saved.");
    expect(chinese?.notices[0]?.text.message).toBe("配置已保存。");
  });

  it("dismiss / clear 原样透传", async () => {
    const handlers = createNoticeHandlers({ notices: harness.notices });
    const created = await harness.notices.create({
      level: "info",
      code: "notice.settingsSaved",
    });

    expect(
      await handlers["notice.dismiss"]?.(call("notice.dismiss", { noticeId: created.id }, "en")),
    ).toEqual({ dismissed: true });
    expect(await handlers["notice.clear"]?.(call("notice.clear", {}, "en"))).toEqual({ cleared: 0 });
  });

  it("列表筛选参数也照传", async () => {
    const handlers = createNoticeHandlers({ notices: harness.notices });
    await harness.notices.create({ level: "info", code: "notice.settingsSaved", duration: 5 });
    harness.clock.value += 1;
    await harness.notices.create({ level: "error", code: "notice.logError", params: { summary: "e" } });

    const onlyErrors = await handlers["notice.list"]?.(
      call("notice.list", { level: "error" }, "en"),
    );
    expect(onlyErrors?.notices.map((notice) => notice.level)).toEqual(["error"]);
  });

  it("方法表里这三个方法的形状与服务层返回一致", () => {
    const handlers = createNoticeHandlers({ notices: harness.notices });
    // 注册的键必须是方法表里认得的方法名（isMethodName 是运行期的同一份真相）
    const names = Object.keys(handlers).filter(isMethodName);
    expect(names.sort()).toEqual(["notice.clear", "notice.dismiss", "notice.list"]);
  });
});
