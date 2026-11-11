/**
 * 会话迁移策略的**缺省值** —— 运行期常量，不属于类型面。
 *
 * 形状（`MigrationStrategy`）在 `src/protocol/sessions.ts`；这里的值只服务本包实现
 * （`SessionManager` / `SessionHandoff` 的默认参数）。
 */

import type { MigrationStrategy } from "../protocol/sessions.js";

/** 缺省即 `prune`：等于「换 id 的旧行为」，不改历史，只是不再往新会话里带 */
export const DEFAULT_MIGRATION_STRATEGY: MigrationStrategy = "prune";
