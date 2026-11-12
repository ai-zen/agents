/**
 * 临时对话（PRD D3 / F-A2 / R1 / R49）：一次请求跑一轮，零痕迹。
 *
 * 五件「没有」就是它的定义：**没有 id、不落库、不进对话列表、不可 attach、不推流式事件**。
 * 所以本文件的结构是刻意做窄的 —— 它没有库、没有事件出口、没有轮次注册表，只有「借一个
 * Scope、跑一轮、把结果一次交回去」。做不到的事情（落库、推流）在这里不是被判断掉，而是
 * 根本没有可用的通道。
 *
 * ## 为什么单独一个文件而不是给 `ChatRunner` 加开关
 *
 * `ChatRunner` 的骨架是「落库 + 推流 + 边流边写」，这三件事对临时对话全是多余的；
 * 加开关会让每一条写库路径后面都跟一个 `if`，而临时对话在语义上又确实是一次「跑一轮」。
 * 于是执行逻辑复用 core 的同一套（`agent.send()` 跑完整组内循环），落库与推送这一层换掉。
 *
 * ## Scope 的借用口径
 *
 * D3 的原话是「只借 Scope，与 Workspace 无关」：临时对话没有 Workspace 身份，它只认一个
 * `cwd`（相对路径的解析基准）。所以这里不用 `workspaceId` 去借，而是用
 * `transientScopeKey(cwd)` 这个**按目录**的键（见 {@link transientScopeKey}）：
 *
 *   - 同一个目录连着跑两次临时对话，会命中同一个 Scope（借还计数加一减一）；
 *   - 键里带着 cwd，于是 Scope 的创建方（接线层）能直接从键里解析出目录来装配能力；
 *   - 回收仍然交给持有那份空闲计时的 `ScopeRegistry`（A10：计时器只有一处），
 *     本文件不自建缓存、也不自建计时器。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import { AgentNS as AgentNSValue, Message } from "@ai-zen/agents-core";
import type { ConfigManager, Scope } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { AgentFactory, ChatAgent } from "./ChatRunner.js";
import { injectedContextOf } from "./ChatRunner.js";
import { ServerError } from "../wire/errors.js";
import type {
  ConversationTransientParams,
  ConversationTransientResult,
  ProblemFact,
} from "../wire/index.js";

/**
 * 临时对话借 Scope 用的键：按目录，不按 Workspace。
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

/** 借 / 还 Scope 的窄接口（结构上 `ScopeRegistry` 满足） */
export interface TransientScopeBorrower {
  acquire(key: string): Promise<Scope>;
  release(key: string): void;
}

/** 装配临时对话用的 agent：比 `AgentFactory` 少两个身份字段（它没有对话、没有 Workspace） */
export type TransientAgentFactory = (context: {
  scope: Scope;
  agentId: string;
  modelId: string | null;
  /** 这一轮开始前的历史；临时对话永远是空数组 */
  history: AgentNS.Message[];
}) => Promise<ChatAgent>;

/** 临时对话在装配时用的身份占位（`AgentFactory` 的入参里有这两项，临时对话没有真值） */
const TRANSIENT_IDENTITY = "conversation.transient";

/**
 * 把通用的 `AgentFactory` 适配成临时对话用的那个形状。
 *
 * `conversationId` / `workspaceId` 填一个显式占位：工厂里可能把它们写进钩子载荷（日志、
 * 交接服务的决策），填 `""` 会让日志里出现一个空身份，填占位符至少看得出来这是临时对话。
 * `thinkingLevel` 恒为 `null`：临时对话没有会话行，也就没有会话级档位，跟助手定义上的那份。
 */
export function transientAgentFactoryFrom(createAgent: AgentFactory): TransientAgentFactory {
  return async (context) =>
    await createAgent({
      conversationId: TRANSIENT_IDENTITY,
      workspaceId: TRANSIENT_IDENTITY,
      agentId: context.agentId,
      modelId: context.modelId,
      thinkingLevel: null,
      scope: context.scope,
      history: context.history,
    });
}

