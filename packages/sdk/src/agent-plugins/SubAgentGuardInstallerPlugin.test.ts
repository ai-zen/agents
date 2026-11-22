import { describe, it, expect, vi } from "vitest";
import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import type { InnerLoopContext, SubAgentHookContext } from "@ai-zen/agents-core";
import { SubAgentGuardInstallerPlugin } from "./SubAgentGuardInstallerPlugin.js";

const MAX_TOKENS = 100;
/** subagent 与主 Agent 共用同一个绝对阈值 guardTokens（到线即中断，无倍数） */
const HARD_LIMIT = MAX_TOKENS;

/** 组装 `onInnerLoopStart` 的 ctx（仅 agent.messages 上的用量参与护栏判定） */
function createInnerLoopCtx(agent: unknown): InnerLoopContext {
  return { agent, body: { messages: [] } } as unknown as InnerLoopContext;
}

/** subagent 桩：只观察安装器向它装了什么 */
function createSubAgentStub() {
  const use = vi.fn();
  return { subAgent: { use } as unknown as Agent, use };
}

/** 取桩上 `use()` 收到的插件类名序列 */
function installedNames(use: ReturnType<typeof vi.fn>): string[] {
  return use.mock.calls.map((call: unknown[]) => (call[0] as object).constructor.name);
}

/** 真实 Agent 实例（不发起请求，仅用于钩子分发） */
function createRealAgent(): Agent {
  return new Agent({ client: {} as never, model: "test-model" });
}

/**
 * 设置 subagent 上一轮的用量：用量只存在消息上（最后一条带 `usage` 的 assistant 消息），
 * 所以这里造一条带 usage 的 assistant 消息（等价于流式响应写入后的状态）。
 */
function setUsage(agent: Agent, promptTokens: number): void {
  agent.messages.push(
    new Message({
      role: AgentNS.Role.Assistant,
      content: "上一轮回复",
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
      },
    }),
  );
}

/** 构造委派上下文（core 的 `SubAgentHookContext`：agent / subAgent / toolCallContext） */
function createSubAgentCtx(subAgent: Agent, host: Agent = {} as Agent): SubAgentHookContext {
  return {
    agent: host,
    subAgent,
    toolCallContext: {} as never,
  } as SubAgentHookContext;
}

describe("SubAgentGuardInstallerPlugin", () => {
  it("委派时装「上下文护栏 + 安装器自身」，且始终不拒绝委派", () => {
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });
    const { subAgent, use } = createSubAgentStub();

    const result = installer.onSubAgentStart(createSubAgentCtx(subAgent));

    expect(result).toBeUndefined();
    expect(installedNames(use)).toEqual(["ContextGuardPlugin", "SubAgentGuardInstallerPlugin"]);
  });

  it("安插后对subagent 立即生效（无需 init）：用量超硬上限即拒这一圈", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, HARD_LIMIT + 1);

    // 拒绝 = 返回字符串（这一圈不发出去）；抛错会穿到 start() 外面把循环打死
    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createInnerLoopCtx(subAgent)),
    ).resolves.toEqual(expect.any(String));
  });

  it("用量恰好等于硬上限时放行（判定为「超过」才中断）", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, HARD_LIMIT);

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createInnerLoopCtx(subAgent)),
    ).resolves.toBeUndefined();
  });

  it("首轮请求前无 usage 数据时放行", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createInnerLoopCtx(subAgent)),
    ).resolves.toBeUndefined();
  });

  it("阈值与主 Agent 同源：按传入的 guardTokens 判定硬线", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({ guardTokens: 1000 });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, 1000); // 恰好等于硬线 → 放行（判定为「超过」才中断）

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createInnerLoopCtx(subAgent)),
    ).resolves.toBeUndefined();

    setUsage(subAgent, 1001);
    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createInnerLoopCtx(subAgent)),
    ).resolves.toEqual(expect.any(String));
  });

  it("孙级传染：subagent 再委派时，孙 Agent 同样被安插", async () => {
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });
    const child = createRealAgent();

    installer.onSubAgentStart(createSubAgentCtx(child));

    const { subAgent: grandChild, use } = createSubAgentStub();
    await child.dispatchHook("onSubAgentStart", createSubAgentCtx(grandChild, child));

    expect(installedNames(use)).toEqual(["ContextGuardPlugin", "SubAgentGuardInstallerPlugin"]);
  });
});
