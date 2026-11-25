/**
 * 撞上硬线之后说给用户听的那一句（`GuardNoticePlugin`）。
 *
 * 钉住三件事：
 *
 * 1. 拒的那一刻推一条**会话内通知**：带 `sessionId`、档位是警告、`code` 是一个稳定的键，文案里
 *    拿得出用量与阈值这两个数（只写一句「超出限制」等于没说，用户不知道该把哪个数调到哪里）；
 * 2. 同一次撞线只说一条：用户不改阈值、接着说，护栏每跑一次都拒，而提示栏位有限，逐次刷屏会把
 *    别的通知盖掉；
 * 3. 拒不等于坏掉：拦下来的是一句拒绝理由（core 据此不发这一次请求），阈值调到线下之后同一颗
 *    插件当场放行 —— 这一段还能接着走。
 *
 * 台架照 `materials.test.ts`：真内存库、真 `SessionService` / `NoticeService`，插件从
 * `materialsFor` 交出来的那一份里取 —— 断言的那条通知因此是宿主真的推出去的那一条，而不是这个
 * 用例自己造出来的。
 */

import { describe, expect, it } from "vitest";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { NoticeService } from "../notice/service.js";
import { noticeTable } from "../notice/table.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { SessionRecord } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import { WorkspaceService } from "../workspace/service.js";
import { GUARD_BLOCKED_NOTICE_CODE, GuardNoticePlugin } from "./guard-notice.js";
import { inboxTable } from "./inbox.js";
import { materialsFor } from "./materials.js";
import type { MaterialsDeps } from "./materials.js";

/** 生效模型：硬线 1000。会话行不给 `guardThreshold` 时用的就是它 */
const MODEL = {
  id: "model-1",
  name: "模型一",
  endpointId: "ep-1",
  tokenThresholds: { handoff: 400, guard: 1000 },
};

function setup() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  /** 这一条路上通知只走「推出去」这一半：宿主日志那一路另有它的用例 */
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const notices = new NoticeService({ notices: noticeTable(db), events, log });
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });

  const deps = {
    workspaces: new WorkspaceService({ workspaces: workspaceTable(db), t }),
    definitions: {
      get: async (): Promise<AgentDefinition> => ({
        id: "agent-1",
        name: "AgentDefinition",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    } as unknown as MaterialsDeps["definitions"],
    config: {
      read: () => ({ defaultModel: "model-1", models: [MODEL] }) as unknown as AppConfig,
    } as unknown as MaterialsDeps["config"],
    messages: messageTable(db),
    inbox: inboxTable(db),
    sessions,
    handoff: {
      automatic: () => ({}) as never,
      automaticMode: async () => null,
    } as unknown as MaterialsDeps["handoff"],
    assetPort: { readAsset: () => undefined },
    notices,
    t,
    onError: () => {},
  } as MaterialsDeps;

  const session: SessionRecord = sessions.create({
    workspaceId: "ws-1",
    name: "1712345678000",
    nameSource: "default",
    agentId: "agent-1",
    modelId: "model-1",
    autoHandoff: false,
    lineage: null,
  });

  /** 推给客户端的每一条事实：通知也是从这里出去的一条，界面与另一个客户端看的就是它 */
  const pushed: HostEvent[] = [];
  events.subscribe((event) => pushed.push(event));

  return { deps, sessions, notices, session, pushed };
}

/** 一条带用量的 AgentDefinition 消息：护栏只从消息上读用量 */
function answered(promptTokens: number): AgentNS.Message {
  return new Message({
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: "上一句回答",
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 1,
      total_tokens: promptTokens + 1,
    },
  });
}

/** 假 Agent：护栏只看 `agent.messages` */
function fakeAgent(promptTokens: number) {
  return { messages: [answered(promptTokens)] };
}

function innerLoopCtx(agent: unknown): never {
  return { agent, body: { messages: [] } } as never;
}

async function guardOf(deps: MaterialsDeps, session: SessionRecord): Promise<GuardNoticePlugin> {
  const materials = await materialsFor(deps, session);
  const guard = (materials.plugins ?? []).find((plugin) => plugin instanceof GuardNoticePlugin);
  if (guard === undefined) throw new Error("材料里没有 GuardNoticePlugin");
  return guard as GuardNoticePlugin;
}

describe("撞上硬线之后", () => {
  it("推一条会话内通知：警告档、带会话 id、文案里有用量与阈值两个数", async () => {
    const host = setup();
    const guard = await guardOf(host.deps, host.session);

    const denied = await guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)));

    // 拒本身照旧：给回一句理由，core 据此不发这一次请求（抛错会把整个循环打死）
    expect(typeof denied).toBe("string");

    const rows = host.notices.listBySession(host.session.id);
    expect(rows).toHaveLength(1);
    const [notice] = rows;
    expect(notice?.sessionId).toBe(host.session.id);
    expect(notice?.level).toBe("warning");
    expect(notice?.code).toBe(GUARD_BLOCKED_NOTICE_CODE);
    // 两个数：这一次带上去的用量，以及被撞的那条线。只写「超出限制」的文案过不了这一条
    expect(notice?.message).toContain("1200");
    expect(notice?.message).toContain("1000");

    // 通知是推给客户端的一条事实，不是只落在测试里：另一个客户端靠它当场看见这件事
    const noticeEvents = host.pushed.filter((event) => event.type === "notice");
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]).toMatchObject({
      type: "notice",
      notice: { code: GUARD_BLOCKED_NOTICE_CODE, sessionId: host.session.id },
    });
  });

  it("同一次撞线只说一条：接着说话又被拒，不再刷第二条", async () => {
    const host = setup();
    const guard = await guardOf(host.deps, host.session);

    // 同一条线上连拒三次（每次拒都是 core 发一次请求前判定一次）
    await guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)));
    await guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)));
    await guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)));

    expect(host.notices.listBySession(host.session.id)).toHaveLength(1);

    // 放行过一次之后再撞，是重新撞上：说新的那一条
    await guard.onInnerLoopStart(innerLoopCtx(fakeAgent(10)));
    await guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1300)));

    const rows = host.notices.listBySession(host.session.id);
    expect(rows).toHaveLength(2);
    // 两条各自的数字：第二条说的是重新撞上时的那一对（同一毫秒里落库，先后次序不参与断言）
    expect(rows.map((row) => row.message).join("\n")).toContain("1300");
  });

  it("拒了之后这一段还能继续：阈值调到线下，同一颗插件下一次就放行", async () => {
    const host = setup();
    const guard = await guardOf(host.deps, host.session);

    await expect(guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)))).resolves.toEqual(
      expect.any(String),
    );

    // 阈值是取值函数：改会话行当场生效，不重建 Agent
    host.sessions.update(host.session.id, { guardThreshold: 2000 });

    await expect(guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)))).resolves.toBeUndefined();
  });

  it("会话已经没了就不推：通知挂在会话名下，行没了会撞外键", async () => {
    const host = setup();
    const guard = await guardOf(host.deps, host.session);

    host.sessions.remove(host.session.id);

    await expect(guard.onInnerLoopStart(innerLoopCtx(fakeAgent(1200)))).resolves.toEqual(
      expect.any(String),
    );
    expect(host.notices.list()).toEqual([]);
  });
});