export interface TransientRunnerDeps {
  /** 借 Scope 的入口（接的是持有空闲计时的那一个，A10） */
  scopes: TransientScopeBorrower;
  createAgent: TransientAgentFactory;
  /** 配置唯一入口：没点名助手时用它读默认助手（`AppConfig.defaultAgent`） */
  configManager: ConfigManager;
  now?: () => number;
}

/** 一次临时对话的结果里，`problem` 是「跑完了但这轮不算成功」时的那份说明 */
export class TransientRunner {
  private readonly scopes: TransientScopeBorrower;
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
   * 跑一轮，把结果一次交回去。
   *
   * `cwd` 必填（契约要求）：临时对话的目录基准不能靠进程工作目录猜 —— 服务端是常驻进程，
   * 它的 cwd 由启动方式决定，与调用方想的那个目录没有关系。
   *
   * 失败走 `ServerError`（没有会话可回看，说不出「哪一轮失败了」）；跑完但结局不好
   * （消息停在 error / aborted）时用 `problem` 说明，`message` 照样带回去。
   */
  async run(
    params: ConversationTransientParams,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<ConversationTransientResult> {
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (cwd.length === 0) {
      throw new ServerError("invalid_params", {
        params: { field: "cwd" },
        detail: { field: "cwd", reason: "empty" },
      });
    }

    const agentId = await this.resolveAgentId(params.agentId);
    const scopeKey = transientScopeKey(cwd);
    const scope = await this.scopes.acquire(scopeKey);
    try {
      const agent = await this.createAgent({
        scope,
        agentId,
        modelId: params.modelId ?? null,
        history: [],
      });
      // F-D9：临时对话也一样告诉模型「当前目录是哪儿」。它不落库，所以这条 `hidden` 消息
      // 只活在内存里（与那段落库的 cwd 消息同一个形状）；目录就是入参里的那个 cwd
      agent.append(
        new Message({
          role: AgentNSValue.Role.User,
          content: injectedContextOf(cwd, language),
          status: AgentNSValue.MessageStatus.Completed,
          hidden: true,
        }),
      );
      await agent.send(params.input.content);
      const message = lastAssistant(agent.messages);
      if (!message) {
        throw new ServerError("internal", {
          messageKey: "error.transientFailed",
          params: { reason: "no assistant message came back" },
          detail: { cwd, agentId },
        });
      }
      return { message, subagents: [], problem: problemOf(message, language) };
    } catch (error) {
      throw this.toServerError(error, cwd, language);
    } finally {
      // 与一轮普通对话一致：跑完就还（agent 本身跑完即弃，D28）
      this.scopes.release(scopeKey);
    }
  }

  /** 这一轮用哪个助手：入参点名优先，否则配置里的默认助手（没有就说不清用哪个） */
  private async resolveAgentId(agentId: string | undefined): Promise<string> {
    if (typeof agentId === "string" && agentId.trim().length > 0) return agentId.trim();
    const config = await this.configManager.read();
    const fallback = config.defaultAgent;
    if (!fallback) {
      throw new ServerError("config_invalid", {
        detail: { reason: "no_agent", field: "agentId" },
      });
    }
    return fallback;
  }

  /** 执行 / 装配抛出的东西收敛成服务端的错误：临时对话没有会话可回看，只能在这一句里说清 */
  private toServerError(error: unknown, cwd: string, language: Language): ServerError {
    if (ServerError.is(error)) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new ServerError("internal", {
      messageKey: "error.transientFailed",
      params: { reason },
      detail: { cwd, reason, message: render(language, "error.transientFailed", { reason }) },
      cause: error,
    });
  }
}

/** 这一轮产出的那条助手消息：取最后一条（工具轮次会有多条，最后一条才是最终答复） */
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
  if (status !== AgentNSValue.MessageStatus.Error && status !== AgentNSValue.MessageStatus.Aborted) {
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
