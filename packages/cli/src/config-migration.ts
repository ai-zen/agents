/**
 * 配置向下兼容层 / 防腐层
 *
 * 职责：
 * - 旧版配置 → 新版配置 的迁移
 * - 实体版本号补充
 * - 未来所有 schema 变更的兼容处理
 */

// ==================== 版本常量 ====================

/** 当前实体版本 */
export const CURRENT_VERSION = 1;

// ==================== 类型辅助 ====================

interface Versioned {
  version?: number;
}

// ==================== 迁移管线 ====================

/**
 * 对从磁盘读取的原始配置执行迁移
 * @returns 是否发生过变更（需要回写磁盘）
 */
export function migrateRawConfig(saved: any): boolean {
  let changed = false;

  // 逐个执行迁移步骤
  changed = migrateAgentsSystemPrompt(saved) || changed;
  changed = migrateSubAgentsSystemPrompt(saved) || changed;
  changed = migrateSubAgentsToolConfig(saved) || changed;

  return changed;
}

/**
 * 对内存中的 Config 对象补充版本号
 */
export function ensureVersions(config: {
  endpoints?: Versioned[];
  models?: Versioned[];
  imageModels?: Versioned[];
  agents?: Versioned[];
  subAgents?: Versioned[];
}): void {
  for (const item of config.endpoints || []) item.version ??= CURRENT_VERSION;
  for (const item of config.models || []) item.version ??= CURRENT_VERSION;
  for (const item of config.imageModels || []) item.version ??= CURRENT_VERSION;
  for (const item of config.agents || []) item.version ??= CURRENT_VERSION;
  for (const item of config.subAgents || []) item.version ??= CURRENT_VERSION;
}

// ==================== 各代迁移逻辑 ====================

/**
 * v0 → v1: agents.systemPrompt → agents.messages
 */
function migrateAgentsSystemPrompt(saved: any): boolean {
  if (!Array.isArray(saved.agents)) return false;
  let changed = false;

  for (const agent of saved.agents) {
    if (agent.systemPrompt && !agent.messages) {
      agent.messages = [{ role: "system", content: agent.systemPrompt }];
      delete agent.systemPrompt;
      changed = true;
    }
  }

  return changed;
}

/**
 * v0 → v1: subAgents.systemPrompt → subAgents.messages
 */
function migrateSubAgentsSystemPrompt(saved: any): boolean {
  if (!Array.isArray(saved.subAgents)) return false;
  let changed = false;

  for (const sub of saved.subAgents) {
    if (sub.systemPrompt && !sub.messages) {
      sub.messages = [{ role: "system", content: sub.systemPrompt }];
      delete sub.systemPrompt;
      changed = true;
    }
  }

  return changed;
}

/**
 * v0 → v1: subAgents.toolConfig → subAgents.function
 */
function migrateSubAgentsToolConfig(saved: any): boolean {
  if (!Array.isArray(saved.subAgents)) return false;
  let changed = false;

  for (const sub of saved.subAgents) {
    if (sub.toolConfig && !sub.function) {
      sub.function = sub.toolConfig;
      delete sub.toolConfig;
      changed = true;
    }
  }

  return changed;
}
