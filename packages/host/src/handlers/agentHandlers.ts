/**
 * `agent.*` 的接线壳（F-B1…F-B7 / F-F5 / F-G3）。
 *
 * 与 `config.*` 同一套口径：入参直接交给服务，出参里的句子按这条连接的语言重渲染
 * （D8）。业务判断在 `services/AgentService.ts`。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { AgentService } from "../services/AgentService.js";
import { localizeLocalizedTexts } from "./configHandlers.js";

/** 本文件负责的方法名 */
export type AgentHandlerName =
  | "agent.list"
  | "agent.get"
  | "agent.create"
  | "agent.update"
  | "agent.delete"
  | "agent.setModel"
  | "agent.setThinking"
  | "agent.restoreFactory";

/** 本文件产出的 handler 表片段 */
export type AgentHandlers = Pick<HandlerTable, AgentHandlerName>;

/** 接线壳的依赖 */
export interface AgentHandlerDeps {
  agents: AgentService;
}

/** 造出 `agent.*` 的 handler 表 */
export function createAgentHandlers(deps: AgentHandlerDeps): AgentHandlers {
  return {
    "agent.list": async (context) =>
      localizeLocalizedTexts(await deps.agents.list(), context.connection.language),
    "agent.get": async (context) =>
      localizeLocalizedTexts(await deps.agents.get(context.params), context.connection.language),
    "agent.create": async (context) =>
      localizeLocalizedTexts(await deps.agents.create(context.params), context.connection.language),
    "agent.update": async (context) =>
      localizeLocalizedTexts(await deps.agents.update(context.params), context.connection.language),
    "agent.delete": async (context) =>
      localizeLocalizedTexts(await deps.agents.delete(context.params), context.connection.language),
    "agent.setModel": async (context) =>
      localizeLocalizedTexts(
        await deps.agents.setModel(context.params),
        context.connection.language,
      ),
    "agent.setThinking": async (context) =>
      localizeLocalizedTexts(
        await deps.agents.setThinking(context.params),
        context.connection.language,
      ),
    "agent.restoreFactory": async (context) =>
      localizeLocalizedTexts(
        await deps.agents.restoreFactory(context.params),
        context.connection.language,
      ),
  };
}
