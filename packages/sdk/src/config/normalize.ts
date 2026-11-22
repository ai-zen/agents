/**
 * 配置补位 —— 缺字段 / 非法值在启动时补成出厂值
 *
 * 依据 PRD 3.4：配置里少了字段、或值不合法，启动时补成出厂值。补完之后「配置即事实」——
 * 文件里写着的就是运行时用的，使用方不必各自 `?? 出厂值` 地兵分两路兜底。
 *
 * 这里**不是**迁移：本仓没有发过旧版本（PRD 1.9「不做…迁移或识别旧数据」），所以文件里
 * 没有一行「读旧形状」的代码。补位只往**空位**里放出厂值，用户写下的值一个都不改：
 *
 * - `Model.tokenThresholds`：`handoff`（交接线，软）与 `guard`（阻断线，硬）两条整数阈值，
 *   缺哪条补哪条（见 `normalizeModelThresholds`）；
 * - `AppConfig.abortedMessageStrategy` / `abortedToolRoundStrategy`：缺失或非法 → 出厂默认
 *   （见 `normalizeAbortStrategies`）；
 * - `Endpoint.capabilities`：整块缺失 → 同 id 出厂端点的能力位
 *   （见 `normalizeEndpointCapabilities`）。
 *
 * ## `defaultModel` 在这里不出现，是有意的
 *
 * 模型解析是三级（`会话级覆盖 > Agent 定义 > 本字段`，唯一实现在 `runtime/resolveModel.ts`），
 * `defaultModel` 就是**全局兜底层**。用户没配就没有兜底层，`createAgent` 会给出明确报错 ——
 * 那不是「缺省值缺位」，而是「用户没表态」。所以这里既不补也不清：清掉等于用户升级一次
 * 就静默丢一次自己配的兜底模型。
 *
 * 时机：`ConfigManager.read()` 读出即补位（内存里永远是当前形状）；落盘由
 * `ensureDefaultConfig()` 负责 —— 它比较补位结果与磁盘原文，不同才写回，因此补位只发生
 * 一次，且不会在每次启动时无谓地改写文件。
 */

import type { AppConfig, Model, TokenThresholds } from "../types/index.js";
import { DEFAULT_APP_CONFIG } from "./constants.js";

/** `Model` 上两条阈值的字段名（当前唯一的形状） */
const TOKEN_THRESHOLDS_KEY = "tokenThresholds";

/**
 * `handoff` 缺失时的兜底。
 *
 * 与 CLI 新建模型的默认值一致；宁可给一个保守值，也不要让模型缺阈值 ——
 * 缺阈值意味着既没有交接触发、也没有阻断保护。
 */
export const DEFAULT_HANDOFF_THRESHOLD = 128_000;

/** 缺 `guard` 时按 `handoff` 的这个倍数补：硬线在软线的 1.5 倍处（护栏的出厂口径） */
const GUARD_RATIO = 1.5;

/** 阈值只认正整数：0、负数、小数、非数字一律视为「这一格没填」 */
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
 * 补齐单个模型缺失的阈值。
 *
 * - 两条都在（都是合法正整数）→ 原样返回，`changed: false` 且连对象引用都不换；
 * - 只有 `handoff` → `guard` 按 1.5 倍补；
 * - 只有 `guard` → `handoff` 补 `DEFAULT_HANDOFF_THRESHOLD`（硬线是用户自己的选择，不动）；
 * - 两条都缺，或值不合法 → 两条都补出厂值。
 *
 * `changed` 就是「要不要写盘」的判据；入参对象不被就地修改（调用方手里的旧对象保持原样）。
 */
export function normalizeModelThresholds(model: Model): { model: Model; changed: boolean } {
  const current = readThresholds(
    (model as unknown as Record<string, unknown>)[TOKEN_THRESHOLDS_KEY],
  );
  if (current.handoff !== undefined && current.guard !== undefined) {
    return { model, changed: false };
  }

  const handoff = current.handoff ?? DEFAULT_HANDOFF_THRESHOLD;
  const guard = current.guard ?? Math.round(handoff * GUARD_RATIO);

  return { model: { ...model, tokenThresholds: { handoff, guard } }, changed: true };
}

