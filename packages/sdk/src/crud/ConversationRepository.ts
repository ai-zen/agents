import type { Conversation } from "../types/index.js";
import { EntityRepository } from "../shared/EntityRepository.js";

/**
 * Conversation 仓储。
 * 每个 Conversation 一个 JSON 文件存储在 ${conversationsDir}/${id}.json。
 */
export class ConversationRepository extends EntityRepository<Conversation> {
  constructor(conversationsDir: string) {
    super(conversationsDir);
  }
}
