/**
 * `session.create`：建行只写一行。
 *
 * 这一条 procedure 做且只做一件事：解析模型、写一行会话。不唤醒 Agent、不投递、不推任何
 * 「这一段活了」的事实 —— 起 Agent 是 `runtime.agent.wake`，投话是 `runtime.agent.send`，三件事各有一条口。
 * 建出来的这一段与「重启之后所有会话都是死的」是同一种状态：`session.open` 读回来 `live` 是
 * `null`，消息与排队区都是空的。
 *
 * 台架与 `session.transient.test.ts` 同一口径：真内存库、真 `SessionService`、真的 OpenAI 兼容
 * 端点（`@ai-zen/agents-testing`）—— 只有 `runtime` 是替身。替身只做一件事：把「有没有人来
 * 唤醒我」记下来，`wake` 真被走到就当场红 —— 建行顺带叫醒 Agent 正是这一刀要拆掉的那一件事。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { Message } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentRuntime, AppConfig } from "@ai-zen/agents-sdk";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { inboxTable } from "../agent/inbox.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { WorkspaceService } from "../workspace/service.js";
import { agentRouter } from "./agent.js";
import type { HostApiDeps } from "./deps.js";
import { sessionRouter } from "./session.js";
import { createTrpc } from "./trpc.js";

const WORKSPACE_ID = "ws-1";
const AGENT_ID = "agent-1";
const MODEL_ID = "model-1";

const DEFINITION: AgentDefinition = {
  id: AGENT_ID,
  name: "AgentDefinition一",
  modelId: MODEL_ID,
  messages: [Message.System("你是一个用例里的AgentDefinition。")],
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let dir: string;
let fake: FakeLlm;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-create-"));
  fake = await startFakeLlm({ reply: "这句话不该被要回来" });
});

afterEach(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

/** 配置里那个模型指向假端点：真有人去要模型的话，`fake.requests` 会多一条 */
function configFor(defaultModel: string | null): AppConfig {
  return {
    defaultModel,
    models: [
      {
        id: MODEL_ID,
        name: "模型一",
        endpointId: "ep-1",
        tokenThresholds: { handoff: 100_000, guard: 200_000 },
      },
    ],
    endpoints: [{ id: "ep-1", name: "端点一", baseUrl: fake.baseUrl, apiKey: "test" }],
  } as unknown as AppConfig;
}

/**
 * 这一条路上的几个域：库与服务都是真的，`runtime` 是替身。
 *
 * `wake` 调用即炸：建行不该造 Agent，真被走到就要当场红，而不是安静地多出一段「活了」的会话。
 */
function newHost(options: { defaultModel?: string | null; definition?: AgentDefinition } = {}) {
  const db = openDatabase(":memory:");
  // 项目行先摆好：会话行的外键指向它，而这条路上的断言要的是「会话表一行不多不少」
  workspaceTable(db).put({
    id: WORKSPACE_ID,
    name: "用例项目",
    cwd: "/work/proj",
    createdAt: Date.now(),
  });
  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });
  const config = configFor(options.defaultModel === undefined ? MODEL_ID : options.defaultModel);
  const definition = options.definition ?? DEFINITION;

  /** 被唤醒过几次：这条路上它只能是 0 */
  const wakes: string[] = [];

  const runtime = {
    get: () => undefined,
    wake: (sessionId: string) => {
      wakes.push(sessionId);
      throw new Error("session.create 不该唤醒Agent：那一条是 runtime.agent.wake");
    },
  } as unknown as AgentRuntime;

  const deps = {
    sessions,
    workspaces,
    messages,
    inbox,
    runtime,
    events,
    t,
    config: { read: () => config, presets: async () => ({}) } as unknown as GeneralConfig,
    definitions: { get: async () => definition } as unknown as AgentDefinitionService,
  } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({
    session: sessionRouter(deps, api),
    runtime: api.router({ agent: agentRouter(deps, api) }),
  });

  return { db, caller: router.createCaller({}), wakes };
}

type Host = ReturnType<typeof newHost>;

