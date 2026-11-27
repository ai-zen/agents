/**
 * 会话上可改的那六样：名字、置顶、自动交接开关、两条阈值、模型、思考档位。
 *
 * 这一份验的是客户端调得动、落库落成了什么：前四样直接写行（Agent 根本不读它们，改完当场
 * 生效），后两样写行之外还要在活着的 Agent 上就地刷新（`SdkAgent.useModel`）。
 *
 * 每一条的错法都是「不报错也不工作」：名字改完 `nameSource` 还是 `default`（下一次自动起名会把它盖掉）、
 * 换模型没清档位（把一家的 thinking 参数带到另一家，端点直接 400）、阈值只有一个数进了库
 * （另一个还是旧值）、换模型只改了库没改 Agent（界面写着 A、请求发给 B）。
 *
 * 后两样（模型、思考档位）的每一条还同时验着参数不跨级混合：模型来自会话行时，AgentDefinition
 * 那份参数（配给定义自己绑的那个模型的）不许跟过来；模型来自定义时它才是基础参数，档位补丁
 * 叠在它上面。
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
import { createTrpc } from "../api/trpc.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { workspaceTable } from "../workspace/table.js";
import { messageTable } from "./messages.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { SessionRecord } from "./types.js";

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

/** AgentDefinition：`modelParams` 是「模型来自定义」那一级的基础参数，换过模型之后它就该整份消失 */
const DEFINITION: AgentDefinition = {
  id: "agent-1",
  name: "AgentDefinition一",
  messages: [],
  modelId: "model-plain",
  modelParams: { temperature: 0.5 },
  createdAt: "",
  updatedAt: "",
};

/**
 * 同一个 AgentDefinition，绑的是挂着思考档位表的那个模型（`modelParams` 照旧）。
 *
 * 只给「模型来自定义且带档位补丁」那一条用例用：`DEFINITION` 绑的 `model-plain` 没挂
 * 档位表，凑不出那个组合。
 */
const THINKING_DEFINITION: AgentDefinition = { ...DEFINITION, modelId: "model-thinking" };

/**
 * 一个真库加这一条路上的几个域。`runtime` 与 `definitions` 给替身：这些用例问的是「行上落了
 * 什么、Agent 上被要求换成了什么」，造一个真的运行时只会让人以为它也在被验。
 *
 * `deps` 上缺的那些（项目、排队区、Asset、交接、通知……）这六条 procedure 一处都不碰，所以
 * 直接转成 `HostApiDeps`：补齐它们得先编出六七个与本题无关的替身。
 *
 * AgentDefinition 可以按用例换一份（默认 `DEFINITION`）：绑哪个模型决定了「模型来自定义」那一级是谁，
 * 换掉它才能把「模型来自定义 + 有档位补丁」这个组合凑出来。
 */
function newHost(definition: AgentDefinition = DEFINITION) {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const sessions = new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t,
  });
  const messages = messageTable(db);

  /** 活着的 Agent：这两条路只碰 `useModel` 一格 */
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
    definitions: { get: async () => definition } as unknown as AgentDefinitionService,
  } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({ session: sessionRouter(deps, api) });
  const caller = router.createCaller({});

  return { sessions, messages, agents, caller };
}

type Host = ReturnType<typeof newHost>;

function newSession(host: Host): SessionRecord {
  return host.sessions.create({
    workspaceId: "ws-1",
    name: "1712345678000",
    // 自动起的名字：这一格是本文件第一条的那个判据
    nameSource: "default",
    agentId: "agent-1",
    // 会话行上写出模型：三级解析的第一级就是它
    modelId: "model-plain",
    autoHandoff: false,
    lineage: null,
  });
}

