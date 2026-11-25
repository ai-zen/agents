/**
 * 六条验收：删项目连带删掉名下的会话（连消息与 inbox 行）、活着的 Agent 先被杀掉再删行、
 * Asset 只扫这几段会话引用过的那些、项目不存在时是 `not_found`、那几段上挂着的题跟着一起收。
 * 第六条是交接那一侧按会话记的两格（「这一段答过不交接、不再问」）跟着一起忘。
 *
 * 第一条与第三条都是「不报错也不工作」的那种错：外键没级联时，界面上只会剩下几段挂在不存在的
 * 项目下的会话；Asset 没人收时，行与盘上的字节就这么漏着，谁也不报。
 *
 * 第二条的理由是次序而不是结果：杀晚一步，那段会话的行已经没了，Agent 还在往它上面写。
 *
 * 第五条是题的**第二条**去处（`dev-docs/prd/01-decisions.md` 第 107–111 行：题挂到「被答了」或
 * 「这段会话没了」为止）：题没有表、不随外键级联，所以「这一段没了」这件事只能由删它的人去说。
 * 等那个答复的人拿到的 `undefined` 是「没人答它了」，不是「用户说了不」。
 *
 * 第六条跟第五条是同一件事的两半：「不再问」那一格也在交接那一侧的内存里，会话行没了它不会自己
 * 消失。留着它，同一段 id 再出现时一撞线就闭嘴，而那段其实从没被问过。
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
import { HandoffService } from "../handoff/service.js";
import { createTranslator } from "../i18n/index.js";
import { QuestionRegistry } from "../question/registry.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { SessionRecord } from "../session/types.js";
import { removeWorkspace } from "./remove.js";
import type { RemoveWorkspaceDeps } from "./remove.js";
import { WorkspaceService } from "./service.js";
import { workspaceTable } from "./table.js";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 一个真库加这一条路上的五个域。Agent 给替身：这些用例问的是次序与连带，不是运行时自己的行为，
 * 造一个真的 `AgentRuntime` 只会让人以为它也在被验。
 */
function newHost() {
  const dataRoot = mkdtempSync(join(tmpdir(), "workspace-remove-"));
  dataRoots.push(dataRoot);

  const db = openDatabase(":memory:");
  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });
  const sessionRows = sessionTable(db);
  const sessions = new SessionService({
    sessions: sessionRows,
    events,
    t,
  });
  const questions = new QuestionRegistry({ events, t });
  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const assets = new AssetService({
    assets: assetTable(db),
    sessionAssets: sessionAssetTable(db),
    dataRoot,
    t,
  });

  /** 这一路做过的事按发生顺序记一笔：次序本身就是第二条的那个结论 */
  const log: string[] = [];
  const runtime = {
    kill: (sessionId: string) => void log.push(`kill ${sessionId}`),
  } as unknown as AgentRuntime;

  // 交接也是真的要：第六条验的就是它按会话记下的「不再问」那一格会不会跟着这一段一起消失。
  // 它不真的跑交接（`createSdk` 一叫就抛），这几条用例也走不到那一步。
  const handoff = new HandoffService({
    db,
    sessions,
    messages,
    workspaces,
    runtime,
    notices: {} as never,
    questions,
    events,
    t,
    createSdk: () => {
      throw new Error("替身不跑交接");
    },
  });

  const deps: RemoveWorkspaceDeps = {
    workspaces,
    sessions,
    assets,
    runtime,
    questions,
    handoff,
    events,
    t,
  };

  return {
    workspaces,
    sessions,
    sessionRows,
    messages,
    inbox,
    assets,
    questions,
    handoff,
    events,
    dataRoot,
    log,
    deps,
  };
}

type Host = ReturnType<typeof newHost>;

function newSession(host: Host, workspaceId: string): SessionRecord {
  return host.sessions.create({
    workspaceId,
    name: "1712345678000",
    nameSource: "default",
    agentId: "agent-1",
    modelId: "model-1",
    autoHandoff: false,
    lineage: null,
  });
}

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

