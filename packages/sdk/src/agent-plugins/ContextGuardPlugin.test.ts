import { describe, it, expect } from "vitest";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";

/**
 * 护栏现在**拒绝这一圈**（返回字符串），不是抛错。
 *
 * 新 core 里 `onInnerLoopStart` 返回 string = 这一圈压根没发出去（历史里一个字都不多，
 * core 报 `denied`，循环继续等下一个事件）；抛错会穿到 `start()` 外面把整个循环打死。
 * 所以这里断言的是「返回了什么理由」，而不是「抛了哪个类」。
 */

function mockAgent(opts: { lastUsage?: { prompt_tokens?: number } }) {
  return {
    lastUsage: opts.lastUsage,
  };
}

function buildCtx(agent: any): any {
  return { agent, body: { messages: [] } };
}

describe("ContextGuardPlugin", () => {
  it("返回一个 AgentPlugin（有 onInnerLoopStart）", () => {
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    expect(typeof plugin.onInnerLoopStart).toBe("function");
  });

  it("lastUsage 为 undefined（首轮请求前）时不拒", async () => {
    const agent = mockAgent({ lastUsage: undefined });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("用量未达到 guardTokens 时不拒", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 200_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("等于 guardTokens 的边界值不拒（> 而非 >=）", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 375_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("超过 guardTokens 时返回拒绝理由，并带上用量与阈值", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });

    const reason = await plugin.onInnerLoopStart!(buildCtx(agent));

    expect(typeof reason).toBe("string");
    expect(reason).toContain("400000");
    expect(reason).toContain("375000");
    // 文案原样来自 ContextOverflowError（人类可读那份）
    expect(reason).toContain("Context critically over the limit");
  });

  it("阈值是绝对值：不乘任何系数，也不因交接回合而放宽", async () => {
    // 400_000 < 250_000 × 2（旧的交接期放宽值），但仍 > guardTokens，必须拒
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toEqual(expect.any(String));

    // 换一个更大的 guardTokens 就放行——调松的唯一方式是把数字改大
    const lenient = new ContextGuardPlugin({ guardTokens: 500_000 });
    await expect(lenient.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("isSuspended 返回 true 时让行（交接/迁移回合）", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
    let busy = true;
    const plugin = new ContextGuardPlugin({
      guardTokens: 375_000,
      isSuspended: () => busy,
    });

    // 交接回合：上下文最满，但不应该被打回
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();

    // 让行结束后恢复硬线
    busy = false;
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toEqual(expect.any(String));
  });

  it("isSuspended 为 false 或未提供时照常判定", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });

    const notSuspended = new ContextGuardPlugin({
      guardTokens: 375_000,
      isSuspended: () => false,
    });
    await expect(notSuspended.onInnerLoopStart!(buildCtx(agent))).resolves.toEqual(
      expect.any(String),
    );
  });
});
