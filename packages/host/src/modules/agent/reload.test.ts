/**
 * 定义改完之后的那一次重装。
 *
 * 这一份验的是次序与范围：只有「用着这个定义**且**还活着」的那几段被重装，且每一段都是
 * **先取材料、再杀、再装** —— 材料要读排队区，而杀会把排队区作废；反过来排的话，没被处理的
 * 那几句就在这一次改动里丢了。另外一条是失败的范围：一段装不起来不该连累其余几段。
 *
 * 会话与项目用真的内存库（要验的正是「挑出哪几段」），运行时的 `get` / `kill` / `wake` 与材料
 * 用替身：造一个真运行时得先有一个能出网的模型，而这条路上要验的是调用次序，不是运行时自己的
 * 行为。
 */

import type { AgentRuntime, WakeMaterials } from "@ai-zen/agents-sdk";
import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { Session } from "../session/types.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import { reloadDefinition } from "./reload.js";
import type { ReloadDefinitionDeps } from "./reload.js";

/**
 * 一个真库加一个项目，加三份替身：谁活着（`live`）、做过什么（`log`）、哪一段装不起来
 * （`broken`）。
 */
function newHost() {
  const db = openDatabase(":memory:");
  const t = createTranslator(() => "zh");
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });
  const sessions = new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t,
  });
  const workspace = workspaces.create("项目一", "/tmp/reload-definition");

  /** 按发生顺序记一笔：次序本身就是这条路上要验的那个结论 */
  const log: string[] = [];
  /** 此刻有执行体的那几段 */
  const live = new Set<string>();
  /** `wake` 会抛的那几段 */
  const broken = new Set<string>();

  const runtime = {
    get: (sessionId: string) => (live.has(sessionId) ? {} : undefined),
    kill: (sessionId: string) => {
      log.push(`kill ${sessionId}`);
      live.delete(sessionId);
    },
    wake: async (sessionId: string) => {
      log.push(`wake ${sessionId}`);
      if (broken.has(sessionId)) throw new Error(`装不起来：${sessionId}`);
      live.add(sessionId);
    },
  } as unknown as AgentRuntime;

  /** 材料那一份：这条路上只有「什么时候取」有意义，内容一个字都不读 */
  const materials = async (session: Session): Promise<WakeMaterials> => {
    log.push(`materials ${session.id}`);
    return {
      cwd: workspace.cwd,
      agentId: session.agentId,
      lineage: null,
      history: [],
      waiting: [],
    };
  };

  const errors: { error: unknown; what: string }[] = [];
  const deps: ReloadDefinitionDeps = {
    sessions,
    workspaces,
    runtime,
    materials,
    onError: (error, what) => errors.push({ error, what }),
  };

  return { deps, sessions, workspace, log, live, broken, errors };
}

type Host = ReturnType<typeof newHost>;

function newSession(host: Host, agentId: string): Session {
  return host.sessions.create({
    workspaceId: host.workspace.id,
    name: "1712345678000",
    nameIsAuto: true,
    agentId,
    modelId: "model-1",
    autoHandoff: false,
    lineage: null,
  });
}

describe("改完定义之后重装", () => {
  it("用着这个定义的活执行体先取材料、再杀、再装；别的定义与已经死的不动", async () => {
    const host = newHost();
    const first = newSession(host, "agent-a");
    const second = newSession(host, "agent-a");
    const other = newSession(host, "agent-b");
    const dead = newSession(host, "agent-a");
    // 两段 A 活着、一段 B 活着；还有一段 A 本来就没有执行体（重启之后都是这一种）
    for (const session of [first, second, other]) host.live.add(session.id);

    const reloaded = await reloadDefinition(host.deps, "agent-a");

    // 恰好那两段，死的那一段不在名单里
    expect([...reloaded].sort()).toEqual([first.id, second.id].sort());
    // 每一段都是「取材料 → 杀 → 唤醒」，顺序照返回的名单走
    expect(host.log).toEqual(
      reloaded.flatMap((id) => [`materials ${id}`, `kill ${id}`, `wake ${id}`]),
    );
    // 用着另一个定义的那一段、以及本来就没有执行体的那一段，一个字都没被碰
    expect(host.log.filter((entry) => entry.includes(other.id))).toEqual([]);
    expect(host.log.filter((entry) => entry.includes(dead.id))).toEqual([]);
    // 装完的那两段又是活着的
    expect([...host.live].sort()).toEqual([first.id, second.id, other.id].sort());
    expect(host.errors).toEqual([]);
  });

  it("一段装不起来不连累其余：返回的名单只有装成了的，失败的那段记一句", async () => {
    const host = newHost();
    const doomed = newSession(host, "agent-a");
    const fine = newSession(host, "agent-a");
    for (const session of [doomed, fine]) host.live.add(session.id);
    host.broken.add(doomed.id);

    const reloaded = await reloadDefinition(host.deps, "agent-a");

    // 装不起来的留在结果之外：客户端据此知道哪一段现在没有执行体
    expect(reloaded).toEqual([fine.id]);
    // 失败那一段的那句话进了 `onError`，它带得上是谁：日志里要认得出是哪一段
    expect(host.errors).toHaveLength(1);
    expect(String(host.errors[0]?.error)).toContain(doomed.id);
    expect(host.errors[0]?.what).toContain(doomed.id);
    // 好的一段照旧装起来了
    expect(host.live.has(fine.id)).toBe(true);
    // 装不起来的那一段已经被杀掉了：它现在是「行在、执行体不在」，下一次唤醒会重新读定义
    expect(host.live.has(doomed.id)).toBe(false);
  });
});
