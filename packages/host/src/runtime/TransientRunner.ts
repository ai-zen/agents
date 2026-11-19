/**
 * 一次性会话（PRD D3 / F-A2 / R1 / R49）：一次请求、一个答案，零痕迹。
 *
 * 五件「没有」就是它的定义：**没有 id、不落库、不进会话列表、不可 attach、不推流式事件**。
 * 所以本文件的结构是刻意做窄的 —— 它没有库、没有事件出口、没有「在跑的请求」那本账，只有
 * 「要一个 Scope、跑一次、把结果一次交回去」。做不到的事情（落库、推流）在这里不是被判断掉，
 * 而是根本没有可用的通道。
 *
 * ## 为什么单独一个文件而不是给 `ChatRunner` 加开关
 *
 * `ChatRunner` 的骨架是「落库 + 推流 + 边流边写」，这三件事对一次性会话全是多余的；
 * 加开关会让每一条写库路径后面都跟一个 `if`，而一次性会话在语义上又确实就是「跑一次就散」。
 * 于是执行逻辑复用 core 的同一套（`agent.runOnce()` 跑完那一组内循环），落库与推送这一层换掉。
 *
 * ## Scope 的口径
 *
 * D3 的原话是「只借 Scope，与 Workspace 无关」：一次性会话没有 Workspace 身份，它只认一个
 * `cwd`（相对路径的解析基准）。所以这里不用 `workspaceId` 去要，而是用
 * `transientScopeKey(cwd)` 这个**按目录**的键（见 {@link transientScopeKey}）：
 *
 *   - 同一个目录连着跑两次一次性会话，会命中同一个 Scope（`create` 是幂等的 get-or-create）；
 *   - 键里带着 cwd，于是 Scope 的创建方（接线层）能直接从键里解析出目录来装配能力；
 *   - 跑完**不还**：没有引用计数、没有归还这回事。那个目录的 Scope 活到显式 dispose 或
 *     进程退出（它带着那个项目的 MCP 连接，下一次同一目录的一次性会话还能直接复用）。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import { AgentNS as AgentNSValue, Message } from "@ai-zen/agents-core";
import type { ConfigManager, Scope } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { AgentFactory, ChatAgent } from "./ChatRunner.js";
import { HostError } from "../wire/errors.js";
import type { SessionTransientParams, SessionTransientResult, ProblemFact } from "../wire/index.js";

/**
 * 一次性会话借 Scope 用的键：按目录，不按 Workspace。
 *
 * 前缀不可省：接线层拿到的键要能区分「这是某个 Workspace」还是「这是某个目录的临时借用」，
 * 否则一个名叫 `transient:/x` 的 Workspace id 就能和临时借用撞在一起。
 */
export function transientScopeKey(cwd: string): string {
  return `transient:${cwd}`;
}

/** 从借用键里取回目录；不是临时键时返回 `null`（接线层的 Scope 工厂用它分流） */
export function cwdOfTransientScopeKey(key: string): string | null {
  return key.startsWith("transient:") ? key.slice("transient:".length) : null;
}

/** 取 Scope 的口子（结构上 `ScopeRegistry` 满足）：幂等 get-or-create，没有「归还」 */
export interface TransientScopes {
  create(key: string): Promise<Scope>;
}

/** 装配一次性会话用的 agent：比 `AgentFactory` 少两个身份字段（它没有会话、没有 Workspace） */
export type TransientAgentFactory = (context: {
  scope: Scope;
  agentId: string;
  modelId: string | null;
  /** 这一次请求开始前的历史；一次性会话永远是空数组 */
  history: AgentNS.Message[];
}) => Promise<ChatAgent>;

/** 一次性会话在装配时用的身份占位（`AgentFactory` 的入参里有这两项，一次性会话没有真值） */
const TRANSIENT_IDENTITY = "session.transient";

/**
 * 把通用的 `AgentFactory` 适配成一次性会话用的那个形状。
 *
 * `sessionId` / `workspaceId` 填一个显式占位：工厂里可能把它们写进钩子载荷（日志、
 * 交接服务的决策），填 `""` 会让日志里出现一个空身份，填占位符至少看得出来这是一次性会话。
 * `thinkingLevel` 恒为 `null`：一次性会话没有会话行，也就没有会话级档位，跟助手定义上的那份。
 */
export function transientAgentFactoryFrom(createAgent: AgentFactory): TransientAgentFactory {
  return async (context) =>
    await createAgent({
      sessionId: TRANSIENT_IDENTITY,
      workspaceId: TRANSIENT_IDENTITY,
      agentId: context.agentId,
      modelId: context.modelId,
      thinkingLevel: null,
      scope: context.scope,
      history: context.history,
    });
}

export interface TransientRunnerDeps {
  /** 取 Scope 的入口（幂等 get-or-create；跑完不还，Scope 活到显式 dispose / 进程退出） */
  scopes: TransientScopes;
  createAgent: TransientAgentFactory;
  /** 配置唯一入口：没点名助手时用它读默认助手（`AppConfig.defaultAgent`） */
  configManager: ConfigManager;
  now?: () => number;
}

/** 一次一次性会话的结果里，`problem` 是「跑完了但这一次不算成功」时的那份说明 */
export class TransientRunner {
  private readonly scopes: TransientScopes;
  private readonly createAgent: TransientAgentFactory;
  private readonly configManager: ConfigManager;
  private readonly now: () => number;

