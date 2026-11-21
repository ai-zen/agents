/**
 * 会话上可改的那六样：名字、置顶、自动交接开关、两条阈值、模型、思考档位。
 *
 * 这一份验的是**客户端调得动、落库落成了什么**：前四样直接写行（执行体根本不读它们，改完当场
 * 生效），后两样写行之外还要在活着的执行体上就地刷新（`SdkAgent.useModel`）。
 *
 * 每一条的错法都是「不报错也不工作」：名字改完 `nameIsAuto` 还是真（下一次自动起名会把它盖掉）、
 * 换模型没清档位（把一家的 thinking 参数带到另一家，端点直接 400）、阈值只有一个数进了库
 * （另一个还是旧值）、换模型只改了库没改执行体（界面写着 A、请求发给 B）。
 */

import type {
  AgentRuntime,
  AgentDefinition,
  AppConfig,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";
import { describe, expect, it, vi } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { HostError } from "../../infra/errors.js";
import type { HostApiDeps } from "../api/deps.js";
import { sessionRouter } from "../api/session.js";
import type { HostContext } from "../api/trpc.js";
import { createTrpc } from "../api/trpc.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import type { Connection } from "../connection/registry.js";
import { workspaceTable } from "../workspace/table.js";
import { messageTable } from "./messages.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { Session } from "./types.js";

/**
 * 配置用一个常量对象给：这两条路要读的只有模型表与档位表，落到磁盘上反而让用例去追究
 * 「配置文件长什么样」，而那是 SDK 那一层的事。
 *
 * 两个模型分工明确：`model-plain` 没挂档位表（非 `null` 的档位一律该拒），`model-thinking`
 * 挂着 `reasoning` 那张（`low` / `high` 两档）。
 */
const CONFIG = {
  defaultModel: "model-plain",
  models: [
    {
      id: "model-plain",
      name: "普通",
      endpointId: "endpoint-1",
      tokenThresholds: { handoff: 100, guard: 150 },
      defaultParams: { temperature: 0.3 },
    },
    {
      id: "model-thinking",
      name: "会想",
      endpointId: "endpoint-1",
      tokenThresholds: { handoff: 200, guard: 300 },
      reasoningPreset: "reasoning",
    },
  ],
  endpoints: [
    { id: "endpoint-1", name: "端点一", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test" },
  ],
} as unknown as AppConfig;

const PRESETS = {
  reasoning: { levels: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } } },
} as unknown as ReasoningPresets;

/** 助手定义：`modelParams` 是档位补丁叠在上面的那一层，换模型时它就应当是全部 */
const DEFINITION: AgentDefinition = {
  id: "agent-1",
  name: "助手一",
  messages: [],
  modelId: "model-plain",
  modelParams: { temperature: 0.5 },
  createdAt: "",
  updatedAt: "",
};

/**
 * 一个真库加这一条路上的几个域。`runtime` 与 `definitions` 给替身：这些用例问的是「行上落了
 * 什么、执行体上被要求换成了什么」，造一个真的运行时只会让人以为它也在被验。
 *
 * `deps` 上缺的那些（项目、排队区、素材、交接、通知……）这六条 procedure 一处都不碰，所以
 * 直接转成 `HostApiDeps`：补齐它们得先编出六七个与本题无关的替身。
 */
function newHost() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const sessions = new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t,
  });
  const messages = messageTable(db);

  /** 活着的执行体：这两条路只碰 `useModel` 一格 */
  const agents = new Map<string, { useModel: ReturnType<typeof vi.fn> }>();
  const runtime = {
    get: (sessionId: string) => agents.get(sessionId),
  } as unknown as AgentRuntime;

  const deps = {
    sessions,
    messages,
    runtime,
    events: createBus<HostEvent>(),
    t,
    config: { read: () => CONFIG, presets: async () => PRESETS } as unknown as GeneralConfig,
    definitions: { get: async () => DEFINITION } as unknown as AgentDefinitionService,
  } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({ session: sessionRouter(deps, api) });
  const caller = router.createCaller({ connection: {} as Connection });

  return { sessions, messages, agents, caller };
}

type Host = ReturnType<typeof newHost>;

function newSession(host: Host): Session {
  return host.sessions.create({
    workspaceId: "ws-1",
    name: "1712345678000",
    // 自动起的名字：这一格是本文件第一条的那个判据
    nameIsAuto: true,
    agentId: "agent-1",
    // 会话行上写出模型：三级解析的第一级就是它
    modelId: "model-plain",
    autoHandoff: false,
    lineage: null,
  });
}

/** 这一段现在活着一个执行体：`useModel` 的调用记下来，供「就地刷新」那几条断言 */
function wake(host: Host, sessionId: string) {
  const agent = { useModel: vi.fn() };
  host.agents.set(sessionId, agent);
  return agent;
}

