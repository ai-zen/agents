/**
 * 平级会话插件（SDK 侧）的验收：**不给端口就不产出任何工具**，给了端口就三个工具，
 * 而且三个工具只做三件事 —— 把参数送给端口、把结构化拒绝原样交回模型、把「别轮询 / 不等结果 /
 * 靠 label」这几句话写进 description 与返回文案。
 *
 * 会话怎么建、结果怎么投回、谁能开谁（深度）/ 谁能跟谁说话（血缘）/ 能同时开几个（限额）全在
 * 宿主那一侧（`PeerSessionService`），本文件不重复验那些。
 */

import { describe, expect, it } from "vitest";
import type { Agent, ToolCallContext } from "@ai-zen/agents-core";
import { CallbackTool } from "@ai-zen/agents-core";

import { PeerSessionsScopePlugin } from "./PeerSessionsScopePlugin.js";
import {
  CREATE_SESSION_TOOL,
  createPeerSessionTools,
  PEER_SESSION_TOOL_NAMES,
  READ_SESSION_STATUS_TOOL,
  SEND_TO_SESSION_TOOL,
} from "./peerSessionTools.js";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionSendInput,
  PeerSessionSent,
  PeerSessionStatus,
} from "./peerSessionTools.js";
import type { FilterOutput, Scope } from "../../Scope.js";

/** 插件用不到 Scope 的任何东西（它不发现、不读配置），给一个占位就够 */
const fakeScope = {} as unknown as Scope;

/** 工具的第二个参数：本插件只摸 `agent`，其余字段用例不碰 */
const fakeAgent = { id: "agent-1" } as unknown as Agent;

function contextFor(agent: Agent = fakeAgent): ToolCallContext {
  return { agent } as unknown as ToolCallContext;
}

function filteredWith(tools: string[]): FilterOutput {
  return { tools, subagents: [], skills: [], mcps: [] };
}

/** 记账式端口：把每一次调用与参数记下来，答案由用例给 */
function recordingPort(answers: {
  created?: PeerSessionCreated;
  status?: PeerSessionStatus;
  sent?: PeerSessionSent;
}): {
  port: PeerSessionPort;
  creates: PeerSessionCreateInput[];
  statuses: Array<{ caller: Agent; sessionId: string }>;
  sends: PeerSessionSendInput[];
} {
  const creates: PeerSessionCreateInput[] = [];
  const statuses: Array<{ caller: Agent; sessionId: string }> = [];
  const sends: PeerSessionSendInput[] = [];
  const port: PeerSessionPort = {
    async create(input) {
      creates.push(input);
      return answers.created ?? { ok: true, sessionId: "session-1", label: "会话 1" };
    },
    async status(input) {
      statuses.push(input);
      return answers.status ?? { state: "running" };
    },
    async send(input) {
      sends.push(input);
      return answers.sent ?? { ok: true, state: "idle" };
    },
  };
  return { port, creates, statuses, sends };
}

/** 直接调回调（绕过 core 的 tool_call 解析）：本插件关心的只有「参数 + ctx.agent」 */
async function call(
  tool: unknown,
  args: Record<string, unknown>,
  ctx: ToolCallContext = contextFor(),
): Promise<unknown> {
  const callback = (tool as CallbackTool).callback;
  if (!callback) throw new Error("tool has no callback");
  return await callback(args, ctx);
}

describe("PeerSessionsScopePlugin：端口决定能力面", () => {
  it("不给端口 → candidates 为空、instantiate 空数组（三个工具一个都不产出，老行为一个字不变）", () => {
    const plugin = new PeerSessionsScopePlugin();
    expect(plugin.candidates()).toEqual({});
    expect(plugin.instantiate(fakeScope, filteredWith([...PEER_SESSION_TOOL_NAMES]))).toEqual([]);
    // 连工具名单里也没有它们：没有端口的 SDK 用户看到的能力面与从前一致
    expect([...PEER_SESSION_TOOL_NAMES]).toEqual([
      CREATE_SESSION_TOOL,
      READ_SESSION_STATUS_TOOL,
      SEND_TO_SESSION_TOOL,
    ]);
  });

  it("给了端口 → 三个候选名，按权限过滤结果实例化", () => {
    const { port } = recordingPort({});
    const plugin = new PeerSessionsScopePlugin(port);

    expect(plugin.candidates()).toEqual({
      tools: [CREATE_SESSION_TOOL, READ_SESSION_STATUS_TOOL, SEND_TO_SESSION_TOOL],
    });

    const all = plugin.instantiate(fakeScope, filteredWith([...PEER_SESSION_TOOL_NAMES]));
    expect(all.map((tool) => tool.function.name)).toEqual([
      CREATE_SESSION_TOOL,
      READ_SESSION_STATUS_TOOL,
      SEND_TO_SESSION_TOOL,
    ]);

    // `Scope.filter` 只放行一个（权限白名单）→ 就只实例化那一个
    const onlyCreate = plugin.instantiate(fakeScope, filteredWith([CREATE_SESSION_TOOL]));
    expect(onlyCreate.map((tool) => tool.function.name)).toEqual([CREATE_SESSION_TOOL]);

    // 发消息那个也可以被单独放行
    const onlySend = plugin.instantiate(fakeScope, filteredWith([SEND_TO_SESSION_TOOL]));
    expect(onlySend.map((tool) => tool.function.name)).toEqual([SEND_TO_SESSION_TOOL]);

    // 一个都不放行 → 一个都不产出
    expect(plugin.instantiate(fakeScope, filteredWith([]))).toEqual([]);
  });

  it("插件 id 固定（装配处按它查）", () => {
    expect(new PeerSessionsScopePlugin().id).toBe("peer-sessions");
    expect(PeerSessionsScopePlugin.ID).toBe("peer-sessions");
  });
});

