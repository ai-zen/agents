/**
 * 撤回的四条验收：从这一条起连它一起硬删、只认自己说的话、跑着的时候不许撤、Asset 跟着收。
 *
 * 三条错法都是「不报错也不工作」：删了库没删记忆（模型下一次请求还看得见自己说过的那半截）、
 * 撤到一条 AgentDefinition 的话上（语义上不是「这一句不算我说过」）、跑着的时候从外面 `splice` 记忆
 * （内核正在往同一个数组里写）。第四条漏掉时，没人再引用的 Asset 行与盘上的字节就这么漏着。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentRuntime } from "@ai-zen/agents-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { HostError } from "../../infra/errors.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { workspaceTable } from "../workspace/table.js";
import { messageTable } from "./messages.js";
import { rewindTo } from "./rewind.js";
import type { RewindDeps } from "./rewind.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { SessionRecord } from "./types.js";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

/** 一个会回话的 Agent 替身：这条路上只问两件事 —— 它忙不忙、它的记忆是哪一个数组 */
interface FakeAgent {
  state: AgentNS.AgentState;
  messages: AgentNS.Message[];
}

/**
 * 一个真库加这一段路上的四个域。Agent 给替身（只实现 `get`）：这些用例问的是「删了什么、
 * 交回去了什么」，造一个真的运行时只会让人以为它也在被验。
 *
 * 总线是真的，只是把推出来的事实记一份：「删掉的每一条都推了一条 `message.removed`」正是
 * 客户端把行去掉的那个依据。
 */
function newHost() {
  const dataRoot = mkdtempSync(join(tmpdir(), "session-rewind-"));
  dataRoots.push(dataRoot);

  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const sessions = new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t,
  });
  // 消息表先建：Asset 关联行的外键指着它
  const messages = messageTable(db);
  const assets = new AssetService({
    assets: assetTable(db),
    sessionAssets: sessionAssetTable(db),
    dataRoot,
    t,
  });

  const agents = new Map<string, FakeAgent>();
  const runtime = {
    get: (sessionId: string) => agents.get(sessionId),
  } as unknown as AgentRuntime;

  const events = createBus<HostEvent>();
  const pushed: HostEvent[] = [];
  events.subscribe((event) => pushed.push(event));

  const deps: RewindDeps = { sessions, messages, assets, runtime, events, t };

  return { sessions, messages, assets, dataRoot, agents, pushed, deps };
}

type Host = ReturnType<typeof newHost>;

function newSession(host: Host): SessionRecord {
  return host.sessions.create({
    workspaceId: "ws-1",
    name: "1712345678000",
    nameIsAuto: false,
    agentId: "agent-1",
    modelId: "model-1",
    autoHandoff: false,
    lineage: null,
  });
}

/** 用户本人说的一句话：撤回只认这一种 */
function said(id: string, content: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content,
    source: { kind: "user" },
  });
}

/** 跑这样一个动作，把抛出来的东西交回来 —— 断言码比断言「抛了」说得清是哪一种拒 */
function thrownBy(act: () => unknown): HostError {
  try {
    act();
  } catch (error) {
    if (error instanceof HostError) return error;
    throw error;
  }
  throw new Error("这一次调用没有抛错");
}