/**
 * 收敛整个配置：模型阈值 + 中断策略 + 端点能力位。
 *
 * 只处理会话模型（`models`）—— 图片模型（`imageModels`）既没有上下文阈值、也没有思考概念。
 * 无改动时返回**原对象**（调用方靠 `changed` / 引用相等判断「不用写盘」）。
 */
export function normalizeConfig(config: AppConfig): { config: AppConfig; changed: boolean } {
  let changed = false;
  const models = (config.models ?? []).map((model) => {
    const thresholds = normalizeModelThresholds(model);
    if (thresholds.changed) changed = true;
    return thresholds.model;
  });

  const next = {
    ...config,
    models,
    // 端点数组浅拷贝：能力位补齐会改元素，不把副作用浇到调用方手里的旧对象上
    endpoints: (config.endpoints ?? []).map((endpoint) => ({ ...endpoint })),
  } as AppConfig;

  if (normalizeAbortStrategies(next)) changed = true;
  if (normalizeEndpointCapabilities(next)) changed = true;

  if (!changed) return { config, changed };
  return { config: next, changed };
}

/** 合法的中断策略取值（与 core 的枚举一致） */
export const ABORTED_MESSAGE_STRATEGIES = ["keep", "drop"] as const;
export const ABORTED_TOOL_ROUND_STRATEGIES = ["fill", "drop"] as const;

/** 缺失 / 非法 → 出厂默认；返回是否有改动（直接改写传入对象） */
export function normalizeAbortStrategies(config: AppConfig): boolean {
  let changed = false;
  if (
    !ABORTED_MESSAGE_STRATEGIES.includes(
      config.abortedMessageStrategy as (typeof ABORTED_MESSAGE_STRATEGIES)[number],
    )
  ) {
    config.abortedMessageStrategy = DEFAULT_APP_CONFIG.abortedMessageStrategy;
    changed = true;
  }
  if (
    !ABORTED_TOOL_ROUND_STRATEGIES.includes(
      config.abortedToolRoundStrategy as (typeof ABORTED_TOOL_ROUND_STRATEGIES)[number],
    )
  ) {
    config.abortedToolRoundStrategy = DEFAULT_APP_CONFIG.abortedToolRoundStrategy;
    changed = true;
  }
  return changed;
}

/**
 * 补齐端点**缺失**的能力位声明（`Endpoint.capabilities`）。
 *
 * ## 为什么要补
 *
 * `capabilities.filesApi` 是能力位里的一项 —— 它把 `view_image` 的判定从「端点 id
 * 是不是 `deepseek`」改成「看这一位」，而出厂只有 deepseek 打了 `true`。
 * 但端点**不参与出厂托管**（`ConfigManager.syncManagedModels` 明写「保持用户配置」），
 * 这一格也就没有别的路径会补 —— 只要配置里它是空的，这个 deepseek 端点的
 * `supportsFilesApi()` 就恒为 `false`：
 *
 *   · 出厂承诺的「deepseek 走 Files API」对这些配置从未生效；
 *   · 而且**全程静默** —— 「未声明能力位」和「缺 apiKey」两个分支都不发 warning，
 *     图片 / `view_image` / MCP 媒体就悄悄退化成 base64 内联，请求体随历史膨胀。
 *
 * 这是「默认值缺位」，不是「用户选择」，所以由这里补 —— 与模型清单不同，端点本身仍然
 * 归用户所有，我们只往**空位**里放出厂默认。
 *
 * ## 边界：只补整体缺失，绝不覆盖
 *
 * - `capabilities` **整体缺失** → 按**同 id 的出厂端点**补上整块；
 * - `capabilities` 已存在（哪怕是 `{}`、哪怕写着 `filesApi: false`）→ 一个字段都不动：
 *   用户已经表过态，`false` 就是「我不走 Files API」；
 * - 端点 id 不在出厂清单（用户自建）→ 不动：我们不知道它是否真有 `/files`，
 *   猜错会把上传请求打到不存在的接口上。
 *
 * @returns 是否有改动（直接改写传入对象）
 */
export function normalizeEndpointCapabilities(config: AppConfig): boolean {
  let changed = false;
  for (const endpoint of config.endpoints ?? []) {
    if (endpoint.capabilities != null) continue;
    const factory = (DEFAULT_APP_CONFIG.endpoints ?? []).find((item) => item.id === endpoint.id);
    if (!factory?.capabilities) continue;
    endpoint.capabilities = { ...factory.capabilities };
    changed = true;
  }
  return changed;
}