describe("create_session：受理即回，参数原样交给端口", () => {
  it("返回 { sessionId, label }，并把调用方（ctx.agent）交给端口", async () => {
    const { port, creates } = recordingPort({});
    const [createTool] = createPeerSessionTools(port);

    const result = await call(createTool, {
      prompt: "把登录页的测试补齐",
      agentId: "reviewer",
      modelId: "m-1",
      label: "补测试",
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual({
      caller: fakeAgent,
      prompt: "把登录页的测试补齐",
      agentId: "reviewer",
      modelId: "m-1",
      label: "补测试",
    });
    expect(result).toMatchObject({ sessionId: "session-1", label: "会话 1" });
  });

  it("可选参数空串 / 非字符串当作没给（不往端口里塞假值）", async () => {
    const { port, creates } = recordingPort({});
    const [createTool] = createPeerSessionTools(port);

    await call(createTool, { prompt: "跑一下", agentId: "", modelId: 42, label: undefined });
    expect(creates[0]).toEqual({ caller: fakeAgent, prompt: "跑一下" });
  });

  it("description 与返回文案都写着那两句话（别轮询 / 靠 label）", async () => {
    const { port } = recordingPort({});
    const [createTool] = createPeerSessionTools(port);

    const description = createTool.function.description ?? "";
    const lower = description.toLowerCase();
    expect(lower).toContain("pushed back to me automatically");
    expect(lower).toContain("do not poll"); // ① 会自动推回来，别反复轮询
    expect(description).toContain("`label`"); // ② 记不住 sessionId 就靠 label

    const result = (await call(createTool, { prompt: "x" })) as { hint: string };
    expect(result.hint.toLowerCase()).toContain("pushed back to me automatically");
    expect(result.hint).toContain("label");
  });

  it("结构化拒绝原样交回（模型能按字段分支，不靠读文本）", async () => {
    const depth = recordingPort({
      created: { ok: false, reason: "depth_exceeded", hint: "one level only" },
    });
    const [createTool] = createPeerSessionTools(depth.port);
    expect(await call(createTool, { prompt: "x" })).toEqual({
      rejected: "depth_exceeded",
      hint: "one level only",
    });

    const model = recordingPort({
      created: { ok: false, reason: "model_unresolved", hint: "pass modelId" },
    });
    const [otherTool] = createPeerSessionTools(model.port);
    expect(await call(otherTool, { prompt: "x" })).toEqual({
      rejected: "model_unresolved",
      hint: "pass modelId",
    });
  });

  it("并发满了也是结构化拒绝（too_many_peers，宿主不给 hint 时用插件自带的）", async () => {
    const h = recordingPort({ created: { ok: false, reason: "too_many_peers" } });
    const [createTool] = createPeerSessionTools(h.port);
    const result = (await call(createTool, { prompt: "x" })) as { rejected: string; hint: string };
    expect(result.rejected).toBe("too_many_peers");
    expect(result.hint).toContain("maximum number of peer sessions running");
  });

  it("宿主没给 hint 时用插件自带的那一句（模型总能拿到下一步怎么做）", async () => {
    const { port } = recordingPort({ created: { ok: false, reason: "depth_exceeded" } });
    const [createTool] = createPeerSessionTools(port);
    const result = (await call(createTool, { prompt: "x" })) as { rejected: string; hint: string };
    expect(result.rejected).toBe("depth_exceeded");
    expect(result.hint).toContain("one level only");
  });
});

describe("send_to_session：接着说话，不等结果", () => {
  it("参数原样交给端口（caller 是 ctx.agent），回执带上 state 与 hint", async () => {
    const { port, sends } = recordingPort({ sent: { ok: true, state: "running" } });
    const [, , sendTool] = createPeerSessionTools(port);

    const result = await call(sendTool, { sessionId: "session-1", content: "再补两个用例" });

    expect(sends).toEqual([{ caller: fakeAgent, sessionId: "session-1", content: "再补两个用例" }]);
    expect(result).toMatchObject({ accepted: true, state: "running" });
    expect(typeof (result as { hint: unknown }).hint).toBe("string");
  });

  it("三种 state 各说一句现场事实，但都不让模型等结果（外加自动推回 / 靠 label）", async () => {
    for (const state of ["running", "idle", "settling"] as const) {
      const { port } = recordingPort({ sent: { ok: true, state } });
      const [, , sendTool] = createPeerSessionTools(port);
      const result = (await call(sendTool, { sessionId: "s", content: "x" })) as {
        state: string;
        hint: string;
      };
      expect(result.state).toBe(state);
      // ② 不等结果 + 跑完自动推回来
      expect(result.hint).toContain("Do not wait for a result");
      expect(result.hint.toLowerCase()).toContain("pushed back to me automatically");
      // ③ 靠 label 认会话
      expect(result.hint).toContain("`label`");
    }

    // ① 现场事实各不同：在跑 → 排在它这一轮末尾；空闲 → 把它叫起来；结算中 → 等这一段收官
    const running = recordingPort({ sent: { ok: true, state: "running" } });
    const idle = recordingPort({ sent: { ok: true, state: "idle" } });
    const settling = recordingPort({ sent: { ok: true, state: "settling" } });
    const hintOf = async (p: PeerSessionPort): Promise<string> => {
      const [, , tool] = createPeerSessionTools(p);
      return ((await call(tool, { sessionId: "s", content: "x" })) as { hint: string }).hint;
    };
    expect(await hintOf(running.port)).toContain("end of its current turn");
    expect(await hintOf(idle.port)).toContain("wakes it up");
    expect(await hintOf(settling.port)).toContain("held and delivered as soon as");
  });

  it("两种拒绝都是结构化返回（不抛错）：gone / not_allowed 各带一句下一步", async () => {
    const gone = recordingPort({ sent: { ok: false, reason: "gone" } });
    const [, , goneTool] = createPeerSessionTools(gone.port);
    const goneResult = (await call(goneTool, { sessionId: "missing", content: "x" })) as {
      rejected: string;
      hint: string;
    };
    expect(goneResult.rejected).toBe("gone");
    expect(goneResult.hint).toContain("Nothing was sent");

    const denied = recordingPort({ sent: { ok: false, reason: "not_allowed" } });
    const [, , deniedTool] = createPeerSessionTools(denied.port);
    const deniedResult = (await call(deniedTool, { sessionId: "sibling", content: "x" })) as {
      rejected: string;
      hint: string;
    };
    expect(deniedResult.rejected).toBe("not_allowed");
    expect(deniedResult.hint).toContain("Nothing was sent");
  });

  it("description 同样写着三句（排在哪 / 不等结果 / 靠 label），参数不合法时不往端口里塞假值", async () => {
    const { port, sends } = recordingPort({});
    const [, , sendTool] = createPeerSessionTools(port);

    const description = sendTool.function.description ?? "";
    expect(description).toContain("end of its current turn"); // ① 在跑 → 排在末尾
    expect(description).toContain("wakes it up"); // ① 空闲 → 叫起来
    expect(description).toContain("Do not wait for a result"); // ② 不要等结果
    expect(description.toLowerCase()).toContain("pushed back to me automatically"); // ② 自动推回
    expect(description).toContain("`label`"); // ③ 靠 label 认会话

    await call(sendTool, { sessionId: 42, content: 7 });
    expect(sends[0]).toEqual({ caller: fakeAgent, sessionId: "", content: "7" });
  });
});

describe("read_session_status：只给状态与摘要", () => {
  it("state / label / startedAt / lastMessage 原样出现，并带上 hint", async () => {
    const { port, statuses } = recordingPort({
      status: {
        state: "idle",
        label: "会话 1",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastMessage: "跑完了，改了三个文件",
      },
    });
    const [, statusTool] = createPeerSessionTools(port);

    const result = await call(statusTool, { sessionId: "session-1" });
    expect(statuses).toEqual([{ caller: fakeAgent, sessionId: "session-1" }]);
    expect(result).toMatchObject({
      state: "idle",
      label: "会话 1",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastMessage: "跑完了，改了三个文件",
    });
    expect((result as { hint: string }).hint.toLowerCase()).toContain("do not poll it");
  });

  it("拿不到的字段就不出现（gone 只有 state 与 hint）", async () => {
    const { port } = recordingPort({ status: { state: "gone" } });
    const [, statusTool] = createPeerSessionTools(port);

    const result = (await call(statusTool, { sessionId: "missing" })) as Record<string, unknown>;
    expect(result.state).toBe("gone");
    expect("label" in result).toBe(false);
    expect("startedAt" in result).toBe(false);
    expect("lastMessage" in result).toBe(false);
    expect(typeof result.hint).toBe("string");
  });

  it("description 里也说清「不是取结果的地方」与「靠 label 认会话」", () => {
    const { port } = recordingPort({});
    const [, statusTool] = createPeerSessionTools(port);

    const description = statusTool.function.description ?? "";
    expect(description).toContain("never the full conversation");
    expect(description.toLowerCase()).toContain("pushed back to me automatically");
    expect(description).toContain("`label`");
  });
});