/** 这张表现在有几行 */
function countRows(db: DatabaseSync, table: "messages" | "inbox" | "sessions"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

describe("session.create：只写一行", () => {
  it("行在库里、模型已解析、名字是创建时刻那一串", async () => {
    const host = newHost();

    const { session } = await host.caller.session.create({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
    });

    expect(session).toMatchObject({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      modelId: MODEL_ID,
      nameIsAuto: true,
      pinned: false,
      thinkingLevel: null,
      autoHandoff: false,
      lineage: null,
    });
    // 名字是那一刻的时刻串（自动命名只碰「只有一条用户消息」的行，空会话不会触发）
    expect(session.name).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 行真的落进了库：这一域的读口读得回来，别的行没有跟着冒出来
    const listed = await host.caller.session.list({ workspaceId: WORKSPACE_ID });
    expect(listed.map((row) => row.id)).toEqual([session.id]);
    expect(countRows(host.db, "sessions")).toBe(1);
  });

  it("没有Agent：open 回来 live 为 null，消息与排队区都是空的", async () => {
    const host = newHost();

    const { session } = await host.caller.session.create({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
    });
    const opened = await host.caller.session.open({ sessionId: session.id });

    // 与「重启之后所有会话都是死的」同一种状态
    expect(opened.live).toBeNull();
    expect(opened.messages).toEqual([]);
    expect(opened.inbox).toEqual([]);
    // 一次唤醒都没有发生
    expect(host.wakes).toEqual([]);
  });

  it("一个字都没问过模型：建行不产生任何请求", async () => {
    const host = newHost();

    await host.caller.session.create({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID });

    // 假端点那一侧一个请求都没收到：没有人拿着空正文去要一句回答
    expect(fake.requests).toEqual([]);
    // 库里也只有那一段会话：没有消息行、没有排队行
    expect(countRows(host.db, "messages")).toBe(0);
    expect(countRows(host.db, "inbox")).toBe(0);
  });

  it("模型解析不出：当场失败，不落半条行", async () => {
    // 定义上没绑模型，配置里也没有全局兜底：这条会话此刻指不到任何模型
    const host = newHost({ defaultModel: null, definition: { ...DEFINITION, modelId: undefined } });

    await expect(
      host.caller.session.create({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ cause: { code: "config_invalid" } });

    expect(countRows(host.db, "sessions")).toBe(0);
    await expect(host.caller.session.list({ workspaceId: WORKSPACE_ID })).resolves.toEqual([]);
    expect(fake.requests).toEqual([]);
  });
});

describe("runtime.agent.send：只投递", () => {
  it("缺 sessionId 在边界上被拒（zod），一次唤醒都没有发生", async () => {
    const host = newHost();

    // 少一格必填入参：tRPC 的入参校验先于 resolver 跑，所以下面那句断言的就是「边界上被拒」
    await expect(
      host.caller.runtime.agent.send({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        content: "这句话没有说给哪一段",
        messageId: "m-1",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // 拒在入口，所以库里一行都没有，也没人去唤醒 Agent
    expect(countRows(host.db, "sessions")).toBe(0);
    expect(host.wakes).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("给一段没有Agent的会话投递：not_found，那一句一个字都没进去", async () => {
    const host = newHost();
    const { session } = await host.caller.session.create({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
    });

    await expect(
      host.caller.runtime.agent.send({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        sessionId: session.id,
        content: "这一句投不进去",
        messageId: "m-1",
      }),
    ).rejects.toMatchObject({ cause: { code: "not_found" } });

    // 投递不建行、不复活：唤醒一次都没发生，库里也没有多出消息行与排队行
    expect(host.wakes).toEqual([]);
    expect(countRows(host.db, "messages")).toBe(0);
    expect(countRows(host.db, "inbox")).toBe(0);
    const opened = await host.caller.session.open({ sessionId: session.id });
    expect(opened.live).toBeNull();
    expect(opened.inbox).toEqual([]);
  });

  it("会话行不存在：not_found（与 open 同一句词）", async () => {
    const host = newHost();

    await expect(
      host.caller.runtime.agent.send({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        sessionId: "没有这一段",
        content: "这一句投不进去",
        messageId: "m-1",
      }),
    ).rejects.toMatchObject({
      cause: { code: "not_found", details: { entity: "session" } },
    });
  });
});
