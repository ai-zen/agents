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
 * 2. **`Model.reasoning` → `Model.reasoningPreset`**
 *    alpha.13 曾用 `reasoning: { efforts, disable? }` 在模型上声明思考能力，后来改成
 *    「引用策略表里的名字」。未标 `custom` 的模型会被出厂定义整块覆盖，但**标了 `custom`
 *    的模型会原地保留**，于是留下一个无人认识的 `reasoning` 死字段，同时因为缺
 *    `reasoningPreset` 而默默失去调档能力。这里删掉旧字段，并按**同 id 的出厂模型**
 *    补上正确的策略名（同一 id 即同一厂商型号，协议能力不会因用户改过参数而变）。
 *
 * 迁移时机：`ConfigManager.read()` 读出即迁（内存里永远是当前形状）；
 * 落盘由 `ensureDefaultConfig()` 负责 —— 它比较迁移结果与磁盘原文，不同才写回，
 * 因此迁移只发生一次，且不会在每次启动时无谓地改写文件。
 */

import type { AppConfig, Model, TokenThresholds } from "../types/index.js";
import { DEFAULT_APP_CONFIG } from "./constants.js";

/** 当前字段名 */
export const TOKEN_THRESHOLDS_KEY = "tokenThresholds";

/** 已淘汰的旧字段名（仅迁移代码认识它们） */
export const LEGACY_TOKEN_FIELD = "maxContextTokens";
export const LEGACY_CHARS_FIELD = "maxContextChars";
export const LEGACY_REASONING_FIELD = "reasoning";

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
  [LEGACY_REASONING_FIELD]?: unknown;
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
 * 迁移单个模型的思考能力声明：`reasoning` → `reasoningPreset`。
 *
 * 只处理「旧字段存在」这一种情况：字段一旦落盘消失，用户后续主动删掉
 * `reasoningPreset`（表示「这个模型我不想调档」）就不会被反复补回来。
 */
export function migrateModelReasoning(model: Model): { model: Model; changed: boolean } {
  const source = model as unknown as Record<string, unknown>;
  if (!(LEGACY_REASONING_FIELD in source)) return { model, changed: false };

  const next: Record<string, unknown> = { ...source };
  delete next[LEGACY_REASONING_FIELD];

  // 同 id 的出厂模型能告诉我们「这个型号属于哪套协议」
  if (next.reasoningPreset === undefined) {
    const factory = (DEFAULT_APP_CONFIG.models ?? []).find((item) => item.id === model.id);
    if (factory?.reasoningPreset) next.reasoningPreset = factory.reasoningPreset;
  }

  return { model: next as unknown as Model, changed: true };
}

/**
 * 迁移整个配置。只处理对话模型（`models`）——
 * 图片模型（`imageModels`）既没有上下文阈值、也没有思考概念。
 */
export function migrateConfig(config: AppConfig): { config: AppConfig; changed: boolean } {
  let changed = false;
  const models = (config.models ?? []).map((model) => {
    const thresholds = migrateModelThresholds(model);
    const reasoning = migrateModelReasoning(thresholds.model);
    if (thresholds.changed || reasoning.changed) changed = true;
    return reasoning.model;
  });
  if (!changed) return { config, changed };
  return { config: { ...config, models }, changed };
}
