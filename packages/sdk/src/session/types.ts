import type { Model } from "../types";
import type { SdkAgent } from "../runtime/sdk-agent";

/**
 * Session 插件上下文：当前 SdkAgent + 模型配置。
 */
export interface SessionContext {
  agent: SdkAgent;
  model: Model;
}

/**
 * Session 插件接口。
 * 每个插件单一职责，通过钩子介入 send 前后的流程。
 *
 * afterSend 中如需替换 Agent，直接修改 ctx.agent 即可，
 * Session 会在所有插件执行完毕后读取 ctx.agent 作为当前 Agent。
 */
export interface SessionPlugin {
  /** Agent.send() 调用前触发。可用于刷新工具列表等。 */
  beforeSend?(ctx: SessionContext): Promise<void>;
  /** Agent.send() 返回后调用。可通过 ctx.agent 替换当前 Agent。 */
  afterSend?(ctx: SessionContext): Promise<void>;
}

/**
 * Session：薄包装层，负责 send 委托 + 插件链。
 */
export interface Session {
  readonly agent: SdkAgent;
  send(content: string): Promise<any[]>;
}

/**
 * Session 构建器：.use() 链式注册插件，.init() 创建 Session。
 */
export interface SessionBuilder {
  use(plugin: SessionPlugin): SessionBuilder;
  init(): Promise<Session>;
}
