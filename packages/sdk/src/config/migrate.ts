/**
 * 配置字段迁移 —— 历史形状升级到当前形状
 *
 * 三条遗留字段被淘汰：
 *
 * 1. `Model.maxContextTokens` / `Model.maxContextChars` → **`Model.tokenThresholds`**
 *    旧名字一直在误导：它既不是「模型的真实上下文窗口」，也不是单一概念。现在拆成两条线：
 *    `handoff`（交接阈值，软线）与 `guard`（强行阻断阈值，硬线）。
 *    `maxContextChars` 是 token 口径之前的历史遗留，按 `floor(chars / 4)` 折成 tokens
 *    （与旧代码的回退算法一致）后并入 `handoff`。
 *
 * 迁移时机：`ConfigManager.read()` 读出即迁（内存里永远是当前形状）；
 * 落盘由 `ensureDefaultConfig()` 负责 —— 它比较迁移结果与磁盘原文，不同才写回，
 * 因此迁移只发生一次，且不会在每次启动时无谓地改写文件。
 */

import type { AppConfig, Model, TokenThresholds } from "../types/index.js";

/** 当前字段名 */
export const TOKEN_THRESHOLDS_KEY = "tokenThresholds";

/** 已淘汰的旧字段名（仅迁移代码认识它们） */
export const LEGACY_TOKEN_FIELD = "maxContextTokens";
export const LEGACY_CHARS_FIELD = "maxContextChars";

/**
 * 旧数据缺失阈值时的交接阈值兜底。
 *
 * 与 CLI 新建模型的默认值一致；宁可给一个保守值，也不要让模型缺阈值——
 * 缺阈值意味着既没有交接触发、也没有阻断保护。
 */
export const DEFAULT_HANDOFF_THRESHOLD = 128_000;


/** 旧形状的模型条目（运行时才需要认识这些字段） */
type LegacyModel = Model & {
  [LEGACY_TOKEN_FIELD]?: unknown;
  [LEGACY_CHARS_FIELD]?: unknown;
  /** 中间版本曾用过的单值字段（未发布，仅防御性兼容） */
  tokenThreshold?: unknown;
};

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function readThresholds(value: unknown): Partial<TokenThresholds> {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  return {
    handoff: toPositiveInt(raw.handoff),
    guard: toPositiveInt(raw.guard),
  };
}

/**
 * 迁移单个模型条目。
 *
 * 优先级：已有 `tokenThresholds` 的成员 > 旧 tokens 字段 > 旧 chars 字段折算 > 兜底默认。
 * 旧字段一律删除（连同一份数据里残留的脏值），保证迁移后的形状唯一。
 * 已有 `handoff` 但缺 `guard` 时按 1.5 倍补齐。
 */
export function migrateModelThresholds(model: Model): { model: Model; changed: boolean } {
  const source = model as LegacyModel;
  const current = readThresholds((source as unknown as Record<string, unknown>)[TOKEN_THRESHOLDS_KEY]);
  const legacyTokens = toPositiveInt(source[LEGACY_TOKEN_FIELD]);
  const legacyChars = toPositiveInt(source[LEGACY_CHARS_FIELD]);
  const legacySingle = toPositiveInt(source.tokenThreshold);

  const hasLegacy =
    LEGACY_TOKEN_FIELD in source ||
    LEGACY_CHARS_FIELD in source ||
    "tokenThreshold" in source;
  const complete = current.handoff !== undefined && current.guard !== undefined;

  if (!hasLegacy && complete) return { model, changed: false };

  const fromChars = legacyChars !== undefined ? Math.max(1, Math.floor(legacyChars / 4)) : undefined;
  const handoff =
    current.handoff ?? legacyTokens ?? fromChars ?? legacySingle ?? DEFAULT_HANDOFF_THRESHOLD;
  // 旧数据里没有 guard 这一项：按重构前 ContextGuardPlugin 的默认 ratio（1.5）折算一次，
  // 让迁移后的实际行为与迁移前一致。这是**一次性**换算，落盘后两个值都是整数，
  // 运行时不再有任何倍数关系（想调硬线就直接改 guard 的数字）。
  const guard = current.guard ?? Math.round(handoff * 1.5);

  const next: Record<string, unknown> = { ...(source as unknown as Record<string, unknown>) };
  delete next[LEGACY_TOKEN_FIELD];
  delete next[LEGACY_CHARS_FIELD];
  delete next.tokenThreshold;
  next[TOKEN_THRESHOLDS_KEY] = { handoff, guard };

  return { model: next as unknown as Model, changed: true };
}

/**
 * 迁移整个配置。只处理对话模型（`models`）——
 * 图片模型（`imageModels`）从来没有上下文阈值概念。
 */
export function migrateConfig(config: AppConfig): { config: AppConfig; changed: boolean } {
  let changed = false;
  const models = (config.models ?? []).map((model) => {
    const result = migrateModelThresholds(model);
    if (result.changed) changed = true;
    return result.model;
  });
  if (!changed) return { config, changed };
  return { config: { ...config, models }, changed };
}
