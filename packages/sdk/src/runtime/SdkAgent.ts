import { Agent, type ChatCompletionModel } from "@ai-zen/agents-core";
import type {
  AgentNS,
  Tool,
  ToolCallContext,
  UnknownToolContext,
} from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions } from "../types/index.js";
import type { Provider } from "./Provider.js";

// ---------------------------------------------------------------------------
// 插件接口
// ---------------------------------------------------------------------------

/**
 * Agent 插件上下文：当前 SdkAgent + 发送内容 + 消息列表。
 *
 * 注意：
 * - messages 是当前 agent 消息数组的**快照**（浅拷贝），插件不应直接修改它。
 *   所有消息变更应通过 agent 上的方法进行。
 * - 如果 onAfterSend 替换了 ctx.agent，send() 方法会使用新 agent 的消息作为返回值。
 */
export interface SendContext {
  agent: SdkAgent;
  content: string;
  /** 当前 agent 消息数组的浅拷贝快照，仅供读取，不应直接修改 */
  messages: AgentNS.Message[];
}

/**
 * Agent 插件接口。
 * 每个插件单一职责，通过钩子介入 Agent 生命周期。
 *
 * onInit:            Agent.init() 时调用，用于异步初始化
 * onBeforeSend:      Agent.send() 调用前触发。可用于刷新工具列表等。
 * onAfterSend:       Agent.send() 返回后调用。可通过 ctx.agent 替换当前 Agent。
 * onInnerLoopStart:  Agent 内循环开始前触发。由 Core Agent 在内循环中调用。
 * onInnerLoopEnd:    Agent 内循环结束后触发。由 Core Agent 在内循环中调用。
 * onInnerLoopsStart: Agent 整组内循环开始前触发（一次 send 仅一次）。由 Core Agent 在 run() 的 while 循环前调用。
 * onInnerLoopsEnd:   Agent 整组内循环结束后触发（一次 send 仅一次）。由 Core Agent 在 run() 的 while 循环后调用。
 * onToolCall:        单个工具调用执行前触发（对应 Core onToolCall 钩子）。
 *                    返回字符串 = 拒绝该工具（原因作为工具结果回给 LLM，工具不执行）；
 *                    返回 undefined = 放行。多个插件按注册顺序调用，任一返回字符串即拒绝。
 */
export interface AgentPlugin {
  /** Agent.init() 时调用，用于异步初始化 */
  onInit?(): Promise<void>;
  /** Agent.send() 调用前触发 */
  onBeforeSend?(ctx: SendContext): Promise<void>;
  /** Agent.send() 返回后调用，可通过 ctx.agent 替换当前 Agent */
  onAfterSend?(ctx: SendContext): Promise<void>;
  /** Agent 内循环开始前触发 */
  onInnerLoopStart?(ctx: SendContext): Promise<void>;
  /** Agent 内循环结束后触发 */
  onInnerLoopEnd?(ctx: SendContext): Promise<void>;
  /** Agent 整组内循环开始前触发（一次 send 仅一次） */
  onInnerLoopsStart?(ctx: SendContext): Promise<void>;
  /** Agent 整组内循环结束后触发（一次 send 仅一次） */
  onInnerLoopsEnd?(ctx: SendContext): Promise<void>;
  /**
   * 单个工具调用执行前触发（对应 Core onToolCall 钩子，收同一个 ToolCallContext 实例）。
   * 返回字符串 = 拒绝该工具（不执行，原因作为工具结果回给 LLM，继续下一轮）；
   * 返回 undefined = 放行。多个插件按注册顺序调用，任一返回字符串即拒绝。
   */
  onToolCall?(ctx: ToolCallContext): string | undefined | Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// SdkAgent
// ---------------------------------------------------------------------------

/**
 * SDK Agent — 继承 Core Agent，携带 SDK 层额外信息。
 *
 * Core Agent 不做复杂逻辑（不感知权限、不感知文件系统），
 * SdkAgent 在 Core Agent 基础上增加了 SDK 层需要的元数据，
 * 并通过 provider 字段访问全局上下文。
 *
 * 携带：
 *   - provider：全局 Provider 实例
 *   - definition：Agent 原始定义
 *   - permissions：Agent 权限，供 call_skill_sub_agent 等回调读取
 *
 * 插件能力：
 *   - use(plugin)：注册插件
 *   - init()：初始化所有已注册插件
 *   - send()：重写，在前后执行插件钩子
 */
export class SdkAgent extends Agent {
  /** 全局 Provider 实例 */
  readonly provider: Provider;
  /** Agent 原始定义 */
  readonly definition: AgentDefinition;
  /** Agent 权限 */
  readonly permissions?: AgentPermissions;

