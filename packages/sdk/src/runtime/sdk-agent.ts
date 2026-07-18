import { Agent, type ChatCompletionModel } from "@ai-zen/agents-core";
import type { AgentNS, Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions } from "../types/index.js";
import type { Capabilities } from "../capabilities/capabilities.js";
import type { Provider } from "./runtime.js";

// ---------------------------------------------------------------------------
// 插件接口
// ---------------------------------------------------------------------------

/**
 * Agent 插件上下文：当前 SdkAgent + 发送内容 + 消息列表。
 */
export interface SendContext {
  agent: SdkAgent;
  content: string;
  messages: AgentNS.Message[];
}

/**
 * Agent 插件接口。
 * 每个插件单一职责，通过钩子介入 send 前后的流程。
 *
 * onInit:       Agent.init() 时调用，用于异步初始化
 * onBeforeSend: Agent.send() 调用前触发。可用于刷新工具列表等。
 * onAfterSend:  Agent.send() 返回后调用。可通过 ctx.agent 替换当前 Agent。
 */
export interface AgentPlugin {
  /** Agent.init() 时调用，用于异步初始化 */
  onInit?(): Promise<void>;
  /** Agent.send() 调用前触发 */
  onBeforeSend?(ctx: SendContext): Promise<void>;
  /** Agent.send() 返回后调用，可通过 ctx.agent 替换当前 Agent */
  onAfterSend?(ctx: SendContext): Promise<void>;
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
    onBeforeSend?: () => void;
  }) {
    super({
      model: params.model,
      model_config: params.model_config,
      messages: params.messages,
      tools: params.tools,
      rag: params.rag,
      allowJsonParseError: params.allowJsonParseError,
      onBeforeSend: params.onBeforeSend,
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
   *   1. 遍历 _plugins.onBeforeSend
   *   2. super.send(content) — 委托 Core Agent
   *   3. 遍历 _plugins.onAfterSend
   *   4. 返回 messages
   */
  async send(content: string): Promise<AgentNS.Message[]> {
    const ctx: SendContext = {
      agent: this,
      content,
      messages: this.messages,
    };

    // 1. beforeSend 钩子
    for (const plugin of this._plugins) {
      await plugin.onBeforeSend?.(ctx);
    }

    // 2. 委托 Core Agent
    const messages = await super.send(content);

    // 3. afterSend 钩子
    for (const plugin of this._plugins) {
      await plugin.onAfterSend?.(ctx);
    }

    return messages;
  }
}
