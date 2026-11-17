import { describe, it, expect } from "vitest";
import { AgentNS, Message } from "@ai-zen/agents-core";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";

/**
 * 护栏现在**拒绝这一圈**（返回字符串），不是抛错。
 *
 * 新 core 里 `onInnerLoopStart` 返回 string = 这一圈压根没发出去（历史里一个字都不多，
 * core 报 `denied`，循环继续等下一个事件）；抛错会穿到 `start()` 外面把整个循环打死。
 * 所以这里断言的是「返回了什么理由」，而不是「抛了哪个类」。
 */

/** 一条带 `usage` 的 assistant 消息（用量只存在消息上，core 不另存快照） */
function assistantWithUsage(promptTokens: number): AgentNS.Message {
  return new Message({
    role: AgentNS.Role.Assistant,
    content: "上一轮回复",
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 1,
      total_tokens: promptTokens + 1,
    },
  });
}

/**
 * 护栏替身：它只看 `agent.messages` —— 从后往前找最近一条带 `usage` 的 assistant 消息。
 *
 * `olderPromptTokens` 与 `promptTokens` 都给了时，前者是更早那一轮（用来验「只认最后一条」）。
 */
function mockAgent(opts: { promptTokens?: number; olderPromptTokens?: number } = {}) {
  const messages: AgentNS.Message[] = [];
  if (opts.olderPromptTokens != null) messages.push(assistantWithUsage(opts.olderPromptTokens));
  if (opts.promptTokens != null) messages.push(assistantWithUsage(opts.promptTokens));
  return { messages };
}

function buildCtx(agent: any): any {
  return { agent, body: { messages: [] } };
}

describe("ContextGuardPlugin", () => {
  it("返回一个 AgentPlugin（有 onInnerLoopStart）", () => {
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    expect(typeof plugin.onInnerLoopStart).toBe("function");
  });

  it("还没有用量（首轮请求前）时不拒", async () => {
    const agent = mockAgent();
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("用量未达到 guardTokens 时不拒", async () => {
    const agent = mockAgent({ promptTokens: 200_000 });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("等于 guardTokens 的边界值不拒（> 而非 >=）", async () => {
    const agent = mockAgent({ promptTokens: 375_000 });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("超过 guardTokens 时返回拒绝理由，并带上用量与阈值", async () => {
    const agent = mockAgent({ promptTokens: 400_000 });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });

    const reason = await plugin.onInnerLoopStart!(buildCtx(agent));

    expect(typeof reason).toBe("string");
    expect(reason).toContain("400000");
    expect(reason).toContain("375000");
    // 文案原样来自 ContextOverflowError（人类可读那份）
    expect(reason).toContain("Context critically over the limit");
  });

  /**
   * 取数口径的用例：读的是「最后一条带 usage 的 assistant 消息」。
   *
   * 两个方向都钉住：末尾那条小 → 不拒（哪怕更早那条是 400k）；末尾那条大 → 拒（哪怕更早那条很小）。
   */
  it("从最后一条带 usage 的 assistant 消息取 prompt_tokens", async () => {
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });

    // 末条小、更早那条超线：按末条判 → 放行
    const shrunk = mockAgent({ olderPromptTokens: 400_000, promptTokens: 1_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(shrunk))).resolves.toBeUndefined();

    // 末条超线、更早那条很小：按末条判 → 拒
    const grown = mockAgent({ olderPromptTokens: 1_000, promptTokens: 400_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(grown))).resolves.toEqual(expect.any(String));
  });

  it("阈值是绝对值：不乘任何系数，也不因交接回合而放宽", async () => {
    // 400_000 < 250_000 × 2（旧的交接期放宽值），但仍 > guardTokens，必须拒
    const agent = mockAgent({ promptTokens: 400_000 });
    const plugin = new ContextGuardPlugin({ guardTokens: 375_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toEqual(expect.any(String));

    // 换一个更大的 guardTokens 就放行——调松的唯一方式是把数字改大
    const lenient = new ContextGuardPlugin({ guardTokens: 500_000 });
    await expect(lenient.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("isSuspended 返回 true 时让行（交接回合）", async () => {
    const agent = mockAgent({ promptTokens: 400_000 });
    let handingOff = true;
    const plugin = new ContextGuardPlugin({
      guardTokens: 375_000,
      isSuspended: () => handingOff,
    });

    // 交接回合：上下文最满，但不应该被打回
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();

    // 让行结束后恢复硬线
    handingOff = false;
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toEqual(expect.any(String));
  });

  it("isSuspended 为 false 或未提供时照常判定", async () => {
    const agent = mockAgent({ promptTokens: 400_000 });

    const notSuspended = new ContextGuardPlugin({
      guardTokens: 375_000,
      isSuspended: () => false,
    });
    await expect(notSuspended.onInnerLoopStart!(buildCtx(agent))).resolves.toEqual(
      expect.any(String),
    );
  });
});
