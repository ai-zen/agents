import type { AgentDefinition } from "../types/index.js";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";
import { EntityRepository } from "../shared/EntityRepository.js";

/**
 * Agent 仓储。
 * 每个 Agent 一个 JSON 文件存储在 ${agentsDir}/${id}.json。
 */
export class AgentRepository extends EntityRepository<AgentDefinition> {
  /** @param logger 日志口（可选）：`list()` 跳过读不出来的那一条时从它报一句，缺省不记 */
  constructor(agentsDir: string, logger: LogSink = SILENT_LOG) {
    super(agentsDir, logger);
  }
}
