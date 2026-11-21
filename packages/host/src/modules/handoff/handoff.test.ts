/**
 * 两条验收：交接态与输出闸只落在进入的那一段上，正常收口开闸、用户取消不开；
 * 交接期间这段会话的消息照样推给客户端，但不落库 —— 收口之后恢复。
 *
 * 把交接态写成宿主上的一格开关，「这一段在交接」就会连带把别的段的消息写入一起停掉 —— 那几段上
 * 的人只是发现自己的回答不再落库，界面上看不出来。
 *
 * 执行体是假的：真的 `Agent` 会起请求、跑循环、拉插件，而这两条要证的只有「订阅在什么条件下
 * 写库」和「闸开没开」。
 */

import { describe, expect, it } from "vitest";

import { AgentNS, Message, type Agent } from "@ai-zen/agents-core";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { AgentSubscription } from "../agent/subscription.js";
import { inboxTable } from "../agent/inbox.js";
import { AgentRegistry } from "../api/registry.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { NewSession } from "../session/types.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
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

/**
 * 假执行体：只做这几处会问的事，外加让用例自己触发订阅收到的那几条事件。
 *
 * `on` 一个事件名只留一个监听者就够了：同一个执行体不会把同一件事订阅两次。
 */
function fakeAgent() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const agent = {
    state: "idle" as AgentNS.AgentState,
    isInputPaused: false,
    isOutputPaused: false,
    inboxPending: [],
    subAgents: [],
    start: () => Promise.resolve(),
    kill: () => {},
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    pauseOutput: () => {
      agent.isOutputPaused = true;
    },
    resumeOutput: () => {
      agent.isOutputPaused = false;
    },
    fire(event: string, payload: unknown): void {
      listeners.get(event)?.(payload);
    },
  };
  return agent;
}

function setup() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const seen: HostEvent[] = [];
  events.subscribe((event) => seen.push(event));

  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });
  const agents = new AgentRegistry({ sessions, workspaces, events });
  const handoff = new HandoffService({ db, sessions, agents, events, t });

  const errors: unknown[] = [];

  /** 造一个活着的执行体，并把真的那条订阅接在它上面 */
  function wake(sessionId: string) {
    const agent = fakeAgent();
    agents.add(
      sessionId,
      agent as unknown as Agent,
      new AgentSubscription(
        {
          messages,
          inbox,
          events,
          onError: (error) => errors.push(error),
          isHandingOff: (id) => handoff.isHandingOff(id),
        },
        sessionId,
        agent as unknown as Agent,
      ),
    );
    return agent;
  }

  return { handoff, sessions, agents, messages, seen, errors, wake };
}

function handoffEvents(seen: HostEvent[]): HostEvent[] {
  return seen.filter((event) => event.type === "session.handoff");
}

function message(id: string, text: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: text,
  });
}

describe("交接态", () => {
  it("只落在进入的那一段上；收口开闸、取消不开；事件一进一出", () => {
    const { handoff, sessions, agents, seen, wake } = setup();
    const first = sessions.create(input);
    const second = sessions.create(input);
    wake(first.id);
    wake(second.id);

    handoff.start(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(true);
    expect(handoff.isHandingOff(second.id)).toBe(false);
    // 闸也只在那一格上：另一段还在正常取件
    expect(agents.liveState(first.id)?.outputPaused).toBe(true);
    expect(agents.liveState(second.id)?.outputPaused).toBe(false);

    handoff.finish(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(agents.liveState(first.id)?.outputPaused).toBe(false);

    // 用户按了停：退出交接态，闸留在关着的那一边（回滚之后就该停着）
    handoff.start(first.id);
    handoff.cancel(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(agents.liveState(first.id)?.outputPaused).toBe(true);

    expect(handoffEvents(seen)).toEqual([
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
    ]);
  });
});

describe("交接期间不落库", () => {
  it("消息照样推给客户端，一行都不进库；收口之后恢复", () => {
    const { handoff, sessions, messages, seen, errors, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    handoff.start(session.id);
    agent.fire("messageAdded", {
      agent,
      message: message("m-1", "这一任最后说的"),
      subAgent: undefined,
      via: undefined,
    });

    expect(messages.get("m-1")).toBeUndefined();
    expect(seen.filter((event) => event.type === "message.added")).toHaveLength(1);

    handoff.finish(session.id);
    agent.fire("messageAdded", {
      agent,
      message: message("m-2", "收口之后说的"),
      subAgent: undefined,
      via: undefined,
    });

    expect(messages.get("m-2")?.content).toBe("收口之后说的");
    expect(errors).toEqual([]);
  });
});
