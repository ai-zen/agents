import type { AgentPlugin, SendContext } from "@ai-zen/agents-core";
import type { SdkAgent } from "../runtime/SdkAgent.js";

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
    const agent = ctx.agent as SdkAgent;

    await agent.provider.refresh({ silent: true });

    agent.tools = agent.provider.buildTools(agent.definition, {
      exclude: {
        subagents: agent.definition.function?.name
          ? [agent.definition.function.name]
          : undefined,
      },
    });
  }
}
