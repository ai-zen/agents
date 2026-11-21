/**
 * `session.remove`：删掉一段会话（硬删）。
 *
 * 六条验收：删完之后会话行、消息、排队区、通知都没了；素材按引用归零才删；还被另一段会话引用着
 * 的那一份留着；活着的执行体先被杀掉、之后才删行；删成功之后推一条 `session.removed`；不存在的
 * 会话报 `not_found`、一条事件都不推。
 *
 * `session.removed` 那一条说的是别的客户端：发起删除的那个自己会换屏，同一台机器上另一个连着的
 * 客户端手里的列表要跟着消失，靠的就是这一条 —— 它不带的话，那个客户端要等到下一次 `session.list`
 * 才发现少了一段。`not_found` 那一条反过来验它不多说：什么都没删，就没有「这段没了」可说。
 *
 * 通知那一条不是顺手加的：它落在 `notices.sessionId` 那条外键上，外键一旦不是级联，界面上就留下
 * 一批指着一段不存在的会话的通知，谁也不报。全局通知（`sessionId` 为 `null`）不被连坐，与它一起
 * 验。
 *
 * 「先杀后删」那一条问的是次序而不是结果：杀晚一步，那一段的行已经没了，执行体还在往它上面写。
 *
 * 台架照 `agent.clearInbox.test.ts`：真内存库、真 `SessionService` / `AssetService` / `QuestionRegistry`，
 * 消息、排队区、通知都是真表；执行体与交接只给这一条路用到的那一格（`kill` / `forget`）——
 * 真 `AgentRuntime` 与真交接要起执行体、跑编排，而这些用例要证的是「删完之后少了什么」。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentRuntime } from "@ai-zen/agents-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { HostError } from "../../infra/errors.js";
import { inboxTable } from "../agent/inbox.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import type { HostEvent } from "../events.js";
import type { HandoffService } from "../handoff/service.js";
import { createTranslator } from "../i18n/index.js";
import type { Notice } from "../notice/types.js";
import { noticeTable } from "../notice/table.js";
import { QuestionRegistry } from "../question/registry.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { Session } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import type { HostApiDeps } from "./deps.js";
import { sessionRouter } from "./session.js";
import { createTrpc } from "./trpc.js";

const WORKSPACE_ID = "ws-1";
const OTHER_WORKSPACE_ID = "ws-2";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 一个真库加这一条路上的几个域。素材要落到盘上，所以数据根也是真的临时目录：`orphanPath` 那几条
 * 断言看的是字节在不在，只看行数看不出「删了行、字节还躺着」。
 */
function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "session-remove-"));
  dataRoots.push(dataRoot);

  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: WORKSPACE_ID, name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  workspaceTable(db).put({
    id: OTHER_WORKSPACE_ID,
    name: "项目二",
    cwd: "/tmp/ws-2",
    createdAt: 2,
  });

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const notices = noticeTable(db);
  const assets = new AssetService({
    assets: assetTable(db),
    sessionAssets: sessionAssetTable(db),
    dataRoot,
    t,
  });
  const questions = new QuestionRegistry({ events, t });

  /** 这一路做过的事按发生次序记一笔：次序本身就是「先杀后删」那一条的结论 */
  const log: string[] = [];

  /** 推给客户端的每一条事实：另一个连着的客户端看到的就是这一串 */
  const pushed: HostEvent[] = [];
  events.subscribe((event) => pushed.push(event));
  const runtime = {
    kill: (sessionId: string) => void log.push(`kill ${sessionId}`),
  } as unknown as AgentRuntime;

  /** 交接那一侧的两格：这条路上只要「有没有人来忘」这一件事 */
  const forgotten: string[] = [];
  const handoff = {
    forget: (sessionId: string) => void forgotten.push(sessionId),
  } as unknown as HandoffService;

  // 这一条 procedure 只用这几格，其余域整份转成 `HostApiDeps`：补齐它们得先编出七八个与本题
  // 无关的替身，那些替身一格都不会被走到。
  const deps = {
    sessions,
    messages,
    inbox,
    notices,
    assets,
    runtime,
    questions,
    handoff,
    events,
    t,
  } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({ session: sessionRouter(deps, api) });
  const caller = router.createCaller({});

  function newSession(workspaceId = WORKSPACE_ID): Session {
    return sessions.create({
      workspaceId,
      name: "1712345678000",
      nameIsAuto: true,
      agentId: "agent-1",
      modelId: "model-1",
      autoHandoff: false,
      lineage: null,
    });
  }

  return {
    dataRoot,
    sessions,
    messages,
    inbox,
    notices,
    assets,
    questions,
    log,
    forgotten,
    pushed,
    caller,
    newSession,
  };
}

type Host = ReturnType<typeof setup>;

function message(id: string, content: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content,
  });
}

/** 一条还没取走的话。`messageId` 同时是这一行的 id —— 它就是核心在恢复时放回队列的那个 id */
function inboxEntry(messageId: string, content: string) {
  return {
    messageId,
    createdAt: "2026-01-01T00:00:00.000Z",
    priority: "low",
    source: { kind: "user" },
    content,
  } as const;
}

function notice(id: string, sessionId: string | null, createdAt: number): Notice {
  return {
    id,
    level: "info",
    code: "test",
    message: "一句通知",
    durationMs: null,
    sessionId,
    createdAt,
  };
}

/**
 * 这一次调用抛出的是哪个 `HostError`。tRPC 把 resolver 抛出的原始错误放在 `cause` 里（出网那一层
 * 换成 tRPC 自己的码），所以码要从 `cause` 上读。
 */
