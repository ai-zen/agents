import type { AgentNS } from "@ai-zen/agents-core";
import {
  AutoMigratePlugin,
  resolveModel,
  type AgentDefinition,
  type Model,
  type ModelParams,
  type ResolvedModel,
  type WakeMaterials,
} from "@ai-zen/agents-sdk";

import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { HandoffService } from "../handoff/service.js";
import type { messageTable } from "../session/messages.js";
import type { SessionService } from "../session/service.js";
import type { Session } from "../session/types.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { inboxTable } from "./inbox.js";

export interface MaterialsDeps {
  /** 项目行：`cwd` 从它上面取（能力容器按目录一份） */
  readonly workspaces: WorkspaceService;
  /** 助手定义：装哪一个、它绑的模型是三级解析的第二级 */
  readonly definitions: AgentDefinitionService;
  /** 现读的配置：`defaultModel`、模型表、思考档位表都在它上面 */
  readonly config: GeneralConfig;
  /** 历史（含 `hidden`）与排队区：这段会话此刻的全部材料 */
  readonly messages: ReturnType<typeof messageTable>;
  readonly inbox: ReturnType<typeof inboxTable>;
  /** 阈值与自动交接开关在越线那一刻从会话行现读：那两格改了不重建执行体 */
  readonly sessions: SessionService;
  /** 自动交接发起的那一趟：它与手动交接共用交接态、取消口与落库 */
  readonly handoff: HandoffService;
}

/**
 * 把一段会话装起来需要的**材料**从库里读出来，交给运行时 —— `wake(身份, 材料)` 的另一半。
 *
 * 这一份是宿主在这条路上唯一的活：历史与排队区只在这里认得出自己的表，三级模型解析只有 SDK 的
 * `resolveModel` 一处实现，项目行与助手定义是宿主的财产。装起来（造容器、造执行体、登记、开跑）
 * 全是运行时的事，宿主一个字节都不碰。
 *
 * **这里不做状态归一，也不写回库。** 上个进程没写完的那几条（`pending` / `writing`）由运行时
 * `wake` 在自己的内存里归成 `aborted`（它拿到的是一份拷贝，改它不动库），归一之后由运行时补报
 * 一条 `messageChanged` —— 装载那一刻的「读一遍、修一遍、写回一遍」按约定不做了，状态归一是
 * 运行时与内核的事，宿主那份唯一的观察者照旧只听事实写库。归一之后被内核在循环开头丢掉的那几条
 * 走 `messageRemoved`，同一个观察者删库。
 *
 * `messageFinished` 管的不是这一步（它管的是流式收尾、中断、工具定型那几处）；装载归一送过来的是
 * `messageChanged`，报的是「变了」而不是「新增」。剩下的一格代价照实写：`keep` 策略下内核把归成
 * `aborted` 的那几条改回 `completed` 是另一拍，它落在装载之后、同一条消息又只定稿一次，
 * 那一次改动写不回库。
 */
export async function materialsFor(deps: MaterialsDeps, session: Session): Promise<WakeMaterials> {
  // 连 `hidden` 的一起取：那些消息只是不给人看，模型照样得看到。
  const history = deps.messages.listBySession(session.id);

  const workspace = deps.workspaces.get(session.workspaceId);
  if (workspace === undefined) {
    throw new Error(
      `Cannot assemble session "${session.id}": workspace "${session.workspaceId}" does not exist`,
    );
  }

  // 生效模型与请求参数（含档位补丁）只有 `modelAndParamsFor` 一处实现 —— 换模型、换档位那两个
  // procedure 也调它，否则「哪一份参数发给哪个模型」就会在三条路上各写一遍。
  //
  // 删助手不看还有几段会话在用它，所以这段会话的助手可能已经不在了。SDK 那一层只会抛出一句
  // 英文的 `Agent "x" not found`，它带不上 `not_found` 这个码；`modelAndParamsFor` 里那次
  // `definitions.get` 缺了就是一条客户端认得出的失败。
  const { resolved, model, params: modelParams } = await modelAndParamsFor(deps, session);

  // 自动交接的阈值与上下文阈值都长在这个模型的配置上。缺了它 `createAgent` 也会拒掉同一件事，
  // 只是那一句话带不上是哪一段会话缺模型。
  if (model === undefined) {
    throw new Error(
      `Cannot assemble session "${session.id}": model "${resolved?.modelId}" is not in the config`,
    );
  }

  // 排队区：已经从库里放回队列的那几条，先在表里删掉。一条条目落过地没有，判据是它那条消息在
  // 不在历史里 —— 判据只有读得到历史的地方成立，所以这件事留在这里，`wake` 那一侧只负责把
  // 剩下的放回队列（它拿得到同一份历史，会再滤一遍）。
  const landed = new Set(history.map((message) => message.id));
  const consumed: string[] = [];
  const waiting: AgentNS.InboxEntryWithContent[] = [];
  for (const entry of deps.inbox.listBySession(session.id)) {
    if (entry.messageId !== undefined && landed.has(entry.messageId))
      consumed.push(entry.messageId);
    else waiting.push(entry);
  }

  deps.inbox.deleteMany(consumed);

  return {
    cwd: workspace.cwd,
    agentId: session.agentId,
    // 把解析出来的生效模型**显式**递下去，而不是让 `createAgent` 再按三级链算一遍：SDK 那一层
    // 「参数不跨级混合」—— `modelParams` 只在模型来自会话行时才被用上，模型来自助手定义或全局
    // 兜底时整份会被忽略。而档位补丁正是叠在这份参数上的，不显式说明生效模型，用户只改档位、
    // 没换过模型（最常见的那一种）就一点都不生效。解析本身仍然只有 `resolveModel` 一处实现。
    modelId: resolved?.modelId,
    modelParams,
    lineage: session.lineage,
    history,
    waiting,
    // 自动交接：装在这一段上，越线之后由插件自己发起。阈值与开关两格是取值函数而不是装配时
    // 算好的数 —— 改阈值、改开关都不重建执行体（`PRD.md` 4.7），装一次就等于把用户之后的选择
    // 钉死在装配那一刻。
    plugins: [
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
    ],
  };
}

