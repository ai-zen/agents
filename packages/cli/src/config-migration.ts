/**
 * 配置向下兼容层 / 防腐层
 *
 * 职责：
 * - 旧版配置 → 新版配置 的迁移
 * - 实体版本号补充
 * - 未来所有 schema 变更的兼容处理
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";

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
 * @param saved 从 config.json 读取的原始数据
 * @param agentsDir agents 目录路径（用于迁移旧 agents 到文件系统）
 * @returns 是否发生过变更（需要回写磁盘）
 */
export function migrateRawConfig(saved: any, agentsDir?: string): boolean {
  let changed = false;

  // 逐个执行迁移步骤
  changed = migrateAgentsSystemPrompt(saved) || changed;
  changed = migrateSubAgentsSystemPrompt(saved) || changed;
  changed = migrateSubAgentsToolConfig(saved) || changed;
  changed = migrateAgentsToFileSystem(saved, agentsDir) || changed;

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

/**
 * v1 → v2: agents 从 config.json 迁移到 ~/.ai-zen/agents/ 独立文件
 *
 * 将 config.json 中的 agents[] 数组中的每个 Agent
 * 写入到 agents/ 目录下的 {id}.json 文件。
 * 不删除 config.json 中的 agents 字段（标记已废弃，后续版本清理）。
 */
function migrateAgentsToFileSystem(saved: any, agentsDir?: string): boolean {
  if (!agentsDir) return false;
  if (!Array.isArray(saved.agents) || saved.agents.length === 0) return false;

  let changed = false;

  for (const agent of saved.agents) {
    if (!agent.id) continue;

    const filePath = join(agentsDir, `${agent.id}.json`);
    // 如果文件已存在，不覆盖（用户可能已经修改过文件）
    if (existsSync(filePath)) continue;

    try {
      writeFileSync(filePath, JSON.stringify(agent, null, 2), "utf-8");
      changed = true;
    } catch {
      // 单个文件写入失败不影响其他
    }
  }

  return changed;
}
