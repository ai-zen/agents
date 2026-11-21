/**
 * 软线越线那一刻：这一趟用哪个执行者，要不要问人（`dev-docs/prd/07-handoff.md`「谁建的会话，
 * 自动交接开不开」）。
 *
 * 四条分支各有一条用例，顺序就是判定顺序：会话没了 → 开着开关 → 答过「不交接」→ 问一道三选题。
 * 钉住的是几件看不出来的事：
 *
 * - 「问一次」不是每次都问：答过「不交接」的那一段第二次直接回 `null`，题一道都不再出；
 * - 「同一段只挂一道题」：撞线连着来两次，第二次等的是第一次那道，而不是再问一道；
 * - 「没有客户端照样问」：判据里没有「有没有人在场」这一格，题挂在内存里等人连上来拉；
 * - `undefined`（没人答它了）与「答了不交接」在返回值上合流（都是 `null`），但在调用方那里
 *   意思不同 —— 所以「题没了」这条得单独立一条，不能被误读成「用户说了不」。
 *
 * 题用真的那一个（`QuestionRegistry`）：它本来就是纯内存的活物，造一层替身只会把「问出去的那道
 * 题客户端能不能看见」这件事挪到替身里去证。交接的其余几格（库、项目、运行时、通知、SDK 工厂）
 * 给不碰的替身 —— 这几条用例只问「问不问、回什么」。
 */

import { describe, expect, it } from "vitest";

import type { AgentRuntime } from "@ai-zen/agents-sdk";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { QuestionRegistry } from "../question/registry.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { NewSession, Session } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import type { WorkspaceService } from "../workspace/service.js";
import { HandoffService } from "./service.js";

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameIsAuto: true,
  autoHandoff: false,
  lineage: null,
};

function newHost() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const questions = new QuestionRegistry({ events, t });

  const handoff = new HandoffService({
    db,
    sessions,
    // 下面几格这几条用例一条都走不到（只问「问不问、回什么」），给不碰的替身
    workspaces: {} as unknown as WorkspaceService,
    runtime: {} as AgentRuntime,
    notices: {} as never,
    questions,
    events,
    t,
    createSdk: () => {
      throw new Error("替身不跑交接");
    },
  });

  return { handoff, sessions, questions };
}

type Host = ReturnType<typeof newHost>;

function newSession(host: Host, autoHandoff: boolean): Session {
  return host.sessions.create({ ...input, autoHandoff });
}

describe("越线那一刻问不问", () => {
  it("开着自动交接就直接自交接，不问：一道题都不出", async () => {
    const host = newHost();
    const session = newSession(host, true);

    await expect(host.handoff.automaticMode(session.id)).resolves.toBe("self");
    expect(host.questions.list(session.id)).toEqual([]);
  });

  it("关着 → 问一道三选题；答 self 回 self，答 summary 回 summary", async () => {
    const host = newHost();
    const session = newSession(host, false);

    const asked = host.handoff.automaticMode(session.id);
    const question = host.questions.list(session.id)[0];
    expect(question).toBeDefined();
    // 三选题：自交接 / 独立交接 / 不交接，没有「不答 / 绕过 / 关掉」这种旁路
    expect(question.choices.map((choice) => choice.value)).toEqual(["self", "summary", "no"]);
    // 题挂着时不挡发送：按不按发送是客户端拿着 `blocking` 自己决定的事（PRD 原话）
    expect(question.blocking).toBe(false);

    host.questions.answer(question.id, "self");
    await expect(asked).resolves.toBe("self");
    expect(host.questions.list(session.id)).toEqual([]);

    // 同一段上再越一次线：又问一道，这次答「独立交接」
    const askedAgain = host.handoff.automaticMode(session.id);
    const second = host.questions.list(session.id)[0];
    host.questions.answer(second.id, "summary");
    await expect(askedAgain).resolves.toBe("summary");
  });

  it("答不交接：回 null、开关写成 false，第二次直接回 null 不再问", async () => {
    const host = newHost();
    const session = newSession(host, false);

    const asked = host.handoff.automaticMode(session.id);
    const question = host.questions.list(session.id)[0];
    host.questions.answer(question.id, "no");

    await expect(asked).resolves.toBeNull();
    // 「答不要就记成这段的处理策略」：开关落在会话行上
    expect(host.sessions.get(session.id)?.autoHandoff).toBe(false);

    // 第二次：不再问（题一道都不出），也不再问一个已经答过的人
    await expect(host.handoff.automaticMode(session.id)).resolves.toBeNull();
    expect(host.questions.list(session.id)).toEqual([]);
  });

  it("没有客户端连着也照样问：题挂在内存里等人连上来拉", async () => {
    const host = newHost();
    const session = newSession(host, false);

    const asked = host.handoff.automaticMode(session.id);

    // 没有人在场不是判据：题就挂在内存里，客户端连上来拉一次（`question.list`）就看得见。
    // 回默认执行者就是宿主替用户决定了「要不要交接」
    const question = host.questions.list(session.id)[0];
    expect(question).toBeDefined();
    expect(question.choices.map((choice) => choice.value)).toEqual(["self", "summary", "no"]);

    // 题没被答就一直挂着；答了才往下走
    expect(host.questions.list(session.id)).toHaveLength(1);
    host.questions.answer(question.id, "summary");
    await expect(asked).resolves.toBe("summary");
  });

  it("题没人答（那一段没了）→ 回 null：`undefined` 不是「用户说了不」", async () => {
    const host = newHost();
    const session = newSession(host, false);

    const asked = host.handoff.automaticMode(session.id);
    expect(host.questions.list(session.id)).toHaveLength(1);

    // 那段没了 / 题被收掉：等的人拿到 undefined
    host.questions.forget(session.id);

    await expect(asked).resolves.toBeNull();
    // 没人答不等于答了「不交接」：这一段不在「不再问」那一格上，下一次越线照样会问
    expect(host.sessions.get(session.id)?.autoHandoff).toBe(false);
    void host.handoff.automaticMode(session.id);
    expect(host.questions.list(session.id)).toHaveLength(1);
  });

  it("同一段连着两次撞线只问一道题：两次等的是同一个答复", async () => {
    const host = newHost();
    const session = newSession(host, false);

    // 第一次撞线不 await：题还挂着。用户没答、接着说，agent 又闲下来又撞上软线 —— 第二次撞线
    const first = host.handoff.automaticMode(session.id);
    const second = host.handoff.automaticMode(session.id);

    // 同一段上只有一道题：两道一模一样的题是一处缺陷，不是「只问一次」的口径
    expect(host.questions.list(session.id)).toHaveLength(1);

    host.questions.answer(host.questions.list(session.id)[0].id, "summary");
    // 两道等的是同一句：答复一落地，两处拿到的是同一个值
    await expect(first).resolves.toBe("summary");
    await expect(second).resolves.toBe("summary");
    expect(host.questions.list(session.id)).toEqual([]);

    // 答复到手那一格已摘掉：下一次撞线问的是一道新题（不是永远在等那个已经结束的答复）
    const third = host.handoff.automaticMode(session.id);
    expect(host.questions.list(session.id)).toHaveLength(1);
    host.questions.answer(host.questions.list(session.id)[0].id, "self");
    await expect(third).resolves.toBe("self");
  });

  it("会话行不在 → null（没有可交的那一段）", async () => {
    const host = newHost();

    await expect(host.handoff.automaticMode("没有这一段")).resolves.toBeNull();
  });
});
