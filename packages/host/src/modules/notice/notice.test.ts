/**
 * 一条验收：`sweep` 只删到点的那些，永久通知一条都不动。写反成 `<` 的那一版只在恰好到点的
 * 那一毫秒上出错 —— 通知多留一会儿看不出来，所以只能在这里钉住。
 *
 * 另一条验收：按会话列的时候全局的那些也在里面，而按别的会话列的时候不在。旧实现把全局的
 * 滤掉了，界面上看不出任何异常，只是那条通知再也没地方看得见（PRD 4.9 的改口就是这么来的）。
 *
 * 第三条：警告与错误两档同时进宿主日志（界面被占着的时候，日志必须另有去处），信息与成功两档
 * 不进；行里只有码、档位、会话 id 这类结构化事实，没有那句渲染好的成品句子。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileLogger } from "@ai-zen/agents-logger";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { createBus } from "../../infra/bus.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { NoticeService } from "./service.js";
import { noticeTable } from "./table.js";

/** 会话内的通知挂在外键上，所以库里得先有项目与会话，不然插入会被 `foreign_keys` 拦住 */
function newDatabase() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  sessionTable(db).put({
    id: "s-1",
    workspaceId: "ws-1",
    name: "1712345678000",
    nameSource: "default",
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
  return db;
}

/** 不出声的日志口：这一份用例里需要日志的那一条自己造一个真的，其余两条不验日志 */
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function newService(): NoticeService {
  return new NoticeService({
    notices: noticeTable(newDatabase()),
    events: createBus(),
    log: quietLog,
  });
}

describe("通知", () => {
  it("sweep 只删到点的那些，永久的留在库里", () => {
    const service = newService();
    const permanent = service.push({
      level: "error",
      code: "config.recovered",
      message: "配置文件坏了，已恢复成出厂配置",
      durationMs: null,
      sessionId: null,
    });
    const brief = service.push({
      level: "success",
      code: "saved",
      message: "已保存",
      durationMs: 1000,
      sessionId: null,
    });

    // 差一毫秒时两条都还在，到点那一刻短的那条就没了：`<=` 与 `<` 只在这一毫秒上有差别。
    service.sweep(brief.createdAt + 1000 - 1);
    expect(service.list()).toHaveLength(2);

    service.sweep(brief.createdAt + 1000);
    expect(service.list()).toEqual([permanent]);
  });

  it("按会话列会带上全局的那些，按别的会话列不会", async () => {
    const service = newService();
    const global = service.push({
      level: "info",
      code: "host.upgraded",
      message: "宿主已升级到新版本",
      durationMs: null,
      sessionId: null,
    });
    // `createdAt` 只到毫秒：不隔开就分不出先后，倒序这条断言会变成掷骰子。
    await new Promise((resolve) => setTimeout(resolve, 2));
    const scoped = service.push({
      level: "warning",
      code: "handoff.done",
      message: "这段会话的记忆刚被换过",
      durationMs: null,
      sessionId: "s-1",
    });

    expect(service.listBySession("s-1").map((notice) => notice.id)).toEqual([scoped.id, global.id]);
    expect(service.listBySession("s-2")).toEqual([global]);
  });

  it("警告与错误两档进宿主日志，信息与成功两档不进；行里没有那句成品句子", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-zen-notice-log-"));
    const log = new FileLogger({ file: join(dir, "host.log") });
    try {
      const service = new NoticeService({
        notices: noticeTable(newDatabase()),
        events: createBus(),
        log,
      });

      service.push({
        level: "error",
        code: "handoff_failed",
        message: "交接失败：端点 4xx",
        durationMs: null,
        sessionId: "s-1",
      });
      service.push({
        level: "warning",
        code: "config.recovered",
        message: "配置文件坏了，已恢复成出厂配置",
        durationMs: null,
        sessionId: null,
      });
      service.push({
        level: "info",
        code: "host.upgraded",
        message: "宿主已升级到新版本",
        durationMs: null,
        sessionId: null,
      });
      service.push({
        level: "success",
        code: "saved",
        message: "已保存",
        durationMs: 1000,
        sessionId: null,
      });

      // 写盘是排队的：收尾把队排空之后再读，读到的才是全部那几行
      await log.close();
      const text = readFileSync(log.filePath, "utf8");
      const lines = text.trim().split("\n");

      // 只有两档进日志：信息与成功那两条一行都不该有
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("ERROR app Notice");
      expect(lines[0]).toContain('"code":"handoff_failed"');
      expect(lines[0]).toContain('"sessionId":"s-1"');
      expect(lines[1]).toContain("WARN  app Notice");
      expect(lines[1]).toContain('"code":"config.recovered"');

      // 只记码与结构化事实：那句给用户看的成品句子不进日志
      expect(text).not.toContain("交接失败");
      expect(text).not.toContain("配置文件坏了");
      expect(text).not.toContain("宿主已升级");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
