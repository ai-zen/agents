/**
 * 每段对话的进程内状态（R51）：临时模型与临时思考档位只在内存里、`forget` 之后不残留、
 * 「在跑吗」问的是 `RunRegistry`（不另存第二份）。
 */

import { describe, expect, it } from "vitest";

import type { ConversationRuntimePort } from "../services/ConversationService.js";
import { ConversationStateRegistry } from "./ConversationStateRegistry.js";
import { RunRegistry } from "./RunRegistry.js";

describe("ConversationStateRegistry", () => {
  it("临时模型：设了能读、清掉回 null", () => {
    const registry = new ConversationStateRegistry({ runs: new RunRegistry() });

    expect(registry.getModelOverride("c1")).toBeNull();
    registry.setModelOverride("c1", "m-vision");
    expect(registry.getModelOverride("c1")).toBe("m-vision");
    // 别的对话不受影响
    expect(registry.getModelOverride("c2")).toBeNull();

    registry.setModelOverride("c1", null);
    expect(registry.getModelOverride("c1")).toBeNull();
  });

  it("临时思考档位：设了能读、空串与 null 都按清掉处理", () => {
    const registry = new ConversationStateRegistry({ runs: new RunRegistry() });

    registry.setThinkingOverride("c1", "high");
    expect(registry.getThinkingOverride("c1")).toBe("high");

    registry.setThinkingOverride("c1", "");
    expect(registry.getThinkingOverride("c1")).toBeNull();

    registry.setThinkingOverride("c1", "low");
    registry.setThinkingOverride("c1", null);
    expect(registry.getThinkingOverride("c1")).toBeNull();
  });

  it("两端空白不算模型名（避免把空串当成一次覆盖）", () => {
    const registry = new ConversationStateRegistry({ runs: new RunRegistry() });
    registry.setModelOverride("c1", "   ");
    expect(registry.getModelOverride("c1")).toBeNull();

    registry.setModelOverride(" c1 ", "m-1");
    expect(registry.getModelOverride("c1")).toBe("m-1");
  });

  it("forget 之后两样都不残留", () => {
    const registry = new ConversationStateRegistry({ runs: new RunRegistry() });
    registry.setModelOverride("c1", "m-1");
    registry.setThinkingOverride("c1", "high");
    expect(registry.size()).toBe(1);

    registry.forget("c1");

    expect(registry.getModelOverride("c1")).toBeNull();
    expect(registry.getThinkingOverride("c1")).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("isRunning 问的是 RunRegistry（不是自己记的）", () => {
    const runs = new RunRegistry();
    const registry = new ConversationStateRegistry({ runs });

    expect(registry.isRunning("c1")).toBe(false);
    const handle = runs.start("c1");
    expect(registry.isRunning("c1")).toBe(true);

    runs.finish("c1");
    expect(registry.isRunning("c1")).toBe(false);
    expect(handle.aborted).toBe(false);
  });

  it("结构上满足服务层要的窄接口（编译期就保证，用例只做一次赋值）", () => {
    const port: ConversationRuntimePort = new ConversationStateRegistry({
      runs: new RunRegistry(),
    });
    port.setModelOverride("c1", "m-2");
    expect(port.getModelOverride("c1")).toBe("m-2");
  });

  it("两个实例互不影响（没有模块级单例）", () => {
    const first = new ConversationStateRegistry({ runs: new RunRegistry() });
    const second = new ConversationStateRegistry({ runs: new RunRegistry() });

    first.setModelOverride("c1", "m-1");

    expect(first.getModelOverride("c1")).toBe("m-1");
    expect(second.getModelOverride("c1")).toBeNull();
  });
});