/**
 * 这一次调用抛出的是哪个 `HostError`。tRPC 把 resolver 抛出的原始错误放在 `cause` 里
 * （出网那一层换成 tRPC 自己的码），所以码要从 `cause` 上读。
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

describe("会话上可改的那几样", () => {
  it("改名：写进库里，且 `nameIsAuto` 变成假 —— 从此不再自动改名", async () => {
    const host = newHost();
    const session = newSession(host);

    const { session: renamed } = await host.caller.session.rename({
      sessionId: session.id,
      name: "自己起的名字",
    });

    expect(renamed).toEqual({
      ...session,
      name: "自己起的名字",
      nameIsAuto: false,
      updatedAt: expect.any(Number),
    });
    // 落库的那一份与返回的那一份是同一个事实：自动起名只碰 `nameIsAuto` 还是真的行
    expect(host.sessions.get(session.id)).toEqual(renamed);
  });

  it("置顶与自动交接开关：各写那一格，其余不动", async () => {
    const host = newHost();
    const session = newSession(host);

    const { session: pinned } = await host.caller.session.pin({
      sessionId: session.id,
      pinned: true,
    });
    expect(pinned.pinned).toBe(true);
    expect(host.sessions.get(session.id)?.pinned).toBe(true);

    const { session: switched } = await host.caller.session.setAutoHandoff({
      sessionId: session.id,
      autoHandoff: true,
    });
    expect(switched.autoHandoff).toBe(true);
    expect(host.sessions.get(session.id)?.autoHandoff).toBe(true);
    // 置顶那一格不被后一次调用碰掉
    expect(host.sessions.get(session.id)?.pinned).toBe(true);
  });

  it("两条阈值：两个数都落库，`null` 也写得进去（跟随模型配置）", async () => {
    const host = newHost();
    const session = newSession(host);

    const { session: set } = await host.caller.session.setThresholds({
      sessionId: session.id,
      handoffThreshold: 120_000,
      guardThreshold: 180_000,
    });
    expect(set.handoffThreshold).toBe(120_000);
    expect(set.guardThreshold).toBe(180_000);
    expect(host.sessions.get(session.id)?.handoffThreshold).toBe(120_000);
    expect(host.sessions.get(session.id)?.guardThreshold).toBe(180_000);

    // 硬线不必大于软线：需求给的是建议，不是约束。这里把软线设到硬线之上，照样写得进去
    const { session: loosened } = await host.caller.session.setThresholds({
      sessionId: session.id,
      handoffThreshold: 200_000,
      guardThreshold: null,
    });
    expect(loosened.handoffThreshold).toBe(200_000);
    expect(loosened.guardThreshold).toBeNull();
    expect(host.sessions.get(session.id)?.guardThreshold).toBeNull();
  });

  it("换模型：清掉档位、就地刷新执行体，参数就是助手定义那一份", async () => {
    const host = newHost();
    const session = newSession(host);
    // 上一档思考：换模型必须把它清掉
    host.sessions.update(session.id, { thinkingLevel: "high" });
    const agent = wake(host, session.id);

    const { session: switched } = await host.caller.session.setModel({
      sessionId: session.id,
      modelId: "model-thinking",
    });

    expect(switched.modelId).toBe("model-thinking");
    // 档位是模型的参数：不清空就是把一家的 thinking 参数带给另一家
    expect(switched.thinkingLevel).toBeNull();
    expect(host.sessions.get(session.id)?.thinkingLevel).toBeNull();
    // 就地刷新：不杀执行体，只换它手上的模型与参数；档位刚清空，所以这一刻的参数整份是定义那份
    expect(agent.useModel).toHaveBeenCalledWith("model-thinking", DEFINITION.modelParams);
  });

  it("换模型：配置里没有这个模型就是 `config_invalid`，文案带 id，行一个字不动", async () => {
    const host = newHost();
    const session = newSession(host);
    const agent = wake(host, session.id);

    const error = await hostErrorOf(
      host.caller.session.setModel({ sessionId: session.id, modelId: "没有这个模型" }),
    );

    expect(error.code).toBe("config_invalid");
    expect(error.message).toContain("没有这个模型");
    expect(host.sessions.get(session.id)?.modelId).toBe("model-plain");
    expect(agent.useModel).not.toHaveBeenCalled();
  });

  it("换思考档位：档位表认它才写得进去，写完就地刷新（模型 + 档位补丁）", async () => {
    const host = newHost();
    const session = newSession(host);
    // 会话级模型换成挂了档位表的那个
    host.sessions.setModel(session.id, "model-thinking");
    const agent = wake(host, session.id);

    const { session: leveled } = await host.caller.session.setThinkingLevel({
      sessionId: session.id,
      level: "high",
    });

    expect(leveled.thinkingLevel).toBe("high");
    expect(host.sessions.get(session.id)?.thinkingLevel).toBe("high");
    // 生效模型是会话行上那个（不是定义上那个），参数是定义那份叠上档位补丁
    expect(agent.useModel).toHaveBeenCalledWith("model-thinking", {
      temperature: 0.5,
      reasoning_effort: "high",
    });
  });

  it("换思考档位：表里没有这一档、或模型根本没挂档位表，都是 `invalid_params`", async () => {
    const host = newHost();
    const thinking = newSession(host);
    host.sessions.setModel(thinking.id, "model-thinking");

    const unknown = await hostErrorOf(
      host.caller.session.setThinkingLevel({ sessionId: thinking.id, level: "max" }),
    );
    expect(unknown.code).toBe("invalid_params");
    // 文案说清可选档位：客户端能照着它把选择器画出来
    expect(unknown.message).toContain("low / high");
    expect(host.sessions.get(thinking.id)?.thinkingLevel).toBeNull();

    // `model-plain` 没挂档位表：只接受 `null`（跟随助手定义）
    const plain = newSession(host);
    const noPreset = await hostErrorOf(
      host.caller.session.setThinkingLevel({ sessionId: plain.id, level: "high" }),
    );
    expect(noPreset.code).toBe("invalid_params");
    expect(noPreset.message).toContain("model-plain");

    const { session: followed } = await host.caller.session.setThinkingLevel({
      sessionId: plain.id,
      level: null,
    });
    expect(followed.thinkingLevel).toBeNull();
  });

  it("行不存在时这六条都是 `not_found`", async () => {
    const host = newHost();

    const renamed = await hostErrorOf(
      host.caller.session.rename({ sessionId: "没有这一段", name: "名字" }),
    );
    expect(renamed.code).toBe("not_found");

    const leveled = await hostErrorOf(
      host.caller.session.setThinkingLevel({ sessionId: "没有这一段", level: null }),
    );
    expect(leveled.code).toBe("not_found");
  });
});
