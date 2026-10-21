import { describe, it, expect } from "vitest";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";
import { ContextOverflowError } from "../shared/errors.js";

function mockAgent(opts: { lastUsage?: { prompt_tokens?: number } }) {
  return {
    lastUsage: opts.lastUsage,
  };
}

function buildCtx(agent: any): any {
  return { agent, content: "hello", messages: [] };
}

describe("ContextGuardPlugin", () => {
  it("返回一个 AgentPlugin（有 onInnerLoopStart）", () => {
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    expect(typeof plugin.onInnerLoopStart).toBe("function");
  });

  it("lastUsage 为 undefined（首轮请求前）时不抛错", async () => {
    const agent = mockAgent({ lastUsage: undefined });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("用量未达到 guardTokens 时不抛错", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 200_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("等于 guardTokens 的边界值不抛错（> 而非 >=）", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 375_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("超过 guardTokens 时抛出 ContextOverflowError，并带上用量与阈值", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });

    try {
      await plugin.onInnerLoopStart!(buildCtx(agent));
      expect.unreachable("应当抛出异常");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextOverflowError);
      const e = err as ContextOverflowError;
      expect(e.promptTokens).toBe(400_000);
      expect(e.guardTokens).toBe(375_000);
      expect(e.message).toContain("375000");
    }
  });

  it("阈值是绝对值：不乘任何系数，也不因交接回合而放宽", async () => {
    // 400_000 < 250_000 × 2（旧的交接期放宽值），但仍 > guardTokens，必须抛
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).rejects.toBeInstanceOf(
      ContextOverflowError,
    );

    // 换一个更大的 guardTokens 就放行——调松的唯一方式是把数字改大
    const lenient = new ContextGuardPlugin({ guardTokens: 500_000 });
    await expect(lenient.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });
});
