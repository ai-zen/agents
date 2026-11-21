/**
 * 一条验收：交接态是每段会话各自的一格。
 *
 * 把它写成宿主上的一格开关，「这一段在交接」就会连带把别的段的消息写入一起停掉 —— 那几段上
 * 的人只是发现自己的回答不再落库，界面上看不出来。
 *
 * 落库那一半（交接期间跳过写库）断言不到：写库发生在执行体的订阅里，这一波不动那个文件。
 * 这里钉住它据以判断的那一格。
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { createBus } from "../../infra/bus.js";
import { createTranslator } from "../i18n/index.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { NewSession } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import { HandoffService, type HandoffEvent } from "./service.js";

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameIsAuto: true,
  autoHandoff: false,
  lineage: null,
};

function setup() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const sessions = new SessionService({ sessions: sessionTable(db), t });
  const events = createBus<HandoffEvent>();
  const seen: HandoffEvent[] = [];
  events.subscribe((event) => seen.push(event));

  return { handoff: new HandoffService({ sessions, events, t }), sessions, seen };
}

describe("交接态", () => {
  it("交接态只落在进入的那一段上，收口之后清掉，事件一进一出", () => {
    const { handoff, sessions, seen } = setup();
    const first = sessions.create(input);
    const second = sessions.create(input);

    handoff.start(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(true);
    expect(handoff.isHandingOff(second.id)).toBe(false);

    handoff.finish(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(handoff.isHandingOff(second.id)).toBe(false);

    expect(seen).toEqual([
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
    ]);
  });
});
