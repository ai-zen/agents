import type { AgentPlugin, SendContext } from "@ai-zen/agents-core";
import type { SdkAgent } from "../runtime/SdkAgent.js";

/**
 * 自动刷新能力的时机。
 *
 * 三个档位是**开销与时效**的取舍，没有对错：
 *
 * | 档位 | 钩子 | 会话中新装的 MCP / skill / 工具什么时候能被模型看见 |
 * |------|------|---------------------------------------------|
 * | `inner-loop-start` | `onInnerLoopStart`（每次请求发出前） | 同一轮里下一次请求就看见（含工具回合的空档） |
 * | `outer-loop-start` | `onBeforeSend`（整个 `send()` 开头） | 下一轮对话才看见；一轮只刷一次，开销最小 |
 * | `off` | 不装插件 | 只靠 `/reload` |
 *
 * 为什么不是「每轮固定刷一次」：一次 `refresh()` 会重扫 MCP 配置、按需建连接，
 * 长工具链的一轮里可能要跑好几次。默认取 `inner-loop-start` 是为了与旧版行为等价
 * （旧版挂在 `onBeforeSend` 上，靠内循环反复触发达到同样效果），嫌慢可以调低。
 */
export type AutoRefreshWhen = "inner-loop-start" | "outer-loop-start";

/**
 * 自动刷新能力插件。
 *
 * ```ts
 * agent.use(new AutoRefreshToolsPlugin());                       // 默认按内循环刷
 * agent.use(new AutoRefreshToolsPlugin({ when: "outer-loop-start" }));
 * await agent.init();
 * ```
 *
 * 两件事必须成对做：先 `scope.refresh()` 重新发现，再按**新的**发现结果重建
 * `agent.tools` —— 只刷前者，模型看到的还是旧工具集。
 */
export class AutoRefreshToolsPlugin implements AgentPlugin {
  private readonly when: AutoRefreshWhen;

  constructor(options: { when?: AutoRefreshWhen } = {}) {
    this.when = options.when ?? "inner-loop-start";
  }

  /** 内循环开始（每次请求前）：能力变化在同一轮里就能生效 */
  async onInnerLoopStart(ctx: SendContext): Promise<void> {
    if (this.when !== "inner-loop-start") return;
    await refreshTools(ctx);
  }

  /** 外循环开始（整个 `send()` 一次）：最省，代价是要等到下一轮 */
  async onBeforeSend(ctx: SendContext): Promise<void> {
    if (this.when !== "outer-loop-start") return;
    await refreshTools(ctx);
  }
}

/** 重新发现 + 按新结果重建工具集（两个档位共用同一段，免得两处漂） */
async function refreshTools(ctx: SendContext): Promise<void> {
  const agent = ctx.agent as SdkAgent;

  await agent.scope.refresh({ silent: true });

  agent.tools = agent.scope.buildTools(agent.definition, {
    exclude: {
      subagents: agent.definition.function?.name ? [agent.definition.function.name] : undefined,
    },
  });
}
