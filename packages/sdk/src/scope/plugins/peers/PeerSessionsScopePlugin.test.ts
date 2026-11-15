/**
 * 平级会话插件（SDK 侧）的验收：**不给端口就不产出任何工具**，给了端口就两个工具，
 * 而且两个工具只做三件事 —— 把参数送给端口、把结构化拒绝原样交回模型、把「别轮询 / 靠 label」
 * 这两句话写进 description 与返回文案。
 *
 * 会话怎么建、结果怎么投回、谁能开谁（深度）全在宿主那一侧（`PeerSessionService`），
 * 本文件不重复验那些。
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
} from "./peerSessionTools.js";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
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
function recordingPort(answers: { created?: PeerSessionCreated; status?: PeerSessionStatus }): {
  port: PeerSessionPort;
  creates: PeerSessionCreateInput[];
  statuses: Array<{ caller: Agent; sessionId: string }>;
} {
  const creates: PeerSessionCreateInput[] = [];
  const statuses: Array<{ caller: Agent; sessionId: string }> = [];
  const port: PeerSessionPort = {
    async create(input) {
      creates.push(input);
      return answers.created ?? { ok: true, sessionId: "session-1", label: "会话 1" };
    },
    async status(input) {
      statuses.push(input);
      return answers.status ?? { state: "running" };
    },
  };
  return { port, creates, statuses };
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
  it("不给端口 → candidates 为空、instantiate 空数组（老行为一个字不变）", () => {
    const plugin = new PeerSessionsScopePlugin();
    expect(plugin.candidates()).toEqual({});
    expect(plugin.instantiate(fakeScope, filteredWith([...PEER_SESSION_TOOL_NAMES]))).toEqual([]);
  });

  it("给了端口 → 两个候选名，按权限过滤结果实例化", () => {
    const { port } = recordingPort({});
    const plugin = new PeerSessionsScopePlugin(port);

    expect(plugin.candidates()).toEqual({ tools: [CREATE_SESSION_TOOL, READ_SESSION_STATUS_TOOL] });

    const both = plugin.instantiate(fakeScope, filteredWith([...PEER_SESSION_TOOL_NAMES]));
    expect(both.map((tool) => tool.function.name)).toEqual([
      CREATE_SESSION_TOOL,
      READ_SESSION_STATUS_TOOL,
    ]);

    // `Scope.filter` 只放行一个（权限白名单）→ 就只实例化那一个
    const onlyCreate = plugin.instantiate(fakeScope, filteredWith([CREATE_SESSION_TOOL]));
    expect(onlyCreate.map((tool) => tool.function.name)).toEqual([CREATE_SESSION_TOOL]);

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

  it("宿主没给 hint 时用插件自带的那一句（模型总能拿到下一步怎么做）", async () => {
    const { port } = recordingPort({ created: { ok: false, reason: "depth_exceeded" } });
    const [createTool] = createPeerSessionTools(port);
    const result = (await call(createTool, { prompt: "x" })) as { rejected: string; hint: string };
    expect(result.rejected).toBe("depth_exceeded");
    expect(result.hint).toContain("one level only");
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
