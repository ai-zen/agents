/**
 * `refreshAll()` 的回执：刷了几份、哪几份没刷成。
 *
 * 这一份回执存在的理由只有一条 —— 调用方要能说出「这一手有没有生效」。只回一个 `void`（或者只
 * 记一行日志）的话，「全都刷好了」与「一份都没刷动」在调用方那里长得一模一样，而后者正是要让人
 * 知道的那一种。
 *
 * 容器本身是真的（真的 `Scope`）：刷不动的那个不是替身，而是一个取配置就会抛的真容器 ——
 * 「刷不动」在这条路上的形态就是 `refresh()` 抛错，用替身造出来的抛出与真的不是同一件事。
 */

import { describe, expect, it } from "vitest";

import { Scope } from "../scope/Scope.js";
import type { PeerSessionPort } from "../scope/plugins/peers/peerSessionTools.js";
import type { AppConfig } from "../types/index.js";
import { Scopes, type ScopeEvent } from "./Scopes.js";

const CONFIG = { endpoints: [], models: [] } as unknown as AppConfig;
/** 容器造好之后不会再问它，这一条用例里没有任何一段会话要用它 */
const PEERS = {} as PeerSessionPort;

/** 一个好的容器：取配置照常给出那一份 */
function healthy(cwd: string): Scope {
  return new Scope({ getConfig: () => CONFIG, agentsDir: "/tmp/agents", cwd });
}

/**
 * 一个刷不动的容器：`refresh()` 的第一句就是现读配置，那一句抛。
 *
 * 第一次读放过去：`Scope` 的构造器自己就要读一份（造的时候得有一份配置），那一次不能让这条
 * 用例在造容器时就挂掉 —— 要造出来的正是「造得出来、但刷新时抛」那一个处境。
 */
function broken(cwd: string): Scope {
  let reads = 0;
  return new Scope({
    getConfig: () => {
      reads += 1;
      if (reads > 1) throw new Error("配置读不出来");
      return CONFIG;
    },
    agentsDir: "/tmp/agents",
    cwd,
  });
}

/** 按目录造容器：造哪个由用例给，于是「哪一份刷不动」是这一段自己摆的 */
function setup(make: (cwd: string) => Scope) {
  const events: ScopeEvent[] = [];
  const scopes = new Scopes({
    openScope: async (cwd) => make(cwd),
    aliveSessions: () => [],
    peers: PEERS,
    onChange: (event) => events.push(event),
  });
  return { scopes, events };
}

describe("refreshAll 的回执", () => {
  it("一份容器都没有：回的是零份，不是「成功了」", async () => {
    const { scopes } = setup(healthy);

    expect(await scopes.refreshAll()).toEqual({ total: 0, refreshed: 0, failed: [] });
  });

  it("两份都刷成了：份数对得上，没有失败项", async () => {
    const { scopes, events } = setup(healthy);
    await scopes.for("/tmp/a");
    await scopes.for("/tmp/b");

    const report = await scopes.refreshAll();

    expect(report).toEqual({ total: 2, refreshed: 2, failed: [] });
    // 刷成功的那两份各发一条「刷新完了」：回执与事实说的是同一件事的两面
    expect(events.filter((event) => event.type === "refreshed").map((event) => event.cwd)).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });

  it("一份刷不动：说出是哪个目录、为什么，另一份照旧刷", async () => {
    const { scopes, events } = setup((cwd) => (cwd === "/tmp/bad" ? broken(cwd) : healthy(cwd)));
    await scopes.for("/tmp/good");
    await scopes.for("/tmp/bad");

    const report = await scopes.refreshAll();

    expect(report.total).toBe(2);
    expect(report.refreshed).toBe(1);
    expect(report.failed).toEqual([{ cwd: "/tmp/bad", reason: "配置读不出来" }]);
    // 刷不动的那个不发「刷新完了」（它拿的还是旧配置），好的那个照发 —— 一份刷不动不连累其余
    expect(events.filter((event) => event.type === "refreshed").map((event) => event.cwd)).toEqual([
      "/tmp/good",
    ]);
  });
});
