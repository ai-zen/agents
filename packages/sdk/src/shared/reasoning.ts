/**
 * 思考预设（reasoning presets）—— 档位读取、校验与参数写入的唯一实现
 *
 * ## 为什么是「表」而不是「字段」
 *
 * 档位不是全局统一枚举：各端点接受的值域互不相同，同一家不同型号也不同
 * （见 `config/reasoning-presets.ts` 的文档表）。所以本模块不判断「厂商是谁」，
 * 只做一件事：**在模型关联的那张策略表里查档位、写补丁**。
 *
 * 于是三个问题都变成查表，不需要任何 if/else 分支：
 *   1. 可选档位有哪些？      → `Object.keys(preset.levels)`
 *   2. 能不能关闭思考？      → 表里有没有 `off` 键
 *   3. 哪些参数键属于思考？  → 所有补丁里出现过的键的并集（写入前先剔除）
 *
 * 第 3 条是关键：有了它，从 `max` 切到 `off` 不会残留上一档的参数，而代码里
 * 一个键名都不必硬编码（`thinking` / `reasoning_effort` 只出现在策略表里）。
 */

import type {
  AgentDefinition,
  Model,
  ReasoningPreset,
  ReasoningPresets,
} from "../types/index.js";
/** 安全取自有属性（策略名源自用户配置，可能是 `constructor` / `__proto__` 等） */
function own<T>(bag: Record<string, T> | undefined, key: string): T | undefined {
  if (!bag || !Object.prototype.hasOwnProperty.call(bag, key)) return undefined;
  return bag[key];
}

/** 结构化相等 —— 补丁是纯 JSON，逐层比对即可 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(right, k) && sameValue(left[k], right[k]),
  );
}

/**
 * 模型关联的策略（未声明 `reasoningPreset`、或名字在表里不存在 → `undefined`）。
 *
 * 名字不存在时**不猜、不兜底**：宁可视作不可调档，也不把来路不明的参数发给服务端。
 */
export function presetOf(
  model?: Model | null,
  presets?: ReasoningPresets | null,
): ReasoningPreset | undefined {
  const name = model?.reasoningPreset;
  if (!name) return undefined;
  return own(presets ?? undefined, name);
}

/**
 * 模型可选的全部档位（顺序 = 策略表声明顺序）。
 *
 * 不再区分「档位」与「关闭」：表里的键就是菜单里的项。未关联策略 → 空数组。
 */
export function modelLevels(
  model?: Model | null,
  presets?: ReasoningPresets | null,
): string[] {
  const preset = presetOf(model, presets);
  if (!preset) return [];
  return Object.keys(preset.levels ?? {});
}

/**
 * 「思考参数键」的全集 —— **整张策略表**里任何补丁出现过的键。
 *
 * 用整张表而非单个策略，是为了让换策略时不留残渣：模型从 `deepseek` 改挂 `openai`
 * 时，旧策略写进去的 `thinking` 也必须被清掉（OpenAI 不认这个参数，带着就 400）。
 * 好处依旧：键名一个都不用在代码里硬编码，全部由表声明。
 */
function ownedKeys(presets: ReasoningPresets | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const preset of Object.values(presets ?? {})) {
    for (const patch of Object.values(preset?.levels ?? {})) {
      for (const key of Object.keys(patch ?? {})) keys.add(key);
    }
  }
  return keys;
}

/**
 * 反查当前档位：参数里命中哪个补丁的键值，就是哪一档。
 *
 * 与 `applyReasoningEffort()` 互为逆运算，两边共用同一张表。
 * 多张补丁同时命中时取**最具体**的那个（键最多的），键数相同取先声明的。
 *
 * 返回 `undefined` = 参数不完整匹配任何档位（例如 DeepSeek 出厂只写了
 * `thinking: { type: "enabled" }` 而没写 effort），展示层应视为「跟随模型默认」。
 */
export function readReasoningEffort(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  params?: Record<string, unknown> | null,
): string | undefined {
  const preset = presetOf(model, presets);
  if (!preset) return undefined;
  // 显式传 null = 「没有参数」，不回落模型默认；不传才读模型默认
  const actual = params === undefined ? model?.defaultParams : params;
  if (!actual) return undefined;

  let best: string | undefined;
  let bestSize = 0;
  for (const [level, patch] of Object.entries(preset.levels ?? {})) {
    const keys = Object.keys(patch ?? {});
    if (keys.length === 0 || keys.length <= bestSize) continue;
    if (!keys.every((k) => sameValue(actual[k], (patch as Record<string, unknown>)[k]))) continue;
    best = level;
    bestSize = keys.length;
  }
  return best;
}

/**
 * 把档位写成请求参数（不改入参）。
 *
 * 写入方式 = **先剔除思考参数键的旧值，再合并新补丁**。这样 `max` → `off` 不会残留
 * 上一档的 `reasoning_effort`，模型换策略也不会反刍旧策略的参数，而「哪些键属于思考」
 * 由策略表自己声明，代码零硬编码。
 *
 * @throws 模型未关联策略、或策略里没有该档位（绝不静默降级：档位写错必须当场发现）
 */
export function applyReasoningEffort(
  model: Model | null | undefined,
  presets: ReasoningPresets | null | undefined,
  level: string,
  params?: Record<string, unknown> | null,
): Record<string, unknown> {
  const id = model?.id ?? "(未知)";
  const name = model?.reasoningPreset;
  const preset = presetOf(model, presets);
  if (!preset) {
    throw new Error(
      name
        ? `模型 "${id}" 关联的思考策略 "${name}" 不存在（检查 reasoning-presets.json）`
        : `模型 "${id}" 未关联思考策略（reasoningPreset），无法设置档位`,
    );
  }

  const patch = own(preset.levels, level);
  if (!patch) {
    throw new Error(
      `策略 "${name}" 没有档位 "${level}"（可选：${Object.keys(preset.levels).join(" / ")}）`,
    );
  }

  const owned = ownedKeys(presets);
  const base = params === undefined ? model?.defaultParams : params;
  const kept = Object.entries(base ?? {}).filter(([key]) => !owned.has(key));
  return { ...Object.fromEntries(kept), ...patch };
}

/**
 * 解析某 Agent 的实际档位：Agent 声明优先，否则反查模型默认参数。
 *
 * 声明了但策略里没有这一档 → 退化为模型默认（宁可忽略设置，也不发非法参数）。
 */
export function resolveReasoningEffort(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "reasoningEffort"> | null,
): string | undefined {
  const declared = definition?.reasoningEffort;
  if (declared && modelLevels(model, presets).includes(declared)) return declared;
  return readReasoningEffort(model, presets);
}

/**
 * 把 Agent 的档位覆盖应用到模型参数上（`createModel` 用）。
 *
 * 未声明 `reasoningEffort` 时原样返回模型参数，保证既有行为不变。
 */
export function resolveModelParams(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "reasoningEffort"> | null,
): Record<string, unknown> | undefined {
  const declared = definition?.reasoningEffort;
  if (!declared) return model?.defaultParams;
  // 模型没关联策略、或策略里没这一档：保持模型默认，绝不发非法参数
  if (!modelLevels(model, presets).includes(declared)) return model?.defaultParams;
  return applyReasoningEffort(model, presets, declared);
}
