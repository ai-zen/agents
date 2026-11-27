/**
 * 装到 Agent 上的那几颗插件（`materialsFor` 交给运行时的 `plugins`）。
 *
 * 钉住两件事：
 *
 * 1. 硬线真的装上了 —— `ContextGuardPlugin` 与 `SubAgentGuardInstallerPlugin` 一颗都没有
 *    装到 Agent 上时，撞线照样把请求发出去、等端点回错；这件事不会报错，只会让每一次撞线都变成
 *    一次白花的请求。
 * 2. 阈值是取值函数 —— 两条阈值改了不重建 Agent：装配那一刻
 *    算好的数会把用户之后改的数字钉死。这里改一次会话行上的 `guardThreshold`，再从同一颗插件
 *    （以及它给 subagent 装的那一颗）上验一次判定，看的是新值还是旧值。
 *
 * 读新值的办法是触发一次判定（`onInnerLoopStart` / 委派边界上的 `onSubAgentStart`），
 * 不去摸插件内部的字段：字段叫什么、存在第几层是实现细节，而「判定时读的是哪个数」正是要验的
 * 那一件事。护栏「超线就拒」那一套搭法与 `ContextGuardPlugin.test.ts` 同一个：用量只从消息上读。
 */

import { describe, expect, it } from "vitest";

import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import {
  AssetTransportPlugin,
  AutoMigratePlugin,
  McpElicitationPlugin,
  ContextGuardPlugin,
  SubAgentGuardInstallerPlugin,
  type AgentDefinition,
  type AppConfig,
  type WakeMaterials,
} from "@ai-zen/agents-sdk";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { noticeTable } from "../notice/table.js";
import { NoticeService } from "../notice/service.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { NewSession, SessionRecord } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import { WorkspaceService } from "../workspace/service.js";
import { materialsFor } from "./materials.js";
import type { MaterialsDeps } from "./materials.js";
import { inboxTable } from "./inbox.js";
import { messageTable } from "../session/messages.js";
import { QuestionRegistry } from "../question/registry.js";

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameSource: "default",
  autoHandoff: false,
  lineage: null,
};

/** 生效模型：硬线 400。会话行不给 `guardThreshold` 时用的就是它 */
const MODEL = {
  id: "model-1",
  name: "模型一",
  endpointId: "ep-1",
  tokenThresholds: { handoff: 100, guard: 400 },
};

