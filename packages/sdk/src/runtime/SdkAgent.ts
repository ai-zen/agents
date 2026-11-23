import type OpenAI from "openai";
import { Agent } from "@ai-zen/agents-core";
import type {
  AbortedMessageStrategy,
  AbortedToolRoundStrategy,
  AgentNS,
  Tool,
} from "@ai-zen/agents-core";
import type { AgentDefinition, ModelParams } from "../types/index.js";
import type { Scope } from "../scope/Scope.js";
import { createModel } from "./createModel.js";

// 插件机制在 core：重新导出，SDK 侧 import 来源保持不变。
//
// 钩子的 ctx 类型一并转出：写插件的人要用 `InnerLoopContext` / `ToolHookContext` /
// `OuterLoopContext` / `SubAgentHookContext` 这几个形状，SDK 不另造一套。
export type {
  AgentPlugin,
  InnerLoopContext,
  OuterLoopContext,
  SubAgentHookContext,
  ToolHookContext,
} from "@ai-zen/agents-core";

/**
 * SDK Agent — 继承 Core Agent，携带 SDK 层额外信息。
 *
 * Core Agent 不感知权限、文件系统等业务逻辑；
 * SdkAgent 在 Core Agent 基础上增加了 SDK 层需要的元数据：
 *   - scope：全局 Scope 实例
 *   - definition：Agent 定义（含权限 permissions）。**模型解析生效之后的那一份**：
 *     会话级覆盖会写进它的 `modelId`（见 `createAgent`），于是「读哪个字段都不会跑偏」。
 *     它没有「档位」这一格：档位是 `resolveModel` 的返回值，宿主会话视图的
 *     `modelSource()` 另有自己的一格。
 *
 * 插件能力（use / init / 钩子分发）继承自 Core Agent，此处不重复实现。
 * 未知工具的 MCP 智能提示由独立插件 `UnknownToolHintPlugin` 提供（调用方显式 use）。
 * 权限统一从 `definition.permissions` 读取。
 */
export class SdkAgent extends Agent {
  /** 全局 Scope 实例 */
  readonly scope: Scope;
  /** Agent 定义（模型解析生效之后的那一份：`modelId` 是**实际在用**的模型） */
  readonly definition: AgentDefinition;

  constructor(params: {
    scope: Scope;
    definition: AgentDefinition;
    client: OpenAI;
    model: string;
    modelConfig?: Record<string, unknown>;
    messages?: AgentNS.Message[];
    tools?: Tool[];
    /** 工具轮次被中断时的归一策略（core 默认 `fill`） */
    abortedToolRoundStrategy?: AbortedToolRoundStrategy;
    /** `fill` 策略下未完成工具结果的填充原因 */
    abortedToolRoundReason?: string;
    /** 被中断的 assistant（内容/思考）是否保留（core 默认 `drop`） */
    abortedMessageStrategy?: AbortedMessageStrategy;
    /**
     * 寿命：常驻（缺省）还是一次性（`AgentNS.AgentLifetime`）。
     *
     * 这一格原样透传给 core —— 它不只是「活多久」，是能力差：一次性 Agent 只吃一次投递、
     * `send` / `runOnce` 才有意义。
     */
    lifetime?: AgentNS.AgentLifetime;
  }) {
    super({
      client: params.client,
      model: params.model,
      modelConfig: params.modelConfig,
      messages: params.messages,
      tools: params.tools,
      abortedToolRoundStrategy: params.abortedToolRoundStrategy,
      abortedToolRoundReason: params.abortedToolRoundReason,
      abortedMessageStrategy: params.abortedMessageStrategy,
      lifetime: params.lifetime,
    });
    this.scope = params.scope;
    this.definition = params.definition;
  }

  /**
   * 就地刷新生效模型：换模型与换思考档位都走它，**不杀 Agent**。
   *
   * 记忆、排队区、两道开关、正在跑的那一次请求一处都不动：下一次请求从头读 `client` /
   * `model` / `modelConfig`，所以下一次就按新的走。定义上的 `modelId` 一并改成生效的那个
   * —— 运行期读 `definition.modelId` 的地方（状态栏、上下文阈值）看到的是同一个模型。
   */
  useModel(modelId: string, modelParams?: ModelParams): void {
    const { client, model, modelConfig } = createModel(this.scope, modelId, modelParams);

    // 三格一起换：只换其中一两格，下一次请求就会拿新模型名配旧端点、或者带着上一个模型的
    // 参数发出去 —— 而请求体是在发请求那一刻从这三格拼出来的。
    this.client = client;
    this.model = model;
    // 构造函数那边的同一件事是 `params.modelConfig ?? {}`：core 的这一格不吃 `undefined`。
    this.modelConfig = modelConfig ?? {};

    // `definition` 这一格是 `readonly`（指向对象，不换指向），改对象里的字段是允许的。
    this.definition.modelId = modelId;
  }
}
