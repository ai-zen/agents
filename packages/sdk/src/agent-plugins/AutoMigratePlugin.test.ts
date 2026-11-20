import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import { AutoMigratePlugin } from "./AutoMigratePlugin.js";
import { HandoffAbortedError } from "../runtime/HandoffService.js";
import type { HandoffService } from "../runtime/HandoffService.js";
import { setLogger } from "../shared/logger.js";
import { sendRound } from "../test-support/agent-round.js";

const MAX_HANDOFF_TOKENS = 50_000;

/**
 * 最小服务替身：只暴露插件用到的 `handingOff` 与 `migrate`。
 *
 * 自动交接走的是 `migrate()`（写文档 + 换记忆：记忆长什么样只有 SDK 那一处算，落在哪儿看有
 * 没有注入落库接缝）。`handoff` 一并挂上 spy 但插件不该碰它 —— 那一路只产文档、不换记忆，
 * 自动交接要是走它，平级会话越线之后记忆根本不会换。用例靠「`handoff` 一次都没被调用」钉住。
 */
function stubService(options: { handingOff?: boolean } = {}) {
  const handoff = vi.fn(async () => ({}) as any);
  const migrate = vi.fn(async () => ({}) as any);
  const service = {
    handingOff: options.handingOff ?? false,
    handoff,
    migrate,
  } as unknown as HandoffService;
  return { service, handoff, migrate };
}

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
 * 让插件「闲下来」。
 *
 * 插件落在 `onIdle`（`send()` / `onAfterSend` 都已经不存在了），而 `onIdle()` 不带 ctx
 * —— 插件是在 `onOuterLoopStart` 里认领 agent 的。所以触发一次 idle 要先喂它一个外循环
 * ctx：这里给的就是「一个只有一条带 usage 的 assistant 消息的 agent」。
 */
async function goIdle(
  plugin: AutoMigratePlugin,
  options: { promptTokens?: number; olderPromptTokens?: number } = {},
): Promise<void> {
  const messages: AgentNS.Message[] = [];
  if (options.olderPromptTokens != null)
    messages.push(assistantWithUsage(options.olderPromptTokens));
  if (options.promptTokens != null) messages.push(assistantWithUsage(options.promptTokens));
  plugin.onOuterLoopStart({ agent: { messages }, entries: [] } as any);
  await plugin.onIdle();
}

function createPlugin(options: { service: HandoffService; resolveMode?: any }): AutoMigratePlugin {
  return new AutoMigratePlugin({
    service: options.service,
    handoffTokens: MAX_HANDOFF_TOKENS,
    resolveMode: options.resolveMode,
  });
}

