import type { Agent } from "@ai-zen/agents-core";
import type { Model } from "../types";

/**
 * Session 插件上下文：当前 Agent + 模型配置。
 */
export interface SessionContext {
  agent: Agent;
  model: Model;
}

/**
 * Session 插件接口。
 * 每个插件单一职责，通过 afterRun 钩子介入 send 后的流程。
 */
export interface SessionPlugin {
  /** Agent.run() 返回后调用。可返回新 Agent 替换当前实例。 */
  afterRun?(ctx: SessionContext): Promise<Agent | void>;
}

/**
 * Session：薄包装层，负责 send 委托 + 插件链。
 */
export interface Session {
  readonly agent: Agent;
  send(content: string): Promise<any[]>;
}

/**
 * Session 构建器：.use() 链式注册插件，.init() 创建 Session。
 */
export interface SessionBuilder {
  use(plugin: SessionPlugin): SessionBuilder;
  init(): Promise<Session>;
}
