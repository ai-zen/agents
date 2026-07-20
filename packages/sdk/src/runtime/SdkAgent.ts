import { Agent, type ChatCompletionModel } from "@ai-zen/agents-core";
import type { AgentNS, Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions } from "../types/index.js";
import type { Capabilities } from "../capabilities/Capabilities.js";
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
 *   - caps：Capabilities 全局注册表，供 refreshTools 刷新工具列表
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
  /** Capabilities 全局注册表，用于运行时刷新工具列表 */
  readonly caps?: Capabilities;

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
    caps?: Capabilities;
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
    this.caps = params.caps;
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
    await super.send(content);
    this.onInnerLoopStart = undefined;
    this.onInnerLoopEnd = undefined;

    for (const plugin of this._plugins) {
      await plugin.onAfterSend?.(ctx);
    }

    return this.messages;
  }
}
