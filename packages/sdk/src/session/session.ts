import type { Agent } from "@ai-zen/agents-core";
import type { Model } from "../types";
import type { Session, SessionBuilder, SessionContext, SessionPlugin } from "./types";

// ---------------------------------------------------------------------------
// Session 实现
// ---------------------------------------------------------------------------

class SessionImpl implements Session {
  private _agent: Agent;
  private readonly _model: Model;
  private readonly _plugins: SessionPlugin[];

  constructor(agent: Agent, model: Model, plugins: SessionPlugin[]) {
    this._agent = agent;
    this._model = model;
    this._plugins = plugins;
  }

  get agent(): Agent {
    return this._agent;
  }

  async send(content: string): Promise<any[]> {
    // 1. 委托 Core Agent
    const messages = await this._agent.send(content);

    // 2. 遍历插件 afterRun 钩子
    const ctx: SessionContext = { agent: this._agent, model: this._model };
    for (const plugin of this._plugins) {
      if (!plugin.afterRun) continue;

      const newAgent = await plugin.afterRun(ctx);
      if (newAgent) {
        this._agent = newAgent;
        ctx.agent = newAgent; // 后续插件看到新 Agent
      }
    }

    return messages;
  }
}

// ---------------------------------------------------------------------------
// SessionBuilder 实现
// ---------------------------------------------------------------------------

class SessionBuilderImpl implements SessionBuilder {
  private readonly _agent: Agent;
  private readonly _model: Model;
  private readonly _plugins: SessionPlugin[] = [];

  constructor(agent: Agent, model: Model) {
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
 * 创建 Session 构建器。
 *
 * ```ts
 * const session = await createSession({ agent, model })
 *   .use(autoMigrate({ maxTokens, migrationAgent }))
 *   .init();
 * ```
 */
export function createSession(options: { agent: Agent; model: Model }): SessionBuilder {
  return new SessionBuilderImpl(options.agent, options.model);
}