describe("撤回", () => {
  it("从这一条起连它一起硬删：库与记忆里都只剩前两条，正文交回去，每一条都推了事实", () => {
    const host = newHost();
    const session = newSession(host);
    const five = ["第一句", "第二句", "第三句", "第四句", "第五句"].map((text, index) =>
      said(`m-${index + 1}`, text),
    );
    host.messages.upsertMany(session.id, five);

    // 活着的 Agent：记忆是它自己拿着的那个数组（前面还接着 AgentDefinition 带来的系统提示）
    const memory = [
      Message.System("你是AgentDefinition"),
      ...host.messages.listBySession(session.id),
    ];
    host.agents.set(session.id, { state: "idle", messages: memory });

    const { content } = rewindTo(host.deps, session.id, "m-3");

    // 第三条的正文原样交回去，客户端拿它回填输入框
    expect(content).toBe("第三句");
    // 第三条与它之后的都没了，前两条一条不少
    expect(host.messages.listBySession(session.id).map((message) => message.id)).toEqual([
      "m-1",
      "m-2",
    ]);
    // 记忆就地删：同一个数组（不换引用），剩下系统提示与那两条
    expect(host.agents.get(session.id)!.messages).toBe(memory);
    expect(memory.map((message) => message.id)).toEqual([memory[0]!.id, "m-1", "m-2"]);
    // 删掉的每一条推一条：客户端照它把行去掉
    expect(host.pushed).toEqual([
      { type: "message.removed", sessionId: session.id, messageId: "m-3" },
      { type: "message.removed", sessionId: session.id, messageId: "m-4" },
      { type: "message.removed", sessionId: session.id, messageId: "m-5" },
    ]);
  });

  it("只认自己说的话：撤到一条AgentDefinition的话上就是 invalid_params，历史一条不少", () => {
    const host = newHost();
    const session = newSession(host);
    host.messages.upsertMany(session.id, [
      said("m-1", "第一句"),
      new Message({
        id: "m-2",
        role: AgentNS.Role.Assistant,
        status: AgentNS.MessageStatus.Completed,
        content: "AgentDefinition说的",
      }),
      said("m-3", "第三句"),
    ]);

    const error = thrownBy(() => rewindTo(host.deps, session.id, "m-2"));

    expect(error.code).toBe("invalid_params");
    expect(host.messages.listBySession(session.id).map((message) => message.id)).toEqual([
      "m-1",
      "m-2",
      "m-3",
    ]);
    expect(host.pushed).toEqual([]);

    // 目标消息不在这一段里（或根本没有这一条）是另一回事：`not_found`
    expect(thrownBy(() => rewindTo(host.deps, session.id, "没有这一条")).code).toBe("not_found");
  });

  it("跑着的时候不许撤：busy，历史与记忆都没动", () => {
    const host = newHost();
    const session = newSession(host);
    host.messages.upsertMany(session.id, [said("m-1", "第一句"), said("m-2", "第二句")]);
    const memory = host.messages.listBySession(session.id);
    host.agents.set(session.id, { state: "working", messages: memory });

    const error = thrownBy(() => rewindTo(host.deps, session.id, "m-2"));

    expect(error.code).toBe("busy");
    expect(host.messages.listBySession(session.id).map((message) => message.id)).toEqual([
      "m-1",
      "m-2",
    ]);
    expect(memory.map((message) => message.id)).toEqual(["m-1", "m-2"]);
    expect(host.pushed).toEqual([]);
  });

  it("Asset跟着收：没人再引用的行与字节都没了，还被引用的留着", () => {
    const host = newHost();
    const session = newSession(host);
    host.messages.upsertMany(session.id, [
      said("m-1", "留下的这一句"),
      said("m-2", "要被删的这一句"),
      said("m-3", "也要被删的这一句"),
    ]);

    // 一份两处引用（一处留下、一处要删）、一份只被要删的那条引用
    const shared = host.assets.store(Buffer.from("两处都引用的字节"), "image/png", null);
    const doomed = host.assets.store(Buffer.from("只被删掉的那条引用过"), "image/png", null);
    const sharedPath = join(host.dataRoot, "assets", shared.sha256);
    const doomedPath = join(host.dataRoot, "assets", doomed.sha256);

    host.assets.link("m-1", [shared.id]);
    host.assets.link("m-2", [shared.id]);
    host.assets.link("m-3", [doomed.id]);

    rewindTo(host.deps, session.id, "m-2");

    // 第一份还挂在没被删的那一条上：行与字节都留着
    expect(host.assets.listBySession(session.id)).toEqual([shared]);
    expect(existsSync(sharedPath)).toBe(true);
    // 第二份的最后一条引用随消息一起没了：行与字节都不该留着
    expect(() => host.assets.get(doomed.id)).toThrow(HostError);
    expect(existsSync(doomedPath)).toBe(false);
  });

  it("会话不存在时是 not_found", () => {
    const host = newHost();

    expect(thrownBy(() => rewindTo(host.deps, "没有这一段", "m-1")).code).toBe("not_found");
  });
});
