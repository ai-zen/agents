/**
 * 两条验收：同一个目录并发要两次只造一个容器（用布尔标志记「正在创建」会在第一次 `await`
 * 之后露出空档，两个容器会各自连上一套 MCP）；还有活着的会话时拆被拒、容器原样还在，
 * 停掉之后拆才成功，再要的时候造的是新的那一个。
 */

import type { Scope } from "@ai-zen/agents-sdk";
import { describe, expect, it } from "vitest";

import { createTranslator } from "../i18n/index.js";
import { ScopeRegistry } from "./registry.js";

describe("能力容器", () => {
  it("同一个目录并发要两次只造一个容器", async () => {
    let created = 0;
    const registry = new ScopeRegistry({
      createScope: async () => {
        created += 1;
        // 造的那一步真的会悬在这里：标志的写法正是在这个空档里被第二次调用看穿
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { dispose: async () => {} } as unknown as Scope;
      },
      aliveSessions: () => [],
      t: createTranslator(() => "zh"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const [first, second] = await Promise.all([
      registry.for("/tmp/一个目录"),
      registry.for("/tmp/一个目录"),
    ]);

    expect(second).toBe(first);
    expect(created).toBe(1);
  });

  it("有活着的会话时拆被拒，停掉之后拆成功，再要造的是新的那一个", async () => {
    let alive: string[] = [];
    let disposed = 0;
    const registry = new ScopeRegistry({
      createScope: async (cwd) => {
        return {
          cwd,
          dispose: async () => {
            disposed += 1;
          },
        } as unknown as Scope;
      },
      aliveSessions: () => alive,
      t: createTranslator(() => "zh"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const first = await registry.for("/tmp/一个目录");
    alive = ["s-1", "s-2"];

    await expect(registry.dispose("/tmp/一个目录")).rejects.toMatchObject({ code: "busy" });
    expect(await registry.for("/tmp/一个目录")).toBe(first);
    expect(disposed).toBe(0);

    alive = [];
    await registry.dispose("/tmp/一个目录");
    expect(disposed).toBe(1);

    expect(await registry.for("/tmp/一个目录")).not.toBe(first);
  });

  it("配置变了之后刷新已造好的容器，其中一个刷不动不挡其余的", async () => {
    const refreshed: string[] = [];
    const registry = new ScopeRegistry({
      createScope: async (cwd) => {
        return {
          dispose: async () => {},
          refresh: async () => {
            refreshed.push(cwd);
            // 一个容器刷不动（配置崩坏、磁盘出错）不该让其余容器也停在旧配置上
            if (cwd === "/tmp/坏的") throw new Error("refresh failed");
          },
        } as unknown as Scope;
      },
      aliveSessions: () => [],
      t: createTranslator(() => "zh"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await registry.for("/tmp/坏的");
    await registry.for("/tmp/另一个");
    await registry.refreshAll();

    expect(refreshed.sort()).toEqual(["/tmp/另一个", "/tmp/坏的"]);
  });
});
