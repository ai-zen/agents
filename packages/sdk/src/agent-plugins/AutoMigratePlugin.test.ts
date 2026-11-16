import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "@ai-zen/agents-core";
import { AutoMigratePlugin } from "./AutoMigratePlugin.js";
import { HandoffAbortedError } from "../runtime/HandoffService.js";
import type { HandoffService } from "../runtime/HandoffService.js";
import { setLogger } from "../shared/logger.js";
import { sendRound } from "../test-support/agent-round.js";

const MAX_HANDOFF_TOKENS = 50_000;

/** 最小服务替身：只暴露插件用到的 `busy` 与 `migrate` */
function stubService(options: { busy?: boolean } = {}) {
  const migrate = vi.fn(async () => ({}) as any);
  const service = { busy: options.busy ?? false, migrate } as unknown as HandoffService;
  return { service, migrate };
}

/**
 * 让插件「闲下来」。
 *
 * 插件落在 `onIdle`（`send()` / `onAfterSend` 都已经不存在了），而 `onIdle()` 不带 ctx
 * —— 插件是在 `onOuterLoopStart` 里认领 agent 的。所以触发一次 idle 要先喂它一个外循环
 * ctx：这里给的就是「一个只有 lastUsage 的 agent」。
 */
async function goIdle(plugin: AutoMigratePlugin, promptTokens?: number): Promise<void> {
  plugin.onOuterLoopStart({
    agent: {
      lastUsage:
        promptTokens == null
          ? undefined
          : {
              prompt_tokens: promptTokens,
              completion_tokens: 1,
              total_tokens: promptTokens + 1,
            },
    },
    entries: [],
  } as any);
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

  it("无 usage 数据时不迁移", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }));
    expect(migrate).not.toHaveBeenCalled();
  });

  it("promptTokens <= handoffTokens 时不迁移", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }), MAX_HANDOFF_TOKENS);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("超阈值时委托 service.migrate，并透传用量", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }), MAX_HANDOFF_TOKENS + 1);

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: MAX_HANDOFF_TOKENS + 1,
        handoffTokens: MAX_HANDOFF_TOKENS,
      }),
    );
  });

  it("未提供 resolveMode 时不指定执行者（由服务默认值决定）", async () => {
    const { service, migrate } = stubService();
    await goIdle(createPlugin({ service }), MAX_HANDOFF_TOKENS + 1);

    expect((migrate.mock.calls[0] as any[])[0].mode).toBeUndefined();
  });

  it("resolveMode 返回的执行者被透传给 service.migrate", async () => {
    const { service, migrate } = stubService();
    const resolveMode = vi.fn(async () => "summary" as const);

    await goIdle(createPlugin({ service, resolveMode }), MAX_HANDOFF_TOKENS + 1);

    expect(resolveMode).toHaveBeenCalledWith({
      promptTokens: MAX_HANDOFF_TOKENS + 1,
      handoffTokens: MAX_HANDOFF_TOKENS,
    });
    expect((migrate.mock.calls[0] as any[])[0].mode).toBe("summary");
  });

  it("resolveMode 返回 null 时跳过本次迁移", async () => {
    const { service, migrate } = stubService();
    const resolveMode = vi.fn(async () => null);

    await goIdle(createPlugin({ service, resolveMode }), MAX_HANDOFF_TOKENS + 1);

    expect(migrate).not.toHaveBeenCalled();
  });

  it("交接进行中（service.busy）时让行，不递归触发", async () => {
    const { service, migrate } = stubService({ busy: true });
    const resolveMode = vi.fn(async () => "self" as const);

    await goIdle(createPlugin({ service, resolveMode }), MAX_HANDOFF_TOKENS + 1);

    expect(resolveMode).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("迁移失败被吞掉（不让 onIdle 抛错）", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new Error("boom"));

    await expect(
      goIdle(createPlugin({ service }), MAX_HANDOFF_TOKENS + 1),
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
      await goIdle(createPlugin({ service }), MAX_HANDOFF_TOKENS + 1);
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    // 会话已经没了：既不该记一条「迁移失败」，也不该再走一轮 summary
    expect(errors).toEqual([]);
  });

  it("迁移成功之后才回声（onMigrated 带上实际执行者与用量）", async () => {
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
      MAX_HANDOFF_TOKENS + 1,
    );

    // 实际用的是降级后的 `summary`：回声报事实，不报「请求的那个」
    expect(onMigrated).toHaveBeenCalledWith({
      promptTokens: MAX_HANDOFF_TOKENS + 1,
      handoffTokens: MAX_HANDOFF_TOKENS,
      mode: "summary",
    });
  });

  it("迁移失败时没有回声（没压成就不该记「压过了」）", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new Error("boom"));
    const onMigrated = vi.fn(async () => {});
    setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    try {
      await goIdle(
        new AutoMigratePlugin({
          service,
          handoffTokens: MAX_HANDOFF_TOKENS,
          resolveMode: async () => "self" as const,
          onMigrated,
        }),
        MAX_HANDOFF_TOKENS + 1,
      );
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    expect(onMigrated).not.toHaveBeenCalled();
  });

  it("回声自己抛错不影响迁移（只记日志）", async () => {
    const { service, migrate } = stubService();
    const errors: string[] = [];
    setLogger({ info: () => {}, warn: () => {}, error: (m) => errors.push(m) });
    try {
      await goIdle(
        new AutoMigratePlugin({
          service,
          handoffTokens: MAX_HANDOFF_TOKENS,
          resolveMode: async () => "self" as const,
          onMigrated: async () => {
            throw new Error("db down");
          },
        }),
        MAX_HANDOFF_TOKENS + 1,
      );
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(errors.some((line) => line.includes("onMigrated"))).toBe(true);
  });

  it("用户取消不记 error 日志（默认 logger 是 console.error，TUI 下会撕画面）", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new HandoffAbortedError());
    const errors: string[] = [];
    // 全局 logger 是模块级状态：必须在 finally 里复原，否则本文件的其它用例会继承它
    setLogger({ info: () => {}, warn: () => {}, error: (m) => errors.push(m) });
    try {
      await goIdle(createPlugin({ service }), MAX_HANDOFF_TOKENS + 1);
    } finally {
      setLogger({ info: console.log, warn: console.warn, error: console.error });
    }

    expect(errors).toEqual([]);
  });

  /**
   * 钩子真的落在 `onIdle` 上吗？—— 上面那些用例都是手喂 ctx，这条用**真 Agent 跑一圈**：
   * 起 → 投 → 等闲。跑到「闲」的那一刻 core 会分发 `onIdle`，插件应当在那时迁移。
   */
  it("真跑一轮：agent 变闲时自动触发迁移", async () => {
    // 流的最后一片带 usage（`applyChunk` 会把它钉到 assistant 消息上 → `lastUsage` 派生出来）
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

    // 上一轮 prompt_tokens 超线 → 闲下来（`onIdle`）就该迁移
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});
