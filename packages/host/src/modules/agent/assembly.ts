import { AgentNS } from "@ai-zen/agents-core";
import {
  createAgent,
  resolveModel,
  type AgentDefinition,
  type ModelParams,
  type SdkAgent,
} from "@ai-zen/agents-sdk";

import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { ScopeRegistry } from "../scope/registry.js";
import type { messageTable } from "../session/messages.js";
import type { Session } from "../session/types.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { inboxTable } from "./inbox.js";

export interface AssemblyDeps {
  readonly scopes: ScopeRegistry;
  readonly workspaces: WorkspaceService;
  readonly messages: ReturnType<typeof messageTable>;
  readonly inbox: ReturnType<typeof inboxTable>;
  readonly config: GeneralConfig;
  readonly definitions: AgentDefinitionService;
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 按库里的事实把这段会话的执行体造出来。历史要先装好，再把还没取走的条目放回队列。
 *
 * 返回的是 `SdkAgent` 而不是 core 的 `Agent`：`createAgent` 造的就是它，写宽了只是把 `scope`
 * 与 `definition` 藏起来 —— 交接要在定义上的模板与这一段的能力容器上做事，拿不到就得去借。
 *
 * 模型的三级解析（会话行 > 助手定义 > 全局兜底）不在这一层重做一遍：`createAgent` 里是唯一
 * 实现，这里只把会话行那一级的覆盖递进去。三级全空时它报错并带上助手 id，不静默挑一个。
 * 唯一一处例外在参数那边：要读档位表得先知道生效的是哪个模型，那里调的是同一个
 * `resolveModel`，不是另写一遍选择链。
 */
export async function assemble(deps: AssemblyDeps, session: Session): Promise<SdkAgent> {
  // 修与读是同一次读取：要判出「哪几条是上一个进程没写完的」，只能先把行拿出来。读一遍、
  // 就地改、只写回改过的那几行；读两遍的话，「库里那份」与「装进 agent 那份」会落在两次
  // 读取之间，整段历史也多读一遍。
  //
  // 这一段要连 `hidden` 的一起取：那些消息只是不给人看，模型照样得看到。
  const history = deps.messages.listBySession(session.id);

  const interrupted = history.filter(
    (message) =>
      message.status === AgentNS.MessageStatus.Pending ||
      message.status === AgentNS.MessageStatus.Writing,
  );
  if (interrupted.length > 0) {
    // 引擎修历史时只认 `aborted`：留着 pending / writing，那几条既进不了请求，界面上也永远
    // 停在「正在写」。进程是在写它们的时候没的，这件事只有装载这一刻知道。
    for (const message of interrupted) message.status = AgentNS.MessageStatus.Aborted;
    try {
      deps.messages.upsertMany(session.id, interrupted);
    } catch (error) {
      // 写不回去就不写：修的是同一格事实，下一次装载会再修一遍（幂等）。为一条状态列
      // 让整段会话打不开，代价比它大。
      deps.onError(error, "write back interrupted messages");
    }
  }

  const workspace = deps.workspaces.get(session.workspaceId);
  if (workspace === undefined) {
    throw new Error(
      `Cannot assemble session "${session.id}": workspace "${session.workspaceId}" does not exist`,
    );
  }

  // 删助手不看还有几段会话在用它，所以这段会话的助手可能已经不在了。SDK 那一层只会抛出
  // 一句英文的 `Agent "x" not found`，它带不上 `not_found` 这个码；先取一次，缺了就是一条
  // 客户端认得出的失败。取到的这一份下面还要用：助手定义的 `modelParams` 是档位补丁叠在
  // 它上面的那一层。
  const definition = await deps.definitions.get(session.agentId);

  const scope = await deps.scopes.for(workspace.cwd);

  const modelParams = await modelParamsFor(deps, session, definition);

  const agent = await createAgent(scope, session.agentId, {
    // 把解析出来的生效模型**显式**递进去，而不是让 SDK 再按三级链算一遍。原因是 SDK 那一层
    // 「参数不跨级混合」：`modelParams` 只在模型来自会话行时才被用上，模型来自助手定义或全局
    // 兜底时整份会被忽略。而档位补丁正是叠在这份参数上的，不显式说明生效模型，用户只改档位、
    // 没换过模型（最常见的那一种）就一点都不生效。
    //
    // 解析本身仍然只有一处实现：`resolveModel` 是 SDK 导出的那个函数，这里只是把它的结果讲明。
    modelId: resolveModel({
      sessionModelId: session.modelId ?? undefined,
      agentModelId: definition.modelId,
      defaultModel: deps.config.read().defaultModel,
    })?.modelId,
    modelParams,
  });

  // `createAgent` 已经装好了助手定义里的模板消息（系统提示就在其中），这里装的历史接在它们
  // 后面 —— 不是「整份记忆」。
  //
  // 一条一条追加，不给 `agent.messages` 整体赋值：那个数组是记忆的唯一真相，换掉数组会让
  // 已经拿到它引用的地方（插件的钩子上下文、正在进行的那次请求）继续指着旧的那一份。
  for (const message of history) agent.append(message);

  // 放回队列排在装历史之后：一条条目落过地没有，判据是它那条消息在不在已经装好的历史里。
  // 反过来排，这个判据就得另找一份账。
  const landed = new Set(history.map((message) => message.id));
  const consumed: string[] = [];
  const waiting: AgentNS.InboxEntryWithContent[] = [];
  for (const entry of deps.inbox.listBySession(session.id)) {
    if (entry.messageId !== undefined && landed.has(entry.messageId))
      consumed.push(entry.messageId);
    else waiting.push(entry);
  }

  deps.inbox.deleteMany(consumed);
  agent.restore(waiting);

  return agent;
}

/**
 * 这一段会话的请求参数：助手定义上那份在下，思考档位的补丁在上。
 *
 * 档位名是客户端的选择，请求参数是厂商的方言，两者之间只有档位表能翻译 —— 表由生效模型的
 * `reasoningPreset` 指过来（同一张表还决定客户端能选哪几档）。三种情况都不叠补丁、只留定义
 * 那份：会话没选档位（`null` 表示跟随定义）、模型没挂档位表、档位名不在表里（客户端与磁盘上
 * 那份表不是同一版）。
 *
 * 模型用 `resolveModel` 取：档位属于生效的那个模型，会话换过模型时拿定义上那个会读错表。
 */
async function modelParamsFor(
  deps: AssemblyDeps,
  session: Session,
  definition: AgentDefinition,
): Promise<ModelParams | undefined> {
  const params: ModelParams = { ...definition.modelParams };
  const level = session.thinkingLevel;

  if (level !== null) {
    const config = deps.config.read();
    const resolved = resolveModel({
      sessionModelId: session.modelId ?? undefined,
      agentModelId: definition.modelId,
      defaultModel: config.defaultModel,
    });
    const presetName = config.models?.find(
      (model) => model.id === resolved?.modelId,
    )?.reasoningPreset;

    if (presetName !== undefined) {
      const patch = (await deps.config.presets())[presetName]?.levels[level];
      if (patch !== undefined) Object.assign(params, patch);
    }
  }

  return Object.keys(params).length > 0 ? params : undefined;
}