/**
 * 算「这一段会话用哪个模型、带哪一份参数」要的那两样：配置给模型表与档位表，助手定义给三级
 * 解析的第二级与那层参数。
 *
 * 只要这两格而不是整个 `MaterialsDeps`：换模型、换档位那两个 procedure 手上没有项目行、
 * 排队区与交接服务，它们也不该为了读一次定义去凑齐一套。
 */
export interface ModelAndParamsDeps {
  readonly definitions: AgentDefinitionService;
  readonly config: GeneralConfig;
}

export interface ModelAndParams {
  /** 助手定义（`definitions.get` 的那一份）：它的 `modelId` 是解析的第二级，`modelParams` 是档位补丁叠在上面的那层 */
  readonly definition: AgentDefinition;
  /** 三级解析的结果（唯一实现是 SDK 的 `resolveModel`）；三级都空时 `null` */
  readonly resolved: ResolvedModel | null;
  /** 配置里对应生效模型的那一行 —— 阈值与档位表名都长在它上面；配置里没有这个模型时 `undefined` */
  readonly model: Model | undefined;
  /** 请求参数（`undefined` 表示不带覆盖、让模型走自己的出厂参数） */
  readonly params: ModelParams | undefined;
}

/**
 * 这一段会话的生效模型与请求参数：助手定义上那份在下，思考档位的补丁在上。
 *
 * **「模型 + 档位补丁」全仓只有这一处实现**：装配（`materialsFor`）、换模型与换思考档位两个
 * procedure 都调它。三处各写一遍的话，用户点了换档位而请求里带的是另一份参数这种事不会报错，
 * 只会在某个厂商那里变成一句 400。
 *
 * 档位名是客户端的选择，请求参数是厂商的方言，两者之间只有档位表能翻译 —— 表由生效模型的
 * `reasoningPreset` 指过来（同一张表还决定客户端能选哪几档）。三种情况都不叠补丁、只留定义
 * 那份：会话没选档位（`null` 表示跟随定义）、模型没挂档位表、档位名不在表里（客户端与磁盘上
 * 那份表不是同一版）。
 *
 * 模型用 `resolveModel` 取：档位属于生效的那个模型，会话换过模型时拿定义上那个会读错表。
 */
export async function modelAndParamsFor(
  deps: ModelAndParamsDeps,
  session: Session,
): Promise<ModelAndParams> {
  const definition = await deps.definitions.get(session.agentId);

  const config = deps.config.read();
  const resolved = resolveModel({
    sessionModelId: session.modelId ?? undefined,
    agentModelId: definition.modelId,
    defaultModel: config.defaultModel,
  });
  const model = config.models.find((item) => item.id === resolved?.modelId);

  const params: ModelParams = { ...definition.modelParams };
  const level = session.thinkingLevel;

  if (level !== null) {
    const presetName = model?.reasoningPreset;

    if (presetName !== undefined) {
      const patch = (await deps.config.presets())[presetName]?.levels[level];
      if (patch !== undefined) Object.assign(params, patch);
    }
  }

  return {
    definition,
    resolved,
    model,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}
