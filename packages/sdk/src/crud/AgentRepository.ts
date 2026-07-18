import type { AgentDefinition } from "../types/index.js";
import { EntityRepository } from "../shared/EntityRepository.js";

/**
 * Agent 仓储。
 * 每个 Agent 一个 JSON 文件存储在 ${agentsDir}/${id}.json。
 */
export class AgentRepository extends EntityRepository<AgentDefinition> {
  constructor(agentsDir: string) {
    super(agentsDir);
  }
}