  constructor(deps: TransientRunnerDeps) {
    this.scopes = deps.scopes;
    this.createAgent = deps.createAgent;
    this.configManager = deps.configManager;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 跑一次，把结果一次交回去。
   *
   * `cwd` 必填（契约要求）：一次性会话的目录基准不能靠进程工作目录猜 —— 宿主是常驻进程，
   * 它的 cwd 由启动方式决定，与调用方想的那个目录没有关系。
   *
   * 失败走 `HostError`（没有会话可回看，说不出「哪一次失败了」）；跑完但结局不好
   * （消息停在 error / aborted）时用 `problem` 说明，`message` 照样带回去。
   */
  async run(
    params: SessionTransientParams,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<SessionTransientResult> {
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (cwd.length === 0) {
      throw new HostError("invalid_params", {
        params: { field: "cwd" },
        detail: { field: "cwd", reason: "empty" },
      });
    }

    const agentId = await this.resolveAgentId(params.agentId);
    const scopeKey = transientScopeKey(cwd);
    const scope = await this.scopes.create(scopeKey);
    try {
      const agent = await this.createAgent({
        scope,
        agentId,
        modelId: params.modelId ?? null,
        history: [],
      });
      // F-D9：一次性会话也一样告诉模型「当前目录是哪儿」。它不落库，所以这条 `hidden` 消息
      // 只活在内存里（与那段落库的 cwd 消息同形同文）；目录就是入参里的那个 cwd，
      // 正文就是那个路径（不是一句渲染过的话：隐藏消息用户看不见，模型要的就是路径）
      agent.append(
        new Message({
          role: AgentNSValue.Role.User,
          content: cwd,
          status: AgentNSValue.MessageStatus.Completed,
          // core 现在要求**所有** user 消息都带 `source`（`CORE.md` §3）：这条是宿主注入的，
          // 谁注入谁填，所以它记成「宿主 / cwd」而不是用户说的话
          source: { kind: "system", label: "cwd" },
          hidden: true,
        }),
      );
      // 一次性会话是**一次性**的：只有一条因果链（就是这一次请求），所以这里是全仓唯一允许
      // 「等」的地方（`CORE.md` §1 的 `runOnce`）。它起 → 塞 → 等闲 → 关门 → 死透，然后把
      // 跑出来的消息交回来。常驻会话不能这么用：那会把一个长期会话关掉。
      agent.lifetime = "one-shot";
      await agent.runOnce({
        content: params.input.content,
        source: { kind: "user" },
        priority: "high",
      });
      const message = lastAssistant(agent.messages);
      if (!message) {
        throw new HostError("internal", {
          messageKey: "error.transientFailed",
          params: { reason: "no assistant message came back" },
          detail: { cwd, agentId },
        });
      }
      // subagent 不另给快照（`SessionTransientResult`）：它们说过的话在那条委派的消息里，
      // 真要翻就按工具调用 id 取（F-I7）
      return { message, problem: problemOf(message, language) };
    } catch (error) {
      throw this.toHostError(error, cwd, language);
    }
    // 没有 finally：跑完不「还」Scope —— 那个目录的能力容器不属于这一次请求
    // （agent 本身仍然跑完即弃，D28）
  }

  /** 这一次用哪个助手：入参点名优先，否则配置里的默认助手（没有就说不清用哪个） */
  private async resolveAgentId(agentId: string | undefined): Promise<string> {
    if (typeof agentId === "string" && agentId.trim().length > 0) return agentId.trim();
    const config = await this.configManager.read();
    const fallback = config.defaultAgent;
    if (!fallback) {
      throw new HostError("config_invalid", {
        detail: { reason: "no_agent", field: "agentId" },
      });
    }
    return fallback;
  }

  /** 执行 / 装配抛出的东西收敛成宿主的错误：一次性会话没有会话可回看，只能在这一句里说清 */
  private toHostError(error: unknown, cwd: string, language: Language): HostError {
    if (HostError.is(error)) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new HostError("internal", {
      messageKey: "error.transientFailed",
      params: { reason },
      detail: { cwd, reason, message: render(language, "error.transientFailed", { reason }) },
      cause: error,
    });
  }
}

/** 这一次产出的那条助手消息：取最后一条（工具轮次会有多条，最后一条才是最终答复） */
function lastAssistant(messages: AgentNS.Message[]): AgentNS.Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === AgentNSValue.Role.Assistant) return message;
  }
  return null;
}

/** 跑完了但结局不好：消息自己的状态就是事实（core 的口径），这里把它翻成一句说明 */
function problemOf(message: AgentNS.Message, language: Language): ProblemFact | null {
  const status = message.status;
  if (
    status !== AgentNSValue.MessageStatus.Error &&
    status !== AgentNSValue.MessageStatus.Aborted
  ) {
    return null;
  }
  const reason = status === AgentNSValue.MessageStatus.Aborted ? "aborted" : "error";
  const params = { reason };
  return {
    code: `transient.${reason}`,
    messageKey: "error.transientFailed",
    params,
    message: render(language, "error.transientFailed", params),
    detail: { status, finishReason: message.finish_reason ?? null },
  };
}
