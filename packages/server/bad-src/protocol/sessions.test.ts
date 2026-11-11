/**
 * 事件面的几条不变量 —— 用**类型**钉住，而不是靠人眼数。
 *
 * 事件名现在是三个字面量联合类型（`AgentEventName` / `SessionEventName` / `ServerEventName`），
 * 不是三张运行期表：线上叫什么名字是**形状**，归协议；谁去发它、什么时候发是**实现**。
 * 所以这些不变量只能在类型层表达 —— 这也是它们最该在的地方：写错一个名字，下面的
 * `toEqualTypeOf` 当场编译不过。
 *
 * 为什么值得钉：事件名错了之后没有任何运行期错误 —— 把 `chunk-parsed` 写成 `session-delta`
 * 照样能编译、照样能跑，只是客户端订阅的那一条静默失效（界面永远停在「生成中」）。
 */

import { describe, expectTypeOf, it } from "vitest";
import type { AgentEventName, ServerEventName, SessionEventName } from "./sessions.js";

describe("事件面", () => {
  it("Agent 8 条，逐字等于 core `Agent.events` 的原名", () => {
    // 逐字相等而不是子集：这些条的意义就在于**同名**。core 的 `chunk-parsed`（正文增量）
    // 与 `message`（整条消息）不上线 —— 前者客户端折 `chunk` 就有，后者被 `tool-call-end`
    // 与快照覆盖。
    expectTypeOf<AgentEventName>().toEqualTypeOf<
      | "open"
      | "chunk"
      | "parsed"
      | "tool-call-end"
      | "error"
      | "finally"
      | "sub-agent-start"
      | "sub-agent-end"
    >();
  });

  it("会话事件 6 条：全部带 `session-` 前缀", () => {
    expectTypeOf<SessionEventName>().toEqualTypeOf<
      | "session-phase"
      | "session-turn-end"
      | "session-notice"
      | "session-question"
      | "session-id-changed"
      | "session-title-changed"
    >();
  });

  it("服务端自己的通知 1 条", () => {
    expectTypeOf<ServerEventName>().toEqualTypeOf<"server-notice">();
  });
});
