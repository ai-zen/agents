import type { AgentPlugin } from "../runtime/sdk-agent.js";

/**
 * 自动刷新能力插件：每次 send 前重新扫描文件系统，
 * 刷新内置工具、用户工具、Skill、SubAgent、MCP 等候选集，
 * 并重新按权限过滤和实例化工具列表。
 *
 * 对话过程中文件系统可能发生变化（新增 skill、工具文件、sub-agent），
 * 此插件确保 LLM 能看到最新的可用能力。
 *
 * ```ts
 * agent.use(autoRefreshTools());
 * await agent.init();
 * ```
 */
export function autoRefreshTools(): AgentPlugin {
  return {
    onBeforeSend: async (ctx) => {
      const { agent } = ctx;

      // caps 不存在（非 SdkAgent）时跳过
      if (!agent.caps) return;

      // 1. 重新扫描文件系统
      agent.caps.refresh();

      // 2. 重新按权限过滤并实例化工具
      agent.tools = agent.caps.buildTools(agent.permissions ?? {}, {
        exclude: {
          subagents: agent.definition.function?.name
            ? [agent.definition.function.name]
            : undefined,
        },
      });
    },
  };
}
