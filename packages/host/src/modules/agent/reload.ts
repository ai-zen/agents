import type { AgentRuntime, WakeMaterials } from "@ai-zen/agents-sdk";

import type { SessionService } from "../session/service.js";
import type { SessionRecord } from "../session/types.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { ReloadWindow } from "./reload-window.js";

export interface ReloadDefinitionDeps {
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly runtime: AgentRuntime;
  /** 材料由调用方现造（`materialsFor`）：它要读历史、排队区与配置，只有装配根凑得齐 */
  readonly materials: (session: SessionRecord) => Promise<WakeMaterials>;
  /**
   * 正在重装的那几段会话。观察者读的是同一份：它在窗口里收到的 `inboxCleared` 不作废库里那几行
   */
  readonly reloads: ReloadWindow;
  /** 一段装不起来时记一句的去处（宿主日志）：一段的失败不该变成整次调用的失败 */
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 一个定义改过之后，把用着它的那几段活着的 Agent 重装一遍，返回被重装的会话 id。
 *
 * **为什么必须重装而不是就地刷新**：系统提示是建造 Agent 的材料（`createAgent` 把模板拼在历史
 * 最前面），它不在 Agent 的可变字段里 —— 这段会话的记忆一装好就带着旧提示词，改完之后旧 Agent
 * 接着跑，等于用户改的东西没生效。
 *
 * **为什么先取材料再杀**：材料要读那段会话的排队区，而杀会把排队区作废（「换掉 agent 不丢
 * inbox」是这条需求的前提，见 `05-control.md` 的「换模型不是杀死」）。反过来排的话，杀完再去
 * 取材料，没被处理的那几句就在这一次改动里丢了。
 *
 * **为什么杀与装之间要立一个窗口**（`ReloadWindow`）：抢在杀之前取的材料只让「内存里那一份」
 * 不丢，库里那一份还要过一道关 —— 杀报出的 `inboxCleared` 会让观察者把这段会话在 `inbox` 表里
 * 的行删掉，而装回来时放回队列那一步（core 的 `restore`）刻意不报 `inboxAdded`（放回去不是新变化），
 * 于是库里那几行再也回不来：内存里还排着，进程一重启就没了。窗口立起来之后那一次清空不作废库里
 * 那几行，`materials` 交上来的 `waiting` 又被原样放回队列，两边说的是同一批 InboxEntry。
 *
 * **为什么正在写的那一条会断**：重装就是掐掉在途 —— 需求原话是「正在写的内容会断」
 * （`05-control.md` 的「全局改」）。这是给用户看二次确认时要说的代价，不是这里的缺陷。
 *
 * **输出开关要跟着会话留下来**：开关是用户的决定，不属于 Agent，换一个 Agent 不该把它改掉。所以
 * 杀之前先读下这一格、装好之后按读到的关回去。这一格长在旧 Agent 的队列上，跟着杀一起没了，
 * 读的地方因此只能在杀之前。输入开关与忙闲不在此列 —— 它们是新 Agent 自己的观测值。
 *
 * 没有 Agent 的会话（重启之后都是这一种）不在名单里：它们下一次被装起来时读到的已经是新定义。
 *
 * 装不起来的**一段**不连累其余几段：逐段接住，交给 `onError`，返回的列表只含装成了的。装不起来
 * 的那一段会话连 Agent 都没有，也就谈不上还欠它一次关开关 —— 失败只报一次。
 */
export async function reloadDefinition(
  deps: ReloadDefinitionDeps,
  agentId: string,
): Promise<string[]> {
  const reloaded: string[] = [];

  for (const workspace of deps.workspaces.list()) {
    for (const session of deps.sessions.list(workspace.id)) {
      if (session.agentId !== agentId) continue;
      const running = deps.runtime.get(session.id);
      if (running === undefined) continue;

      try {
        const materials = await deps.materials(session);
        // 现读输出开关，读在杀之前：它长在旧 Agent 的队列上，杀完就一并没了
        const outputPaused = running.isOutputPaused;
        // 窗口只罩住杀与装：取材料那一步要删掉的是「已经落过地」的 InboxEntry（`materialsFor` 做的），
        // 那几条本来就该没了，与这一次清空无关
        deps.reloads.enter(session.id);
        try {
          deps.runtime.kill(session.id);
          const agent = await deps.runtime.wake(session.id, materials);
          // 只关输出开关：新 Agent 的输入开关与忙闲是它自己的观测值，不替用户改
          if (outputPaused) agent.pauseOutput();
        } finally {
          // 装不起来也要退出去：窗口留着关不掉的话，这段会话此后每一次真的被杀死都不再作废
          // 库里那几行
          deps.reloads.leave(session.id);
        }
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
