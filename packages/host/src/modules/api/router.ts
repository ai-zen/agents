import { agentRouter } from "./agent.js";
import { agentDefinitionRouter } from "./agentDefinition.js";
import { assetRouter } from "./asset.js";
import { configRouter } from "./config.js";
import type { HostApiDeps } from "./deps.js";
import { eventsProcedure } from "./events.js";
import { handoffRouter } from "./handoff.js";
import { mcpRouter } from "./mcp.js";
import { noticeRouter } from "./notice.js";
import { questionRouter } from "./question.js";
import { searchRouter } from "./search.js";
import { sessionRouter } from "./session.js";
import { createTrpc } from "./trpc.js";
import { workspaceRouter } from "./workspace.js";

/**
 * 契约。每个 procedure 的入参与出参都写在各自的 `.input()` / `.output()` 上，这里只合名字。
 *
 * `events` 是单段路径：它是一条流，不属于某个域的「动作」集合。
 */
export function createAppRouter(deps: HostApiDeps) {
  // tRPC 的根在这里建：失败出网那一层要读翻译函数，而 `t` 只有装配根上有。
  const api = createTrpc(deps.t);

  return api.router({
    session: sessionRouter(deps, api),
    workspace: workspaceRouter(deps, api),
    agent: agentRouter(deps, api),
    asset: assetRouter(deps, api),
    notice: noticeRouter(deps, api),
    question: questionRouter(deps, api),
    handoff: handoffRouter(deps, api),
    search: searchRouter(deps, api),
    config: configRouter(deps, api),
    mcp: mcpRouter(deps, api),
    agentDefinition: agentDefinitionRouter(deps, api),
    events: eventsProcedure(deps, api),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