describe("删项目", () => {
  it("连带删掉名下的会话，返回的正是那几段", () => {
    const host = newHost();
    const workspace = host.workspaces.create("项目一", "/tmp/连带删会话");
    const first = newSession(host, workspace.id);
    const second = newSession(host, workspace.id);
    host.messages.upsertMany(first.id, [
      message("m-1", "第一段第一句"),
      message("m-2", "第一段第二句"),
    ]);
    host.messages.upsertMany(second.id, [message("m-3", "第二段第一句")]);
    host.inbox.insert(first.id, inboxEntry("i-1", "还没取走的一句"));
    host.inbox.insert(second.id, inboxEntry("i-2", "另一段还没取走的一句"));

    const removed = removeWorkspace(host.deps, workspace.id);

    expect([...removed.sessions].sort()).toEqual([first.id, second.id].sort());
    expect(host.workspaces.get(workspace.id)).toBeUndefined();
    expect(host.sessions.list(workspace.id)).toEqual([]);
    expect(host.sessions.get(first.id)).toBeUndefined();
    expect(host.messages.listBySession(first.id)).toEqual([]);
    expect(host.messages.get("m-3")).toBeUndefined();
    expect(host.inbox.listBySession(first.id)).toEqual([]);
    expect(host.inbox.listBySession(second.id)).toEqual([]);
  });

  it("活着的Agent先被杀掉，之后才删行", () => {
    const host = newHost();
    const workspace = host.workspaces.create("项目一", "/tmp/先杀后删");
    const first = newSession(host, workspace.id);
    const second = newSession(host, workspace.id);

    // 删行那一刻也记进同一份次序：只断言「被杀过」证明不了次序，而次序错了的话，杀之前的
    // 这一段时间里 Agent 还在往一行已经没了的会话上写。
    const removeRow = host.workspaces.remove.bind(host.workspaces);
    vi.spyOn(host.workspaces, "remove").mockImplementation((id: string) => {
      host.log.push("remove row");
      removeRow(id);
    });

    removeWorkspace(host.deps, workspace.id);

    expect(host.log.slice(0, 2).sort()).toEqual([`kill ${first.id}`, `kill ${second.id}`].sort());
    expect(host.log.slice(2)).toEqual(["remove row"]);
  });

  it("只扫这几段会话引用过的Asset：没人引用的行与字节都没了，还有引用的留着", () => {
    const host = newHost();
    const doomed = host.workspaces.create("要删的项目", "/tmp/要删的项目");
    const kept = host.workspaces.create("留着的项目", "/tmp/留着的项目");
    const first = newSession(host, doomed.id);
    const second = newSession(host, doomed.id);
    const third = newSession(host, kept.id);

    const shared = host.assets.store(Buffer.from("两段会话都引用的字节"), "image/png", null);
    const orphan = host.assets.store(Buffer.from("只被删掉的那一段引用过"), "image/png", null);
    const sharedPath = join(host.dataRoot, "assets", shared.sha256);
    const orphanPath = join(host.dataRoot, "assets", orphan.sha256);

    host.messages.upsertMany(first.id, [message("m-1", "引用第一份")]);
    host.assets.link("m-1", [shared.id]);
    host.messages.upsertMany(second.id, [message("m-2", "引用第二份")]);
    host.assets.link("m-2", [orphan.id]);
    host.messages.upsertMany(third.id, [message("m-3", "也引用第一份")]);
    host.assets.link("m-3", [shared.id]);

    removeWorkspace(host.deps, doomed.id);

    // 第一份还挂在没被删的那一段上：行与字节都留着
    expect(host.assets.listBySession(third.id)).toEqual([shared]);
    expect(existsSync(sharedPath)).toBe(true);
    // 第二份的最后一条引用随会话一起没了：行与字节都不该留着
    expect(() => host.assets.get(orphan.id)).toThrow(HostError);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("项目不存在时是 not_found", () => {
    const host = newHost();

    let thrown: unknown;
    try {
      removeWorkspace(host.deps, "没有这个项目");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HostError);
    expect((thrown as HostError).code).toBe("not_found");
  });

  it("那几段上挂着的题跟着一起收：等它的人拿到 undefined", async () => {
    const host = newHost();
    const workspace = host.workspaces.create("项目一", "/tmp/题跟着收");
    const session = newSession(host, workspace.id);
    const { answer } = host.questions.askAwaitable({
      sessionId: session.id,
      message: "这段会话装不下时，用哪种方式交接？",
      requestedSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["self", "no"], enumNames: ["自交接", "不交接"] },
        },
        required: ["mode"],
      },
      blocking: false,
    });

    removeWorkspace(host.deps, workspace.id);

    // 题没有表，不会随会话行被级联掉：不在这里收，这道题就再没人认得
    await expect(answer).resolves.toBeUndefined();
    expect(host.questions.list(session.id)).toEqual([]);
  });

  it("交接那侧的「不再问」也跟着忘：同一段 id 再撞线会重新问", async () => {
    const host = newHost();
    const workspace = host.workspaces.create("项目一", "/tmp/不再问跟着忘");
    const session = newSession(host, workspace.id);

    // 先答一次「不交接」：这一段被记进「不再问」那一格，再撞线一道题都不出
    const asked = host.handoff.automaticMode(session.id);
    host.questions.answer(host.questions.list(session.id)[0].id, {
      action: "accept",
      content: { mode: "no" },
    });
    await expect(asked).resolves.toBeNull();
    await expect(host.handoff.automaticMode(session.id)).resolves.toBeNull();
    expect(host.questions.list(session.id)).toEqual([]);

    removeWorkspace(host.deps, workspace.id);

    // 会话行随项目一起没了（第一格判据先把它拦在 `null` 上），所以「不再问」那一格清没清，
    // 只有同一段 id 再回到库里才看得见：放一行同 id 的会话回去，撞线应当重新问，而不是闭嘴
    const again = host.workspaces.create("另一个项目", "/tmp/不再问跟着忘-2");
    host.sessionRows.put({ ...session, workspaceId: again.id, autoHandoff: false });

    const reopened = host.handoff.automaticMode(session.id);
    const question = host.questions.list(session.id)[0];
    expect(question).toBeDefined();
    host.questions.answer(question.id, { action: "accept", content: { mode: "self" } });
    await expect(reopened).resolves.toBe("self");
  });
});
