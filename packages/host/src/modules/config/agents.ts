import type { AgentDefinition, AgentRepository } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";
import type { GeneralConfig } from "./general.js";

export interface AgentDefinitionDeps {
  readonly repository: AgentRepository;
  readonly events: Bus<ConfigEvent>;
  readonly t: Translator;
  readonly general: GeneralConfig;
}

/**
 * 助手定义的增删改查。一个定义一个文件（`<数据根>/agents/<id>.json`），落盘交给 SDK 的
 * `AgentRepository`。
 *
 * 写完之后广播「这个助手变了」。用这个定义的会话要不要跟着变（失效、重建）属于运行时，
 * 这一层只发出这个事实。
 */
export class AgentDefinitionService {
  constructor(private readonly deps: AgentDefinitionDeps) {}

  list(): Promise<AgentDefinition[]> {
    return this.deps.repository.list();
  }

  async get(id: string): Promise<AgentDefinition> {
    const definition = await this.deps.repository.read(id);
    if (definition === null) throw this.notFound(id);
    return definition;
  }

  async add(
    definition: Omit<AgentDefinition, "createdAt" | "updatedAt">,
  ): Promise<AgentDefinition> {
    const now = new Date().toISOString();
    const created: AgentDefinition = { ...definition, createdAt: now, updatedAt: now };
    await this.deps.repository.write(created);
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: created.id });
    return created;
  }

  async update(
    id: string,
    change: Partial<Omit<AgentDefinition, "id" | "createdAt">>,
  ): Promise<AgentDefinition> {
    const current = await this.get(id);
    const next: AgentDefinition = { ...current, ...change, updatedAt: new Date().toISOString() };
    await this.deps.repository.write(next);
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: id });
    return next;
  }

  async remove(id: string): Promise<void> {
    // 先确认存在：仓储的 `delete` 把「本来就没有」也当成功，那样客户端会以为自己删掉了一个助手
    await this.get(id);
    await this.deps.repository.delete(id);
    // 删掉的是默认助手时，默认项也要跟着让位（PRD 3.4）：留着它指向一个不存在的定义，
    // 下一次新建会话会在解析模型那一步失败，而界面上看不出原因。
    if (this.deps.general.read().defaultAgent === id) {
      await this.deps.general.patch({ defaultAgent: undefined });
    }
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: id });
  }

  private notFound(id: string): HostError {
    return new HostError(
      "not_found",
      this.deps.t("找不到 id 为 {agentDefinitionId} 的助手", { agentDefinitionId: id }),
    );
  }
}
