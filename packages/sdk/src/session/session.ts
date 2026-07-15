import type { SdkAgent } from "../runtime/sdk-agent";
import type { Model } from "../types";
import type { Session, SessionBuilder, SessionContext, SessionPlugin } from "./types";
import { SdkError } from "../shared/errors";

// ---------------------------------------------------------------------------
// Session 实现
// ---------------------------------------------------------------------------

class SessionImpl implements Session {
  private _agent: SdkAgent;
  private readonly _model: Model;
  private readonly _plugins: SessionPlugin[];

  constructor(agent: SdkAgent, model: Model, plugins: SessionPlugin[]) {
    this._agent = agent;
    this._model = model;
    this._plugins = plugins;
  }

  get agent(): SdkAgent {
    return this._agent;
  }

  async send(content: string): Promise<any[]> {
    const ctx: SessionContext = { agent: this._agent, model: this._model };

    // 1. 遍历插件 beforeSend 钩子（如刷新工具列表）
    for (const plugin of this._plugins) {
      if (!plugin.beforeSend) continue;
      await plugin.beforeSend(ctx);
    }

    // 2. 委托 Core Agent
    const messages = await this._agent.send(content);

    // 3. 遍历插件 afterSend 钩子（插件通过 ctx.agent 替换 Agent）
    for (const plugin of this._plugins) {
      if (!plugin.afterSend) continue;
      await plugin.afterSend(ctx);
    }

    // 4. 更新当前 Agent（可能有插件替换了 ctx.agent）
    this._agent = ctx.agent;

    return messages;
  }
}

// ---------------------------------------------------------------------------
// SessionBuilder 实现
// ---------------------------------------------------------------------------

class SessionBuilderImpl implements SessionBuilder {
  private readonly _agent: SdkAgent;
  private readonly _model: Model;
  private readonly _plugins: SessionPlugin[] = [];

  constructor(agent: SdkAgent, model: Model) {
    this._agent = agent;
    this._model = model;
  }

  use(plugin: SessionPlugin): SessionBuilder {
    this._plugins.push(plugin);
    return this;
  }

  async init(): Promise<Session> {
    return new SessionImpl(this._agent, this._model, [...this._plugins]);
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 从 agent.runtime.config 中查找对应 modelId 的 Model 配置。
 */
function resolveModelConfig(agent: SdkAgent): Model {
  const modelId = agent.definition.modelId ?? agent.runtime.config.defaultModel;
  if (!modelId) {
    throw new SdkError("NO_MODEL", "Agent 未指定 modelId 且 config 无 defaultModel");
  }
  const model = agent.runtime.config.models.find((m) => m.id === modelId);
  if (!model) {
    throw new SdkError("MODEL_NOT_FOUND", `模型 "${modelId}" 在 config 中不存在`);
  }
  return model;
}

/**
 * 创建 Session 构建器。
 *
 * 从 agent.runtime.config 自动查找 Model 配置，无需调用方手动传入。
 *
 * ```ts
 * const session = await createSession({ agent })
 *   .use(autoMigrate({ maxTokens, migrationAgent }))
 *   .use(autoDraft({ ... }))
 *   .init();
 * ```
 */
export function createSession(options: { agent: SdkAgent }): SessionBuilder {
  const model = resolveModelConfig(options.agent);
  return new SessionBuilderImpl(options.agent, model);
}