describe("AutoMigratePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("返回一个 AgentPlugin（有 onIdle）", () => {
    const { service } = stubService();
    expect(typeof createPlugin({ service }).onIdle).toBe("function");
  });

  it("没认领到 agent 时什么都不做（不会凭空迁移）", async () => {
    const { service, migrate } = stubService();
    await createPlugin({ service }).onIdle();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("无 usage 数据时不交接", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }));
    expect(migrate).not.toHaveBeenCalled();
  });

  it("promptTokens <= handoffTokens 时不交接", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS });
    expect(migrate).not.toHaveBeenCalled();
  });

  it("超阈值时委托 service.migrate，并透传用量", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS + 1 });

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: MAX_HANDOFF_TOKENS + 1,
        handoffTokens: MAX_HANDOFF_TOKENS,
      }),
    );
  });

  /** 自动交接这条路走 `migrate()`：只产文档的那一路是手动的 `/handoff` */
  it("走的是 migrate，`handoff` 一次都不碰", async () => {
    const { service, handoff, migrate } = stubService();
    await goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS + 1 });

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(handoff).not.toHaveBeenCalled();
  });

  /**
   * 取数口径：从 `agent.messages` 倒着找最近一条带 `usage` 的 assistant 消息。
   *
   * 两个方向都钉住（末条小 / 末条大），否则「取最后一条」与「取最大一条」分不出来。
   */
  it("从最后一条带 usage 的 assistant 消息取 prompt_tokens", async () => {
    const shrunk = stubService();
    await goIdle(createPlugin({ service: shrunk.service }), {
      olderPromptTokens: MAX_HANDOFF_TOKENS + 1,
      promptTokens: 1_000,
    });
    expect(shrunk.migrate).not.toHaveBeenCalled();

    const grown = stubService();
    await goIdle(createPlugin({ service: grown.service }), {
      olderPromptTokens: 1_000,
      promptTokens: MAX_HANDOFF_TOKENS + 1,
    });
    expect(grown.migrate).toHaveBeenCalledTimes(1);
  });

  it("未提供 resolveMode 时不指定执行者（由服务默认值决定）", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS + 1 });

    expect((migrate.mock.calls[0] as any[])[0].mode).toBeUndefined();
  });

  it("resolveMode 返回的执行者被透传给 service.migrate", async () => {
    const { service, migrate } = stubService();
    const resolveMode = vi.fn(async () => "summary" as const);

    await goIdle(createPlugin({ service, resolveMode }), {
      promptTokens: MAX_HANDOFF_TOKENS + 1,
    });

    expect(resolveMode).toHaveBeenCalledWith({
      promptTokens: MAX_HANDOFF_TOKENS + 1,
      handoffTokens: MAX_HANDOFF_TOKENS,
    });
    expect((migrate.mock.calls[0] as any[])[0].mode).toBe("summary");
  });

  it("resolveMode 返回 null 时跳过本次交接", async () => {
    const { service, migrate } = stubService();
    const resolveMode = vi.fn(async () => null);

    await goIdle(createPlugin({ service, resolveMode }), {
      promptTokens: MAX_HANDOFF_TOKENS + 1,
    });

    expect(migrate).not.toHaveBeenCalled();
  });

  it("交接进行中（service.handingOff）时让行，不递归触发", async () => {
    const { service, migrate } = stubService({ handingOff: true });
    const resolveMode = vi.fn(async () => "self" as const);

    await goIdle(createPlugin({ service, resolveMode }), {
      promptTokens: MAX_HANDOFF_TOKENS + 1,
    });

    expect(resolveMode).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("交接失败不让 onIdle 抛错（失败走日志 + 失败回声）", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new Error("boom"));

    await expect(
      goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS + 1 }),
    ).resolves.toBeUndefined();
  });

  it("agent 已关门（AgentError closed）时不报错、也不降级 summary", async () => {
    const { service, migrate } = stubService();
    const errors: string[] = [];
    setLogger({ info: () => {}, warn: () => {}, error: (m) => errors.push(m) });
    try {
      migrate.mockRejectedValueOnce(
        new (await import("@ai-zen/agents-core")).AgentError("closed", "往已经关了的 agent 投递"),
      );
      await goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS + 1 });
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    // 会话已经没了：既不该记一条「迁移失败」，也不该再走一轮 summary
    expect(errors).toEqual([]);
  });

  it("交接成功之后才回声（onMigrated 带上实际执行者与用量）", async () => {
    const { service, migrate } = stubService();
    migrate.mockResolvedValueOnce({ mode: "summary" } as any);
    const onMigrated = vi.fn(async () => {});

    await goIdle(
      new AutoMigratePlugin({
        service,
        handoffTokens: MAX_HANDOFF_TOKENS,
        resolveMode: async () => "self" as const,
        onMigrated,
      }),
      { promptTokens: MAX_HANDOFF_TOKENS + 1 },
    );

    // 实际用的是降级后的 `summary`（服务返回的 ctx 说的）：回声报事实，不报「请求的那个」
    expect(onMigrated).toHaveBeenCalledWith({
      promptTokens: MAX_HANDOFF_TOKENS + 1,
      handoffTokens: MAX_HANDOFF_TOKENS,
      mode: "summary",
    });
  });

  it("交接失败时没有「压过了」的回声，但有一条失败回声（宿主据此把闸开回来）", async () => {
    const { service, migrate } = stubService();
    const boom = new Error("boom");
    migrate.mockRejectedValueOnce(boom);
    const onMigrated = vi.fn(async () => {});
    const onFailed = vi.fn(async () => {});
    setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    try {
      await goIdle(
        new AutoMigratePlugin({
          service,
          handoffTokens: MAX_HANDOFF_TOKENS,
          resolveMode: async () => "self" as const,
          onMigrated,
          onFailed,
        }),
        { promptTokens: MAX_HANDOFF_TOKENS + 1 },
      );
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    expect(onMigrated).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith({
      promptTokens: MAX_HANDOFF_TOKENS + 1,
      handoffTokens: MAX_HANDOFF_TOKENS,
      error: boom,
    });
  });

  it("用户取消不算失败：两条回声都不叫", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new HandoffAbortedError());
    const onMigrated = vi.fn(async () => {});
    const onFailed = vi.fn(async () => {});
    setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    try {
      await goIdle(
        new AutoMigratePlugin({
          service,
          handoffTokens: MAX_HANDOFF_TOKENS,
          resolveMode: async () => "self" as const,
          onMigrated,
          onFailed,
        }),
        { promptTokens: MAX_HANDOFF_TOKENS + 1 },
      );
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    expect(onMigrated).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("回声自己抛错不接：onMigrated 崩了就在这次 onIdle 里炸出来", async () => {
    // 写钩子的是宿主：它写崩了该在自己的调用栈里看到，而不是被吞成一行日志
    const { service, migrate } = stubService();
    migrate.mockResolvedValueOnce({ mode: "self" } as any);

    await expect(
      goIdle(
        new AutoMigratePlugin({
          service,
          handoffTokens: MAX_HANDOFF_TOKENS,
          resolveMode: async () => "self" as const,
          onMigrated: async () => {
            throw new Error("db down");
          },
        }),
        { promptTokens: MAX_HANDOFF_TOKENS + 1 },
      ),
    ).rejects.toThrow("db down");

    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("失败回声自己抛错也不接：那是「把闸开回来」的唯一一道门", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new Error("boom"));
    setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    try {
      await expect(
        goIdle(
          new AutoMigratePlugin({
            service,
            handoffTokens: MAX_HANDOFF_TOKENS,
            resolveMode: async () => "self" as const,
            onFailed: async () => {
              throw new Error("闸没打开");
            },
          }),
          { promptTokens: MAX_HANDOFF_TOKENS + 1 },
        ),
      ).rejects.toThrow("闸没打开");
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }
  });

  it("用户取消不记 error 日志（默认 logger 是 console.error，TUI 下会撕画面）", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new HandoffAbortedError());
    const errors: string[] = [];
    // 全局 logger 是模块级状态：必须在 finally 里复原，否则本文件的其它用例会继承它
    setLogger({ info: () => {}, warn: () => {}, error: (m) => errors.push(m) });
    try {
      await goIdle(createPlugin({ service }), { promptTokens: MAX_HANDOFF_TOKENS + 1 });
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    expect(errors).toEqual([]);
  });

  /**
   * 钩子真的落在 `onIdle` 上吗？—— 上面那些用例都是手喂 ctx，这条用**真 Agent 跑一圈**：
   * 起 → 投 → 等闲。跑到「闲」的那一刻 core 会分发 `onIdle`，插件应当在那时交接。
   */
  it("真跑一轮：agent 变闲时自动触发交接", async () => {
    // 流的最后一片带 usage：core 跑流时把它钉到那条 assistant 消息上，插件从消息上读
    const stream = [
      {
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      },
      {
        id: "c2",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: MAX_HANDOFF_TOKENS + 1, completion_tokens: 1, total_tokens: 1 },
      },
    ];
    const agent = new Agent({
      client: {
        chat: {
          completions: {
            create: vi.fn(async () => ({
              async *[Symbol.asyncIterator]() {
                for (const chunk of stream) yield chunk;
              },
            })),
          },
        },
      } as any,
      model: "test-model",
    });
    const { service, migrate } = stubService();
    agent.use(createPlugin({ service }));

    await sendRound(agent, "hi");

    // 上一轮 prompt_tokens 超线 → 闲下来（`onIdle`）就该交接
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});