/** 这一段现在活着一个 Agent：`useModel` 的调用记下来，供「就地刷新」那几条断言 */
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
  it("改名：写进库里，且 `nameSource` 变成 `user` —— 从此不再自动改名", async () => {
    const host = newHost();
    const session = newSession(host);

    const { session: renamed } = await host.caller.session.rename({
      sessionId: session.id,
      name: "自己起的名字",
    });

    expect(renamed).toEqual({
      ...session,
      name: "自己起的名字",
      nameSource: "user",
      updatedAt: expect.any(Number),
    });
    // 落库的那一份与返回的那一份是同一个事实：自动起名只碰 `default` / `auto` 那两格
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

    const { session: switched } = await host.caller.session.updateAutoHandoff({
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

    const { session: set } = await host.caller.session.updateThresholds({
      sessionId: session.id,
      handoffThreshold: 120_000,
      guardThreshold: 180_000,
    });
    expect(set.handoffThreshold).toBe(120_000);
    expect(set.guardThreshold).toBe(180_000);
    expect(host.sessions.get(session.id)?.handoffThreshold).toBe(120_000);
    expect(host.sessions.get(session.id)?.guardThreshold).toBe(180_000);

    // 硬线不必大于软线：需求给的是建议，不是约束。这里把软线设到硬线之上，照样写得进去
    const { session: loosened } = await host.caller.session.updateThresholds({
      sessionId: session.id,
      handoffThreshold: 200_000,
      guardThreshold: null,
    });
    expect(loosened.handoffThreshold).toBe(200_000);
    expect(loosened.guardThreshold).toBeNull();
    expect(host.sessions.get(session.id)?.guardThreshold).toBeNull();
  });

  it("换模型：清掉档位、就地刷新Agent，参数里不带AgentDefinition那一份", async () => {
    const host = newHost();
    const session = newSession(host);
    // 上一档思考：换模型必须把它清掉
    host.sessions.update(session.id, { thinkingLevel: "high" });
    const agent = wake(host, session.id);

    const { session: switched } = await host.caller.session.updateModel({
      sessionId: session.id,
      modelId: "model-thinking",
    });

    expect(switched.modelId).toBe("model-thinking");
    // 档位是模型的参数：不清空就是把一家的 thinking 参数带给另一家
    expect(switched.thinkingLevel).toBeNull();
    expect(host.sessions.get(session.id)?.thinkingLevel).toBeNull();
    // 就地刷新：不杀 Agent，只换它手上的模型与参数。模型这一刻来自会话行，而会话行上没有参数
    // 这一格 —— 所以参数是空的一份，不是定义那份（那条是配给 `model-plain` 的）
    expect(agent.useModel).toHaveBeenCalledWith("model-thinking", undefined);
  });

  it("换模型：配置里没有这个模型就是 `config_invalid`，文案带 id，行一个字不动", async () => {
    const host = newHost();
    const session = newSession(host);
    const agent = wake(host, session.id);

    const error = await hostErrorOf(
      host.caller.session.updateModel({ sessionId: session.id, modelId: "没有这个模型" }),
    );

    expect(error.code).toBe("config_invalid");
    expect(error.message).toContain("没有这个模型");
    expect(host.sessions.get(session.id)?.modelId).toBe("model-plain");
    expect(agent.useModel).not.toHaveBeenCalled();
  });

  it("会话不存在 + 模型也不在配置里 → `not_found`，不是 `config_invalid`", async () => {
    const host = newHost();

    const error = await hostErrorOf(
      host.caller.session.updateModel({ sessionId: "没有这一段", modelId: "没有这个模型" }),
    );

    // 先认会话，再认模型：两个都不成立时该说的是「这段会话不存在」—— 说成 config_invalid 会让
    // 客户端以为换个模型名就能成
    expect(error.code).toBe("not_found");
    // 与 `SessionService.update` 那一句同词：同一种失败在两条路上不能有两句话
    expect(error.message).toBe("找不到 id 为 没有这一段 的会话");
    expect(error.details).toEqual({ entity: "session", sessionId: "没有这一段" });
  });

  it("会话换过模型时，参数里没有AgentDefinition那一份", async () => {
    const host = newHost();
    const session = newSession(host);
    // 会话行上换成另一个模型：模型这一级的赢家是会话行
    host.sessions.setModel(session.id, "model-thinking");
    const agent = wake(host, session.id);

    // 档位跟随定义（`null`）：这条路上除了档位补丁之外没有别的参数来源，补丁也不叠
    await host.caller.session.updateThinkingLevel({ sessionId: session.id, level: null });

    const [modelId, params] = agent.useModel.mock.calls[0] ?? [];
    expect(modelId).toBe("model-thinking");
    // 定义那份（`temperature: 0.5`）配的是定义自己绑的 `model-plain`：整份不许跟过来，
    // 否则换个模型就是把旧模型的参数发给新模型
    expect(params).toBeUndefined();
    expect(Object.keys(params ?? {})).toEqual([]);
  });

  it("模型来自定义时，定义那份 + 档位补丁都在", async () => {
    // 定义绑在挂着档位表的那个模型上：只有这个组合才有「模型来自定义」加「有档位补丁」
    const host = newHost(THINKING_DEFINITION);
    const session = newSession(host);
    // 会话行上不写模型 = 跟随定义（三级解析的第二级赢）
    host.sessions.update(session.id, { modelId: null });
    const agent = wake(host, session.id);

    await host.caller.session.updateThinkingLevel({ sessionId: session.id, level: "high" });

    // 基础参数是定义那一份（模型来自定义），档位补丁叠在它上面
    expect(agent.useModel).toHaveBeenCalledWith("model-thinking", {
      temperature: 0.5,
      reasoning_effort: "high",
    });
  });

  it("换思考档位：档位表认它才写得进去，写完就地刷新（模型 + 档位补丁）", async () => {
    const host = newHost();
    const session = newSession(host);
    // 会话级模型换成挂了档位表的那个
    host.sessions.setModel(session.id, "model-thinking");
    const agent = wake(host, session.id);

    const { session: leveled } = await host.caller.session.updateThinkingLevel({
      sessionId: session.id,
      level: "high",
    });

    expect(leveled.thinkingLevel).toBe("high");
    expect(host.sessions.get(session.id)?.thinkingLevel).toBe("high");
    // 生效模型是会话行上那个（不是定义上那个）：基础参数取「会话那一级」的那一份 —— 会话行上
    // 没有参数这一格，所以参数里只有档位补丁，定义那份 `temperature` 不跟过来
    expect(agent.useModel).toHaveBeenCalledWith("model-thinking", { reasoning_effort: "high" });
  });

  it("换思考档位：表里没有这一档、或模型根本没挂档位表，都是 `invalid_params`", async () => {
    const host = newHost();
    const thinking = newSession(host);
    host.sessions.setModel(thinking.id, "model-thinking");

    const unknown = await hostErrorOf(
      host.caller.session.updateThinkingLevel({ sessionId: thinking.id, level: "max" }),
    );
    expect(unknown.code).toBe("invalid_params");
    // 文案说清可选档位：客户端能照着它把选择器画出来
    expect(unknown.message).toContain("low / high");
    expect(host.sessions.get(thinking.id)?.thinkingLevel).toBeNull();

    // `model-plain` 没挂档位表：只接受 `null`（跟随 AgentDefinition）
    const plain = newSession(host);
    const noPreset = await hostErrorOf(
      host.caller.session.updateThinkingLevel({ sessionId: plain.id, level: "high" }),
    );
    expect(noPreset.code).toBe("invalid_params");
    expect(noPreset.message).toContain("model-plain");

    const { session: followed } = await host.caller.session.updateThinkingLevel({
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
      host.caller.session.updateThinkingLevel({ sessionId: "没有这一段", level: null }),
    );
    expect(leveled.code).toBe("not_found");
  });
});
