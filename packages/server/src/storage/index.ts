/**
 * 存储层出口：`Database`（worker 里的 node:sqlite）+ 迁移 + 一表一仓储。
 *
 * 这里不导出任何单例：`Database` 由单根（`app.ts`）创建后注入给各仓储与服务，
 * 谁创建谁负责 `close()`。这样做的好处是测试与多实例可以各开各的库，互不影响。
 */

export { Database } from "./Database.js";
export type {
  RunResult,
  TxClient,
  TxKind,
  TxOutcome,
  TxPlan,
  TxStatement,
  TxValue,
} from "./Database.js";

export { migrate, MIGRATIONS } from "./migrations.js";
export type { Migration } from "./migrations.js";

export { MetaRepository } from "./MetaRepository.js";
export { WorkspaceRepository } from "./WorkspaceRepository.js";
export { ConversationRepository } from "./ConversationRepository.js";
export { MessageRepository } from "./MessageRepository.js";
export { AssetRepository } from "./AssetRepository.js";
export { NoticeRepository } from "./NoticeRepository.js";
export { QuestionRepository } from "./QuestionRepository.js";
export { CredentialRepository, hashCredential } from "./CredentialRepository.js";
export type { QuestionPatch } from "./QuestionRepository.js";

export type * from "./types.js";
