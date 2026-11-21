import {
  AgentNS,
  reconcileAbortedMessages,
  reconcileAbortedToolRounds,
} from "@ai-zen/agents-core";
import {
  AutoMigratePlugin,
  createAgent,
  resolveModel,
  type AgentDefinition,
  type ModelParams,
  type SdkAgent,
} from "@ai-zen/agents-sdk";

import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { HandoffService } from "../handoff/service.js";
import type { ScopeRegistry } from "../scope/registry.js";
import type { messageTable } from "../session/messages.js";
import type { SessionService } from "../session/service.js";
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
  /** 阈值与自动交接开关在越线那一刻从会话行现读：那两格改了不重建执行体 */
  readonly sessions: SessionService;
  /** 自动交接发起的那一趟：它与手动交接共用交接态、取消口与落库 */
  readonly handoff: HandoffService;
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 按库里的事实把这段会话的执行体造出来。历史要先装好，再把还没取走的条目放回队列。
 *
 * 返回的是 `SdkAgent` 而不是 core 的 `Agent`：`createAgent` 造的就是它，写宽了只是把 `scope`
 * 与 `definition` 藏起来 —— 交接要在定义上的模板与这一段的能力容器上做事，拿不到就得去借。
 *
 * 模型的三级解析（会话行 > 助手定义 > 全局兜底）不在这一层重做一遍：选择链只有 SDK 的
 * `resolveModel` 一处实现，这里调它拿到生效的那个模型，再把同一个结果递给 `createAgent`。
 * 多这一步是因为自动交接的阈值长在生效模型的配置上：解析不出模型、或那个模型已经不在配置里，
 * 这一段就装不出来 —— 与项目不存在同一类失败，一装配就断，不留给某次请求才炸。
 */
export async function assemble(deps: AssemblyDeps, session: Session): Promise<SdkAgent> {
  // 修与读是同一次读取：要判出「哪几条是上一个进程没写完的」，只能先把行拿出来。读一遍、
  // 就地改、只写回改过的那几行；读两遍的话，「库里那份」与「装进 agent 那份」会落在两次
  // 读取之间，整段历史也多读一遍。
  //
  // 这一段要连 `hidden` 的一起取：那些消息只是不给人看，模型照样得看到。
  const history = deps.messages.listBySession(session.id);

  // 序列化前后对比判「哪几条真的变了」。两个归一步骤就地在内存里改状态、补正文、删条目，
  // 没有返回值告诉外面它动过谁；把整段历史重写一遍则是把每一条都当成变了。
  const before = new Map(history.map((message) => [message.id, JSON.stringify(message)]));

  // 引擎修历史时只认 `aborted`：留着 pending / writing，那几条既进不了请求，界面上也永远
  // 停在「正在写」。进程是在写它们的时候没的，这件事只有装载这一刻知道。
  for (const message of history) {
    if (
      message.status === AgentNS.MessageStatus.Pending ||
      message.status === AgentNS.MessageStatus.Writing
    ) {
      message.status = AgentNS.MessageStatus.Aborted;
    }
  }

  // 两步的顺序照引擎那一处：先归工具轮次，再处置剩下的半截 assistant 消息。两者互相跳过对方
  // 管辖的消息，现在这两条实现上顺序反了结果一样；照它的顺序是为了两处不会各自漂移。
  //
  // 策略取自 `config` 上那两格：`AppConfig` 本来就有 `abortedMessageStrategy` 与
  // `abortedToolRoundStrategy`，引擎从同一个 `AppConfig`（`scope.config`）读，宿主不另立一档。
  // `abortedToolRoundReason` 不传：它不在 `AppConfig` 上，引擎那一侧走的也是函数的缺省值。
  const config = deps.config.read();
  const removed = [
    ...reconcileAbortedToolRounds(history, config.abortedToolRoundStrategy),
    ...reconcileAbortedMessages(history, config.abortedMessageStrategy),
  ];

  const changed = history.filter((message) => before.get(message.id) !== JSON.stringify(message));
  if (changed.length > 0 || removed.length > 0) {
    try {
      deps.messages.upsertMany(session.id, changed);
      // 被归一步骤删掉的那几条，库里那一行也要消失：留着它，用户会看见一条模型那边已经不存在
      // 的消息。平时这件事由 `AgentSubscription` 接 `messageRemoved` 做，而装载这一刻还没有
      // 订阅者。
      for (const message of removed) deps.messages.delete(message.id);
    } catch (error) {
      // 写不回去就不写：修的是同一格事实，下一次装载会再修一遍（幂等）。为一条状态列
      // 让整段会话打不开，代价比它大。
      deps.onError(error, "write back repaired messages");
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

  const resolved = resolveModel({
    sessionModelId: session.modelId ?? undefined,
    agentModelId: definition.modelId,
    defaultModel: config.defaultModel,
  });

  // 自动交接的阈值从这一份里取。缺了它 `createAgent` 也会拒掉同一件事，只是那一句话带不上
  // 是哪一段会话缺模型
  const model = config.models.find((item) => item.id === resolved?.modelId);
  if (model === undefined) {
    throw new Error(
      `Cannot assemble session "${session.id}": model "${resolved?.modelId}" is not in the config`,
    );
  }

  const agent = await createAgent(scope, session.agentId, {
    // 把解析出来的生效模型**显式**递进去，而不是让 SDK 再按三级链算一遍。原因是 SDK 那一层
    // 「参数不跨级混合」：`modelParams` 只在模型来自会话行时才被用上，模型来自助手定义或全局
    // 兜底时整份会被忽略。而档位补丁正是叠在这份参数上的，不显式说明生效模型，用户只改档位、
    // 没换过模型（最常见的那一种）就一点都不生效。
    //
    // 解析本身仍然只有一处实现：`resolveModel` 是 SDK 导出的那个函数，这里只是把它的结果讲明。
    modelId: resolved?.modelId,
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

  // 自动交接：装在这一段上，越线之后由插件自己发起。阈值与开关两格是取值函数而不是装配时
  // 算好的数 —— 改阈值、改开关都不重建执行体（`PRD.md` 4.7），装一次就等于把用户之后的选择
  // 钉死在装配那一刻。
  agent.use(
    new AutoMigratePlugin({
      service: deps.handoff.automatic(session),
      get handoffTokens(): number {
        return deps.sessions.get(session.id)?.handoffThreshold ?? model.tokenThresholds.handoff;
      },
      resolveMode: () => deps.handoff.automaticMode(session.id),
      // 闸只在这两拍开：关闸那一半在 SDK 的 `HandoffGuardPlugin`，开闸只有宿主知道什么时候该开
      // （记忆换完了 / 这一趟没成）。取消不走这里 —— 回滚之后就该停在那一段
      onMigrated: () => deps.handoff.finish(session.id),
      onFailed: ({ error }) => deps.handoff.finish(session.id, { error }),
    }),
  );

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