async function hostErrorOf(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof HostError) return cause;
    throw error;
  }
  throw new Error("这一次调用没有抛错");
}

describe("删一段会话", () => {
  it("会话行、消息、排队区、通知都没了，回的是删掉了几条消息", async () => {
    const host = setup();
    const session = host.newSession();
    host.messages.upsertMany(session.id, [message("m-1", "第一句"), message("m-2", "第二句")]);
    host.inbox.insert(session.id, inboxEntry("i-1", "还没被取走的一句"));
    host.notices.put(notice("n-1", session.id, 1));
    // 全局通知不属于任何一段，哪一段被删都不该连坐
    host.notices.put(notice("n-global", null, 2));

    const removed = await host.caller.session.remove({ sessionId: session.id });

    // 出参就是「这一次删掉了什么」：两条消息、没有素材跟着归零
    expect(removed).toEqual({ messages: 2, assets: 0 });
    expect(host.sessions.get(session.id)).toBeUndefined();
    expect(host.messages.listBySession(session.id)).toEqual([]);
    expect(host.inbox.listBySession(session.id)).toEqual([]);
    expect(host.notices.list().map((row) => row.id)).toEqual(["n-global"]);
  });

  it("素材按引用归零才删：只被这一段引用的删掉，另一段还引用着的那一份留着", async () => {
    const host = setup();
    const doomed = host.newSession();
    const kept = host.newSession(OTHER_WORKSPACE_ID);

    const shared = host.assets.store(Buffer.from("两段会话都引用的字节"), "image/png", null);
    const orphan = host.assets.store(Buffer.from("只被这一段引用过"), "image/png", null);
    const sharedPath = join(host.dataRoot, "assets", shared.sha256);
    const orphanPath = join(host.dataRoot, "assets", orphan.sha256);

    host.messages.upsertMany(doomed.id, [
      message("m-1", "引用第一份"),
      message("m-2", "引用第二份"),
    ]);
    host.assets.link("m-1", [shared.id]);
    host.assets.link("m-2", [orphan.id]);
    host.messages.upsertMany(kept.id, [message("m-3", "也引用第一份")]);
    host.assets.link("m-3", [shared.id]);

    const removed = await host.caller.session.remove({ sessionId: doomed.id });

    // 引用过两份，跟着归零删掉的只有一份
    expect(removed).toEqual({ messages: 2, assets: 1 });
    // 第一份还挂在没被删的那一段上：行与字节都留着
    expect(host.assets.listBySession(kept.id)).toEqual([shared]);
    expect(existsSync(sharedPath)).toBe(true);
    // 第二份的最后一条引用随这一段一起没了：行与字节都不该留着
    expect(() => host.assets.get(orphan.id)).toThrow(HostError);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("活着的执行体先被杀掉，之后才删行", async () => {
    const host = setup();
    const session = host.newSession();

    // 删行那一刻也记进同一份次序：只断言「被杀过」证明不了次序
    const removeRow = host.sessions.remove.bind(host.sessions);
    vi.spyOn(host.sessions, "remove").mockImplementation((id: string) => {
      host.log.push("remove row");
      removeRow(id);
    });

    await host.caller.session.remove({ sessionId: session.id });

    expect(host.log).toEqual([`kill ${session.id}`, "remove row"]);
  });

  it("这一段上挂着的题跟着收、交接那一侧的记忆跟着忘", async () => {
    const host = setup();
    const session = host.newSession();
    const { answer } = host.questions.askAwaitable({
      sessionId: session.id,
      message: "这段会话装不下时，用哪种方式交接？",
      choices: [
        { value: "self", label: "自交接" },
        { value: "no", label: "不交接" },
      ],
      blocking: false,
    });

    await host.caller.session.remove({ sessionId: session.id });

    // 题没有表，不随会话行被级联掉：等它的人拿到的是「没人答它了」，不是「用户说了不」
    await expect(answer).resolves.toBeUndefined();
    expect(host.questions.list(session.id)).toEqual([]);
    // 「答过不交接」与「此刻挂着的那道题」两格都按会话 id 存，那一段没了就得忘
    expect(host.forgotten).toEqual([session.id]);
  });

  it("删成功之后推一条 session.removed，载荷里是那一段的 id", async () => {
    const host = setup();
    const session = host.newSession();

    await host.caller.session.remove({ sessionId: session.id });

    // 只认这一条：另一个客户端靠它把列表里那一段拿掉，别的账它不记
    const removed = host.pushed.filter((event) => event.type === "session.removed");
    expect(removed).toEqual([{ type: "session.removed", sessionId: session.id }]);
  });

  it("会话不存在时是 not_found，且一个字都没动", async () => {
    const host = setup();

    const error = await hostErrorOf(host.caller.session.remove({ sessionId: "没有这一段" }));

    // 与 `session.open` 同一句话、同一份 `details`：客户端只认一处文案
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("找不到 id 为 没有这一段 的会话");
    expect(error.details).toEqual({ entity: "session", sessionId: "没有这一段" });
    // 没有这一段，就没有什么可杀、可收、可删
    expect(host.log).toEqual([]);
    expect(host.forgotten).toEqual([]);
    // 什么都没删，就没有「这段没了」可说：推一条会叫另一个客户端去删一段不存在的会话
    expect(host.pushed.filter((event) => event.type === "session.removed")).toEqual([]);
  });
});