function newHost() {
  /** 配置里那一条模型的可改副本（改它就是「用户在 /config 里改了阈值」） */
  const model = { ...MODEL, tokenThresholds: { ...MODEL.tokenThresholds } };
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  // 宿主的日志口这一条路上只当出口：撞硬线那条通知由 `GuardNoticePlugin` 推
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const notices = new NoticeService({ notices: noticeTable(db), events, log });

  /**
   * 定义与配置：这两条路上只用得到「定义一个模型是谁」「配置里那个模型的两条阈值」。
   *
   * 交接那一格给的是不碰的替身：这条用例问的是插件装没装上、阈值是不是现读的，交接不参与。
   */
  const deps = {
    questions: new QuestionRegistry({ events, t }),
    workspaces: new WorkspaceService({ workspaces: workspaceTable(db), t }),
    definitions: {
      get: async (): Promise<AgentDefinition> => ({
        id: "agent-1",
        name: "AgentDefinition",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    } as unknown as MaterialsDeps["definitions"],
    config: {
      // 每次现读：`model` 是可改的那一份 —— 「改配置里的阈值」这条用例靠它模拟 `config.models.update`
      read: () => ({ defaultModel: "model-1", models: [model] }) as unknown as AppConfig,
    } as unknown as MaterialsDeps["config"],
    messages: messageTable(db),
    inbox: inboxTable(db),
    sessions,
    handoff: {
      automatic: () => ({}) as never,
      automaticMode: async () => null,
    } as unknown as MaterialsDeps["handoff"],
    assetPort: { readAsset: () => undefined },
    notices,
    t,
    onError: () => {},
  } as MaterialsDeps;

  return { deps, sessions, notices, model };
}

/** 一条带用量的 AgentDefinition 消息：护栏只从消息上读用量 */
function answered(promptTokens: number): AgentNS.Message {
  return new Message({
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: "上一句回答",
    usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
  });
}

/** 假 Agent：护栏只看 `agent.messages` */
function fakeAgent(promptTokens: number) {
  return { messages: [answered(promptTokens)] };
}

function innerLoopCtx(agent: unknown): never {
  return { agent, body: { messages: [] } } as never;
}

function pluginOf<T>(materials: WakeMaterials, type: new (...args: never[]) => T): T {
  const found = (materials.plugins ?? []).find((plugin) => plugin instanceof type);
  if (found === undefined) throw new Error(`plugins 里没有 ${type.name}`);
  return found as T;
}

describe("装到Agent上的插件", () => {
  it("五颗插件都装上了（含 MCP elicitation 的答题通道），阈值是取值函数", async () => {
    const host = newHost();
    const session: SessionRecord = host.sessions.create(input);

    const materials = await materialsFor(host.deps, session);

    // 四颗：软线（自动交接）、硬线、硬线的 subagent 安装器、附件重建
    expect(materials.plugins?.some((plugin) => plugin instanceof AutoMigratePlugin)).toBe(true);
    expect(materials.plugins?.some((plugin) => plugin instanceof ContextGuardPlugin)).toBe(true);
    expect(
      materials.plugins?.some((plugin) => plugin instanceof SubAgentGuardInstallerPlugin),
    ).toBe(true);
    expect(materials.plugins?.some((plugin) => plugin instanceof AssetTransportPlugin)).toBe(true);
    // MCP elicitation：服务器中途问过来的表，得知道该挂到哪一段会话下（这一段）
    expect(materials.plugins?.some((plugin) => plugin instanceof McpElicitationPlugin)).toBe(true);

    // 会话行没给 `guardThreshold`：按生效模型的 400 判 —— 500 超线，拒
    const guard = pluginOf(materials, ContextGuardPlugin);
    const agent = fakeAgent(500);
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toEqual(expect.any(String));

    // 改会话行上的阈值（不重建 Agent）：同一颗插件下一次判定读到的是 600，500 不再超线
    host.sessions.update(session.id, { guardThreshold: 600 });
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toBeUndefined();

    // subagent 那一侧同源：现在才委派，装到它身上的护栏读到的也是 600（装配那一刻是 400）
    const installer = pluginOf(materials, SubAgentGuardInstallerPlugin);
    const subAgent = new Agent({ client: {} as never, model: "test-model" });
    installer.onSubAgentStart({ subAgent } as never);
    await expect(
      subAgent.dispatchHook("onInnerLoopStart", innerLoopCtx(fakeAgent(500))),
    ).resolves.toBeUndefined();

    // 反过来也验一次：阈值调小到 300，同一颗插件立刻按新值拒
    host.sessions.update(session.id, { guardThreshold: 300 });
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toEqual(expect.any(String));
  });

  /**
   * 改的是配置里那条模型（`/config` 里改阈值），不是会话行。
   *
   * 这条钉住一个真出过的问题：装配时传进来的 `model` 是那一刻的快照，阈值若从它身上读，
   * 用户把阈值调高之后同一颗护栏仍按旧数拒 —— 而且拒的那条通知因为「同一对数字」被去重吞掉，
   * 屏上一点反应都没有（「撞线之后调了阈值，再发什么也不动了」）。
   */
  it("改配置里的阈值也当场生效（不重建 Agent）：撞线后调高，同一颗护栏立刻放行", async () => {
    const host = newHost();
    const session: SessionRecord = host.sessions.create(input);
    const materials = await materialsFor(host.deps, session);
    const guard = pluginOf(materials, ContextGuardPlugin);
    const agent = fakeAgent(500);

    // 模型上那条硬线是 400：500 超线，拒
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toEqual(expect.any(String));

    // 用户在 /config 里把它调到 800（写的是配置里那条模型，会话行那一格始终是 null）
    host.model.tokenThresholds = { handoff: 100, guard: 800 };

    // 同一颗插件、同一个 Agent：不再超线
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toBeUndefined();

    // 再调回来也一样：现读的是配置，不是打开会话那一刻的快照
    host.model.tokenThresholds = { handoff: 100, guard: 200 };
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toEqual(expect.any(String));
  });
});
