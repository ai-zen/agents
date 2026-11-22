import { describe, expect, it, vi } from "vitest";
import { GET_MCP_TASK_RESULT_TOOL } from "@ai-zen/agents-sdk";
import type { McpTaskNotice } from "@ai-zen/agents-sdk";

import { createMcpTaskNoticePort } from "./mcp-task-notice.js";

/**
 * MCP 任务通知的投递口：到了终态就投进发起那次调用的那段会话。
 *
 * 这里盯的是「投」与「丢」两件事：投进去的条目长什么样（来源是系统、label 带服务器名、正文
 * 说清任务 id / 终态 / 去哪儿取），以及那段会话已经不在时只丢不抛。
 *
 * 「服务器推来的状态」那一半在 SDK 那一侧（`McpConnectionManager` 的用例里用内存传输跑真形状），
 * 这里接着的是它的下游：拿到一条终态事实之后，那段会话的队列里落下的是什么。
 */

/** 投进去的条目（投递口只碰 `push` 这一格） */
interface PushedEntry {
  priority: string;
  source: { kind: string; label: string };
  content: string;
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const COMPLETED: McpTaskNotice = {
  server: "github",
  taskId: "task-1",
  status: "completed",
};

describe("MCP 任务通知的投递口", () => {
  it("活着的会话：投一条系统通知，正文说清任务 id、终态与取结果的工具", async () => {
    const pushed: PushedEntry[] = [];
    const log = fakeLog();
    const port = createMcpTaskNoticePort({
      alive: () => ({ push: (entry?: unknown) => void pushed.push(entry as PushedEntry) }),
      sessionOf: () => "session-1",
      log,
    });

    const delivered = await port.deliver("session-1", COMPLETED);

    expect(delivered).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.priority).toBe("low");
    expect(pushed[0]!.source).toEqual({ kind: "system", label: "mcp:github" });
    expect(pushed[0]!.content).toContain("task-1");
    expect(pushed[0]!.content).toContain("completed");
    expect(pushed[0]!.content).toContain(GET_MCP_TASK_RESULT_TOOL);
    expect(pushed[0]!.content).toContain('"server":"github"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("三种终态各自说清是哪一种，服务器给的那句说明跟着带上", async () => {
    const texts: string[] = [];
    const port = createMcpTaskNoticePort({
      alive: () => ({ push: (entry?: unknown) => void texts.push((entry as PushedEntry).content) }),
      sessionOf: () => "session-1",
      log: fakeLog(),
    });

    await port.deliver("session-1", { server: "s", taskId: "a", status: "completed" });
    await port.deliver("session-1", {
      server: "s",
      taskId: "b",
      status: "failed",
      statusMessage: "the disk was full",
    });
    await port.deliver("session-1", { server: "s", taskId: "c", status: "cancelled" });

    expect(texts[0]).toContain("completed");
    expect(texts[1]).toContain("failed");
    expect(texts[1]).toContain("the disk was full");
    expect(texts[2]).toContain("cancelled");
    for (const text of texts) expect(text).toContain(GET_MCP_TASK_RESULT_TOOL);
  });

  it("那段会话已经不在：丢掉、记一行日志、不抛", async () => {
    const log = fakeLog();
    const port = createMcpTaskNoticePort({
      alive: () => undefined,
      sessionOf: () => "session-1",
      log,
    });

    await expect(port.deliver("session-1", COMPLETED)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![0])).toContain("task-1");
  });

  it("队列已经不收件（这一段正在被收掉）：同样只丢不抛", async () => {
    const log = fakeLog();
    const port = createMcpTaskNoticePort({
      alive: () => ({
        push: () => {
          throw new Error("closed");
        },
      }),
      sessionOf: () => "session-1",
      log,
    });

    await expect(port.deliver("session-1", COMPLETED)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("sessionOf 原样转给运行时：「发起的是哪一段会话」只有它答得出", () => {
    const caller = { model: "m" };
    const port = createMcpTaskNoticePort({
      alive: () => undefined,
      sessionOf: (agent) => (agent === caller ? "session-9" : undefined),
      log: fakeLog(),
    });

    expect(port.sessionOf(caller as never)).toBe("session-9");
    expect(port.sessionOf({ model: "other" } as never)).toBeUndefined();
  });
});
