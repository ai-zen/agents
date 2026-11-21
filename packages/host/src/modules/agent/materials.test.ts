/**
 * 装到执行体上的那几颗插件（`materialsFor` 交给运行时的 `plugins`）。
 *
 * 钉住两件事：
 *
 * 1. **硬线真的装上了** —— `ContextGuardPlugin` 与 `SubAgentGuardInstallerPlugin` 一颗都没有
 *    装到执行体上时，撞线照样把请求发出去、等端点回错；这件事不会报错，只会让每一次撞线都变成
 *    一次白花的请求。
 * 2. **阈值是取值函数** —— 两条阈值改了不重建执行体（`dev-docs/prd/05-control.md`）：装配那一刻
 *    算好的数会把用户之后改的数字钉死。这里改一次会话行上的 `guardThreshold`，再从同一颗插件
 *    （以及它给 subagent 装的那一颗）上验一次判定，看的是新值还是旧值。
 *
 * 读新值的办法是**触发一次判定**（`onInnerLoopStart` / 委派边界上的 `onSubAgentStart`），
 * 不去摸插件内部的字段：字段叫什么、存在第几层是实现细节，而「判定时读的是哪个数」正是要验的
 * 那一件事。护栏「超线就拒」那一套搭法与 `ContextGuardPlugin.test.ts` 同一个：用量只从消息上读。
 */

import { describe, expect, it } from "vitest";

import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import {
  AssetTransportPlugin,
  AutoMigratePlugin,
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
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { Session } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import { WorkspaceService } from "../workspace/service.js";
import { materialsFor } from "./materials.js";
import type { MaterialsDeps } from "./materials.js";
import { inboxTable } from "./inbox.js";
import { messageTable } from "../session/messages.js";

const input = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameIsAuto: true,
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
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });

  /**
   * 定义与配置：这两条路上只用得到「定义一个模型是谁」「配置里那个模型的两条阈值」。
   *
   * 交接那一格给的是不碰的替身：这条用例问的是插件装没装上、阈值是不是现读的，交接不参与。
   */
  const deps = {
    workspaces: new WorkspaceService({ workspaces: workspaceTable(db), t }),
    definitions: {
      get: async (): Promise<AgentDefinition> => ({
        id: "agent-1",
        name: "助手",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    } as unknown as MaterialsDeps["definitions"],
    config: {
      read: () => ({ defaultModel: "model-1", models: [MODEL] }) as unknown as AppConfig,
    } as unknown as MaterialsDeps["config"],
    messages: messageTable(db),
    inbox: inboxTable(db),
    sessions,
    handoff: {
      automatic: () => ({}) as never,
      automaticMode: async () => null,
    } as unknown as MaterialsDeps["handoff"],
    assetPort: { readAsset: () => undefined },
  } as MaterialsDeps;

  return { deps, sessions };
}

/** 一条带用量的助手消息：护栏只从消息上读用量 */
function answered(promptTokens: number): AgentNS.Message {
  return new Message({
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: "上一句回答",
    usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
  });
}

/** 假执行体：护栏只看 `agent.messages` */
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

describe("装到执行体上的插件", () => {
  it("四颗插件都装上了，阈值是取值函数", async () => {
    const host = newHost();
    const session: Session = host.sessions.create(input);

    const materials = await materialsFor(host.deps, session);

    // 四颗：软线（自动交接）、硬线、硬线的 subagent 安装器、附件重建
    expect(materials.plugins?.some((plugin) => plugin instanceof AutoMigratePlugin)).toBe(true);
    expect(materials.plugins?.some((plugin) => plugin instanceof ContextGuardPlugin)).toBe(true);
    expect(
      materials.plugins?.some((plugin) => plugin instanceof SubAgentGuardInstallerPlugin),
    ).toBe(true);
    expect(materials.plugins?.some((plugin) => plugin instanceof AssetTransportPlugin)).toBe(true);

    // 会话行没给 `guardThreshold`：按生效模型的 400 判 —— 500 超线，拒
    const guard = pluginOf(materials, ContextGuardPlugin);
    const agent = fakeAgent(500);
    await expect(guard.onInnerLoopStart(innerLoopCtx(agent))).resolves.toEqual(expect.any(String));

    // 改会话行上的阈值（不重建执行体）：同一颗插件下一次判定读到的是 600，500 不再超线
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
});
