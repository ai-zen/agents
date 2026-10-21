/**
 * 思考强度（reasoning effort）—— 能力声明、可用档位与参数写入的唯一实现
 *
 * 为什么要有这一层：档位不是全局统一枚举，各端点接受的值域**互不相同**，而且
 * 同一家不同型号也不同（智谱文档原文）：
 *
 * | 端点 | 官方依据 | 可调档位 | 能否关闭 |
 * |------|---------|---------|---------|
 * | DeepSeek | `/guides/thinking_mode` | `low / high / max` | 能，`thinking.type = "disabled"` |
 * | 智谱 GLM-5.3 系 | `/cn/guide/capabilities/thinking` | `low / high / max`（**其余报错**） | **不能**，传 disabled 直接报错 |
 * | 智谱 GLM-5.2 | 同上 | `none / minimal / low / medium / high / xhigh / max` | 能（`none` 或 `disabled`） |
 * | OpenAI | `openai-node` 的 `Shared.ReasoningEffort` | `minimal / low / medium / high`（枚举含 none/xhigh/max） | 能，`reasoning_effort = "none"` |
 *
 * 所以「能力声明在模型上，Agent 只能收窄」，写入时按声明选择表达方式，
 * 绝不把端点不认的值发出去。
 */

import type {
  AgentDefinition,
  Model,
  ReasoningCapability,
  ReasoningEffort,
} from "../types/index.js";

/** `defaultParams` 里承载开关的键 */
const THINKING_KEY = "thinking";
/** `defaultParams` 里承载档位的键 */
const EFFORT_KEY = "reasoning_effort";

const KNOWN_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 是否为合法档位值 */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (KNOWN_EFFORTS as readonly string[]).includes(value);
}

/** 模型的能力声明（缺省 = 不可调档） */
export function capabilityOf(model?: Model | null): ReasoningCapability | undefined {
  return model?.reasoning;
}

/**
 * 模型可调的档位（不含 `off`）。
 *
 * 未声明能力的模型返回空数组 —— 不猜、不给默认值，避免把非法参数发给服务端。
 */
export function modelEfforts(model?: Model | null): ReasoningEffort[] {
  return [...(capabilityOf(model)?.efforts ?? [])];
}

/**
 * 模型允许的全部取值（含 `off`）。
 *
 * `off` 只在声明了 `disable` 方式时出现：没有合法表达式时，「关闭思考」这个选项
 * 本身就不该出现在菜单里。
 */
export function modelAllowedEfforts(model?: Model | null): ReasoningEffort[] {
  const capability = capabilityOf(model);
  if (!capability) return [];
  return capability.disable ? ["off", ...capability.efforts] : [...capability.efforts];
}

function thinkingType(params?: Record<string, unknown> | null): string | undefined {
  const thinking = params?.[THINKING_KEY];
  if (typeof thinking !== "object" || thinking === null) return undefined;
  const type = (thinking as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * 从 `defaultParams` 读当前档位。
 *
 * 返回 `undefined` 表示「没有显式档位」：可能是模型默认开思考但没写 effort
 * （DeepSeek 出厂配置就是 `{thinking:{type:"enabled"}}`），也可能压根没有思考参数。
 * 展示层要区分这两种情况，请配合 `capabilityOf()` 判断。
 */
export function readReasoningEffort(
  params?: Record<string, unknown> | null,
): ReasoningEffort | undefined {
  if (thinkingType(params) === "disabled") return "off";
  const raw = params?.[EFFORT_KEY];
  if (typeof raw !== "string") return undefined;
  // `none` 与 `off` 语义一致（都表示不思考），统一归一为 off，避免菜单里出现两个「关」
  if (raw === "none") return "off";
  return isReasoningEffort(raw) ? raw : undefined;
}

/**
 * 按档位生成新的 `defaultParams`（不改入参）。
 *
 * 三种写入形态，取决于模型声明：
 * - `disable: "thinking"` → 同时维护 `thinking.type` 与 `reasoning_effort`
 * - `disable: "effort-none"` → 只写 `reasoning_effort`（OpenAI 不认 `thinking` 键，
 *   对它写 `thinking` 会被当作未知参数拒绝）
 * - 未声明 `disable`（如 GLM-5.3 系）→ 只写 `reasoning_effort`，传 `off` 直接抛错
 *
 * @throws 当档位为 `off` 而模型不支持关闭思考，或档位不在模型能力范围内
 */
export function applyReasoningEffort(
  params: Record<string, unknown> | undefined | null,
  model: Model | null | undefined,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const capability = capabilityOf(model);
  const next: Record<string, unknown> = { ...(params ?? {}) };

  if (effort === "off") {
    if (capability?.disable === "thinking") {
      next[THINKING_KEY] = { type: "disabled" };
      delete next[EFFORT_KEY];
      return next;
    }
    if (capability?.disable === "effort-none") {
      next[EFFORT_KEY] = "none";
      // 不在 OpenAI 的请求里塞 thinking：那是未知参数
      delete next[THINKING_KEY];
      return next;
    }
    throw new Error(`模型 "${model?.id ?? "(未知)"}" 不支持关闭思考`);
  }

  if (!capability) {
    throw new Error(`模型 "${model?.id ?? "(未知)"}" 未声明思考能力，无法设置档位`);
  }
  if (!capability.efforts.includes(effort)) {
    throw new Error(
      `模型 "${model?.id ?? "(未知)"}" 不支持档位 "${effort}"（可选：${capability.efforts.join(" / ")}）`,
    );
  }

  if (capability.disable === "thinking") {
    next[THINKING_KEY] = { type: "enabled" };
  }
  next[EFFORT_KEY] = effort;
  return next;
}

/**
 * 解析某 Agent 的实际档位：Agent 声明优先，否则看模型默认参数。
 */
export function resolveReasoningEffort(
  model?: Model | null,
  definition?: Pick<AgentDefinition, "reasoningEffort"> | null,
): ReasoningEffort | undefined {
  const declared = definition?.reasoningEffort;
  if (declared) {
    // 声明了但模型不支持 → 退化为模型默认，避免把非法值发给服务端
    const allowed = modelAllowedEfforts(model);
    if (allowed.length === 0 || allowed.includes(declared)) return declared;
  }
  return readReasoningEffort(model?.defaultParams);
}

/**
 * 把 Agent 的档位覆盖应用到模型参数上（`createModel` 用）。
 *
 * 未声明 `reasoningEffort` 时原样返回模型参数，保证既有行为不变。
 */
export function resolveModelParams(
  model?: Model | null,
  definition?: Pick<AgentDefinition, "reasoningEffort"> | null,
): Record<string, unknown> | undefined {
  const declared = definition?.reasoningEffort;
  if (!declared) return model?.defaultParams;
  const allowed = modelAllowedEfforts(model);
  // 模型不支持声明值：宁可保持模型默认，也不发非法参数
  if (allowed.length === 0 || !allowed.includes(declared)) return model?.defaultParams;
  return applyReasoningEffort(model?.defaultParams, model, declared);
}
