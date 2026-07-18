import type { AgentPlugin, SendContext } from "../runtime/SdkAgent.js";

/**
 * 自动刷新能力插件。
 *
 * ```ts
 * agent.use(new AutoRefreshToolsPlugin());
 * await agent.init();
 * ```
 */
export class AutoRefreshToolsPlugin implements AgentPlugin {
  async onBeforeSend(ctx: SendContext): Promise<void> {
    const { agent } = ctx;

    if (!agent.caps) return;

    agent.caps.refresh();

    agent.tools = agent.caps.buildTools(agent.permissions ?? {}, {
      exclude: {
        subagents: agent.definition.function?.name
          ? [agent.definition.function.name]
          : undefined,
      },
    });
  }
}
