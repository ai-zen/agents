import type { AgentRuntime, WakeMaterials } from "@ai-zen/agents-sdk";

import type { SessionService } from "../session/service.js";
import type { Session } from "../session/types.js";
import type { WorkspaceService } from "../workspace/service.js";

export interface ReloadDefinitionDeps {
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly runtime: AgentRuntime;
  /** 材料由调用方现造（`materialsFor`）：它要读历史、排队区与配置，只有装配根凑得齐 */
  readonly materials: (session: Session) => Promise<WakeMaterials>;
  /** 一段装不起来时记一句的去处（宿主日志）：一段的失败不该变成整次调用的失败 */
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 一个定义改过之后，把用着它的那几段活着的执行体重装一遍，返回被重装的会话 id。
 *
 * **为什么必须重装而不是就地刷新**：系统提示是建造执行体的材料（`createAgent` 把模板拼在历史
 * 最前面），它不在执行体的可变字段里 —— 这段会话的记忆一装好就带着旧提示词，改完之后旧执行体
 * 接着跑，等于用户改的东西没生效。
 *
 * **为什么先取材料再杀**：材料要读那段会话的排队区，而杀会把排队区作废（「换掉 agent 不丢
 * inbox」是这条需求的前提，见 `05-control.md` 的「换模型不是杀死」）。反过来排的话，杀完再去
 * 取材料，没被处理的那几句就在这一次改动里丢了。
 *
 * **为什么正在写的那一条会断**：重装就是掐掉在途 —— 需求原话是「正在写的内容会断」
 * （`05-control.md` 的「全局改」）。这是给用户看二次确认时要说的代价，不是这里的缺陷。
 *
 * 没有执行体的会话（重启之后都是这一种）不在名单里：它们下一次被装起来时读到的已经是新定义。
 *
 * 装不起来的**一段**不连累其余几段：逐段接住，交给 `onError`，返回的列表只含装成了的。
 */
export async function reloadDefinition(
  deps: ReloadDefinitionDeps,
  agentId: string,
): Promise<string[]> {
  const reloaded: string[] = [];

  for (const workspace of deps.workspaces.list()) {
    for (const session of deps.sessions.list(workspace.id)) {
      if (session.agentId !== agentId) continue;
      if (deps.runtime.get(session.id) === undefined) continue;

      try {
        const materials = await deps.materials(session);
        deps.runtime.kill(session.id);
        await deps.runtime.wake(session.id, materials);
        reloaded.push(session.id);
      } catch (error) {
        deps.onError(
          error,
          `Cannot reload the definition "${agentId}" for session "${session.id}"`,
        );
      }
    }
  }

  return reloaded;
}