  /**
   * 当 LLM 调用不存在的工具时，给出智能提示。
   * 如果有 MCP 配置但 call_mcp_tool 不在工具列表中（权限禁用），提示权限问题；
   * 如果有 MCP 配置且 call_mcp_tool 可用，提示使用 call_mcp_tool；
   * 否则仅提示工具不存在。
   */
  onUnknownTool = (ctx: UnknownToolContext): string => {
    const toolName = ctx.toolCall.function?.name ?? "未知";
    const hasMcpConfig = this.provider.mcpPaths.length > 0;
    const hasCallMcpTool = (this.tools ?? []).some(
      (t) => t.function.name === "call_mcp_tool",
    );

    if (hasMcpConfig && !hasCallMcpTool) {
      return `工具 "${toolName}" 不存在。当前有 MCP 服务器配置，但 call_mcp_tool 权限已被禁用，如需使用 MCP 工具请调整权限。`;
    }
    if (hasMcpConfig && hasCallMcpTool) {
      return `工具 "${toolName}" 不存在。如果要调用 MCP 工具，请使用 call_mcp_tool。`;
    }
    return `工具 "${toolName}" 不存在。`;
  }

  /** 已注册的插件列表 */
  private _plugins: AgentPlugin[] = [];

  constructor(params: {
    provider: Provider;
    definition: AgentDefinition;
    model: ChatCompletionModel;
    model_config?: Record<string, unknown>;
    messages?: AgentNS.Message[];
    tools?: Tool[];
    permissions?: AgentPermissions;
    rag?: any;
    allowJsonParseError?: boolean;
  }) {
    super({
      model: params.model,
      model_config: params.model_config,
      messages: params.messages,
      tools: params.tools,
      rag: params.rag,
      allowJsonParseError: params.allowJsonParseError,
    });
    this.provider = params.provider;
    this.definition = params.definition;
    this.permissions = params.permissions;
  }

  /**
   * 注册一个插件。
   * 可以在 init() 之前或之后调用，但 beforeSend/afterSend 钩子仅在
   * init() 之后发送消息时生效。
   */
  use(plugin: AgentPlugin): void {
    this._plugins.push(plugin);
  }

  /**
   * 初始化所有已注册插件。
   * SdkAgent 本身没有异步初始化需求——模型、工具、消息在构造时已就绪。
   * init() 的存在完全是为了给插件一个执行异步初始化的机会。
   *
   * 如果不使用任何插件，可以不调 init()。
   */
  async init(): Promise<void> {
    for (const plugin of this._plugins) {
      await plugin.onInit?.();
    }
  }

  /**
   * 发送消息，在前后执行插件钩子。
   *
   * 流程：
   *   1. onBeforeSend — send 外部准备（刷新工具等）
   *   2. super.send()  — 委托 Core Agent，内含内循环及其钩子
   *   3. onAfterSend  — send 外部后处理（保存草稿、迁移等）
   *
   * 注意：
   * - ctx.messages 是当前 agent 消息的**浅拷贝快照**，仅供读取，不应直接修改。
   *   所有消息变更应通过 agent 上的方法进行（如 agent.messages.push 等）。
   */
  async send(content: string): Promise<AgentNS.Message[]> {
    const ctx: SendContext = {
      agent: this,
      content,
      messages: [...this.messages],
    };

    for (const plugin of this._plugins) {
      await plugin.onBeforeSend?.(ctx);
    }

    this.onInnerLoopStart = async () => {
      for (const plugin of this._plugins) {
        await plugin.onInnerLoopStart?.(ctx);
      }
    };
    this.onInnerLoopEnd = async () => {
      for (const plugin of this._plugins) {
        await plugin.onInnerLoopEnd?.(ctx);
      }
    };
    this.onInnerLoopsStart = async () => {
      for (const plugin of this._plugins) {
        await plugin.onInnerLoopsStart?.(ctx);
      }
    };
    this.onInnerLoopsEnd = async () => {
      for (const plugin of this._plugins) {
        await plugin.onInnerLoopsEnd?.(ctx);
      }
    };
    // 工具调用拦截：任一插件返回字符串即拒绝该工具（短路），全部放行则返回 undefined
    this.onToolCall = async (ctx: ToolCallContext) => {
      for (const plugin of this._plugins) {
        const denied = await plugin.onToolCall?.(ctx);
        if (denied !== undefined) return denied;
      }
      return undefined;
    };
    await super.send(content);
    this.onInnerLoopStart = undefined;
    this.onInnerLoopEnd = undefined;
    this.onInnerLoopsStart = undefined;
    this.onInnerLoopsEnd = undefined;
    this.onToolCall = undefined;

    for (const plugin of this._plugins) {
      await plugin.onAfterSend?.(ctx);
    }

    return this.messages;
  }
}
