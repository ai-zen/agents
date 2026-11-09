import { describe, it, expect, vi } from "vitest";
import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import type { SendContext, SubAgentContext } from "@ai-zen/agents-core";
import { ContextOverflowError } from "../shared/errors.js";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";
import { SubAgentGuardInstallerPlugin } from "./SubAgentGuardInstallerPlugin.js";

const MAX_TOKENS = 100;
/** 子 Agent 与主 Agent 共用同一个绝对阈值 guardTokens（到线即中断，无倍数） */
const HARD_LIMIT = MAX_TOKENS;

/** 组装 SendContext（仅 agent.lastUsage 参与护栏判定） */
function createSendCtx(agent: unknown): SendContext {
  return { agent, content: "", messages: [] } as unknown as SendContext;
}

/** 子 Agent 桩：只观察安装器向它装了什么 */
function createSubAgentStub() {
  const use = vi.fn();
  return { subAgent: { use } as unknown as Agent, use };
}

/** 取桩上 `use()` 收到的插件类名序列 */
function installedNames(use: ReturnType<typeof vi.fn>): string[] {
  return use.mock.calls.map(
    (call: unknown[]) => (call[0] as object).constructor.name,
  );
}

/** 从桩上 `use()` 收到的插件里按类型取一个（取不到就当场炸，不留静默通过） */
function pluginOf<T>(
  use: ReturnType<typeof vi.fn>,
  type: new (...args: never[]) => T,
): T {
  const found = use.mock.calls
    .map((call: unknown[]) => call[0] as object)
    .find((plugin) => plugin instanceof type);
  if (!found) throw new Error(`use() 没收到 ${type.name}`);
  return found as T;
}

/** 假子 Agent 的 `SendContext`：护栏只看 `ctx.agent.lastUsage`，其余无关 */
function overLimitSendCtx(guardTokens: number): SendContext {
  return {
    agent: { lastUsage: { prompt_tokens: guardTokens + 1 } },
    content: "",
    messages: [],
  } as unknown as SendContext;
}

/** 真实 Agent 实例（不发起请求，仅用于钩子分发） */
function createRealAgent(): Agent {
  return new Agent({ client: {} as never, model: "test-model" });
}

/**
 * 设置子 Agent 上一轮的用量：`lastUsage` 是从 messages 派生的只读值，
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

/** 构造委派上下文 */
function createSubAgentCtx(
  subAgent: Agent,
  host: Agent = {} as Agent,
): SubAgentContext {
  return {
    agent: host,
    subAgent,
    toolCallContext: {} as never,
  } as SubAgentContext;
}

describe("SubAgentGuardInstallerPlugin", () => {
  it("委派时装「上下文护栏 + 安装器自身」，且始终不拒绝委派", () => {
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });
    const { subAgent, use } = createSubAgentStub();

    const result = installer.onSubAgentStart(createSubAgentCtx(subAgent));

    expect(result).toBeUndefined();
    expect(installedNames(use)).toEqual([
      "ContextGuardPlugin",
      "SubAgentGuardInstallerPlugin",
    ]);
  });

  it("安插后对子 Agent 立即生效（无需 init）：用量超硬上限即中断", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, HARD_LIMIT + 1);

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).rejects.toThrow(ContextOverflowError);
  });

  it("用量恰好等于硬上限时放行（判定为「超过」才中断）", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, HARD_LIMIT);

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).resolves.toBeUndefined();
  });

  it("首轮请求前无 usage 数据时放行", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).resolves.toBeUndefined();
  });

  it("阈值与主 Agent 同源：按传入的 guardTokens 判定硬线", async () => {
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({ guardTokens: 1000 });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, 1000); // 恰好等于硬线 → 放行（判定为「超过」才中断）

    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).resolves.toBeUndefined();

    setUsage(subAgent, 1001);
    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).rejects.toThrow(ContextOverflowError);
  });

  it("孙级传染：子 Agent 再委派时，孙 Agent 同样被安插", async () => {
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
    });
    const child = createRealAgent();

    installer.onSubAgentStart(createSubAgentCtx(child));

    const { subAgent: grandChild, use } = createSubAgentStub();
    await child.dispatchHook(
      "onSubAgentStart",
      createSubAgentCtx(grandChild, child),
    );

    expect(installedNames(use)).toEqual([
      "ContextGuardPlugin",
      "SubAgentGuardInstallerPlugin",
    ]);
  });

  it("交接中让行：isSuspended 为 true 时子 Agent 不拦，翻成 false 立刻恢复拦截", async () => {
    // 交接回合本身就是上下文最满的时刻：主 Agent 让行而子 Agent 照拦，交接中派出去的
    // 子任务就会被自己的硬线打断。这里用一个**可变**开关，证明让行判断是每次判定时
    // 现读的（不是装配那一刻的快照）。
    let suspended = true;
    const subAgent = createRealAgent();
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
      isSuspended: () => suspended,
    });

    installer.onSubAgentStart(createSubAgentCtx(subAgent));
    setUsage(subAgent, HARD_LIMIT + 1);

    // 交接中：用量明显超线也不拦
    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).resolves.toBeUndefined();

    // 交接结束：同一颗插件、同一份用量，立刻恢复拦截
    suspended = false;
    await expect(
      subAgent.dispatchHook("onInnerLoopStart", createSendCtx(subAgent)),
    ).rejects.toThrow(ContextOverflowError);
  });

  it("孙级也带上了让行判断：递归安插出的安装器把 isSuspended 一路传下去", async () => {
    let suspended = true;
    const installer = new SubAgentGuardInstallerPlugin({
      guardTokens: MAX_TOKENS,
      isSuspended: () => suspended,
    });
    const child = createRealAgent();
    installer.onSubAgentStart(createSubAgentCtx(child));

    // 孙级：捕获挂到它身上的插件（不真跑请求）
    const { subAgent: grandChild, use } = createSubAgentStub();
    await child.dispatchHook(
      "onSubAgentStart",
      createSubAgentCtx(grandChild, child),
    );

    const grandGuard = pluginOf(use, ContextGuardPlugin);
    await expect(
      grandGuard.onInnerLoopStart(overLimitSendCtx(HARD_LIMIT)),
    ).resolves.toBeUndefined();

    suspended = false;
    await expect(
      grandGuard.onInnerLoopStart(overLimitSendCtx(HARD_LIMIT)),
    ).rejects.toThrow(ContextOverflowError);

    // 再往下一层（曾孙）：递归出的安装器本身也得带着让行，否则缺口只是往下挪一层
    suspended = true;
    const grandInstaller = pluginOf(use, SubAgentGuardInstallerPlugin);
    const { subAgent: greatGrandChild, use: greatUse } = createSubAgentStub();
    grandInstaller.onSubAgentStart(
      createSubAgentCtx(greatGrandChild, grandChild),
    );

    await expect(
      pluginOf(greatUse, ContextGuardPlugin).onInnerLoopStart(
        overLimitSendCtx(HARD_LIMIT),
      ),
    ).resolves.toBeUndefined();
  });
});
