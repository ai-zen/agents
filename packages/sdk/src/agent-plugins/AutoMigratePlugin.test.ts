import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoMigratePlugin } from "./AutoMigratePlugin.js";
import type { HandoffService } from "../runtime/HandoffService.js";

const MAX_HANDOFF_TOKENS = 50_000;

/** 最小服务替身：只暴露插件用到的 `busy` 与 `migrate` */
function stubService(options: { busy?: boolean } = {}) {
  const migrate = vi.fn(async () => ({}) as any);
  const service = { busy: options.busy ?? false, migrate } as unknown as HandoffService;
  return { service, migrate };
}

/** 构造 SendContext 的最小表面：插件只读 agent.lastUsage */
function buildCtx(promptTokens?: number): any {
  return {
    agent: {
      lastUsage:
        promptTokens == null
          ? undefined
          : { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
    },
    content: "hello",
    messages: [],
  };
}

function createPlugin(options: {
  service: HandoffService;
  resolveMode?: any;
}): AutoMigratePlugin {
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

  it("返回一个 AgentPlugin（有 onAfterSend）", () => {
    const { service } = stubService();
    expect(typeof createPlugin({ service }).onAfterSend).toBe("function");
  });

  it("无 usage 数据时不迁移", async () => {
    const { service, migrate } = stubService();
    await createPlugin({ service }).onAfterSend(buildCtx());
    expect(migrate).not.toHaveBeenCalled();
  });

  it("promptTokens <= handoffTokens 时不迁移", async () => {
    const { service, migrate } = stubService();
    await createPlugin({ service }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS));
    expect(migrate).not.toHaveBeenCalled();
  });

  it("超阈值时委托 service.migrate，并透传用量", async () => {
    const { service, migrate } = stubService();
    await createPlugin({ service }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS + 1));

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: MAX_HANDOFF_TOKENS + 1, handoffTokens: MAX_HANDOFF_TOKENS }),
    );
  });

  it("未提供 resolveMode 时不指定执行者（由服务默认值决定）", async () => {
    const { service, migrate } = stubService();
    await createPlugin({ service }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS + 1));

    expect(migrate.mock.calls[0][0].mode).toBeUndefined();
  });

  it("resolveMode 返回的执行者被透传给 service.migrate", async () => {
    const { service, migrate } = stubService();
    const resolveMode = vi.fn(async () => "summary" as const);

    await createPlugin({ service, resolveMode }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS + 1));

    expect(resolveMode).toHaveBeenCalledWith({
      promptTokens: MAX_HANDOFF_TOKENS + 1,
      handoffTokens: MAX_HANDOFF_TOKENS,
    });
    expect(migrate.mock.calls[0][0].mode).toBe("summary");
  });

  it("resolveMode 返回 null 时跳过本次迁移", async () => {
    const { service, migrate } = stubService();
    const resolveMode = vi.fn(async () => null);

    await createPlugin({ service, resolveMode }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS + 1));

    expect(migrate).not.toHaveBeenCalled();
  });

  it("交接进行中（service.busy）时让行，不递归触发", async () => {
    const { service, migrate } = stubService({ busy: true });
    const resolveMode = vi.fn(async () => "self" as const);

    await createPlugin({ service, resolveMode }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS + 1));

    expect(resolveMode).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("迁移失败被吞掉（不向 send 抛错）", async () => {
    const { service, migrate } = stubService();
    migrate.mockRejectedValueOnce(new Error("boom"));

    await expect(
      createPlugin({ service }).onAfterSend(buildCtx(MAX_HANDOFF_TOKENS + 1)),
    ).resolves.toBeUndefined();
  });
});
