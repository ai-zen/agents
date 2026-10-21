/**
 * 思考预设 —— 出厂内容 + 策略表文件名
 *
 * 这里的内容只是**初始值**：`ConfigManager.ensureReasoningPresets()` 在首次运行时把它
 * 写到 `<basePath>/reasoning-presets.json`，之后以磁盘文件为准（用户可改、可加）。
 * 与 `DEFAULT_APP_CONFIG` 写进 `config.json` 完全同一个套路。
 *
 * ## 为什么这份数据在 SDK
 *
 * 它是**跨客户端共享的资产**：CLI 用它决定 `/think` 能选哪几档，桌面端同理；两端不该
 * 各维护一份「智谱 5.3 只认 low/high/max」的知识。所以**定义、出厂内容、读写**都在 SDK。
 *
 * ## 但 SDK 不拿它生成请求参数
 *
 * 参数合并只有一条路：`{ ...model.defaultParams, ...agent.modelParams }`（见 `createModel`）。
 * 客户端读表 → 限制可选强度 → 把选中档位的补丁**写进** `AgentDefinition.modelParams`，
 * 于是配置本身就是事实，运行期不再查表。
 *
 * ## 为什么每张表长这样（**全部来自官方文档，不要凭印象改**）
 *
 * | 端点 | 官方依据 | 若写错会怎样 |
 * |------|---------|-------------|
 * | OpenAI | `openai-node` 的 `Shared.ReasoningEffort`（`none/minimal/low/medium/high/xhigh/max`） | 无 `thinking` 参数，写了会被当未知参数拒绝 → 表里干脆不出现该键 |
 * | DeepSeek | `api-docs.deepseek.com/guides/thinking_mode` | 可调 `low/high/max`；关闭用 `thinking.type = "disabled"` |
 * | 智谱 GLM-5.3 系 | `docs.bigmodel.cn/cn/guide/capabilities/thinking` | **只认** `low/high/max`，其余输入报错；**不再支持关闭**（传 disabled 也报错）→ 表里没有 `off` |
 * | 智谱 GLM-4.7 | 同上 | 强制思考且无 `reasoning_effort` 参数 → 不给它挂策略 |
 *
 * 三个结构性保证，都是「表的形状」带来的，不需要任何代码分支：
 *   1. 可选档位 = `Object.keys(levels)`，不会有「菜单里有、发出去报错」的档位；
 *   2. 能否关闭思考 = 表里有没有 `off` 键；
 *   3. 某个键属于思考参数 = 它在表里出现过 —— 写入时按此剔除旧值，不需要硬编码键名。
 */

import type { ReasoningPresets } from "../types/index.js";

/** 策略表文件名（位于 `<basePath>/` 下，与 `config.json` 同级） */
export const REASONING_PRESETS_FILE = "reasoning-presets.json";

/** 出厂策略表 */
export const FACTORY_REASONING_PRESETS: ReasoningPresets = {
  /** OpenAI 系：只认 `reasoning_effort`；关闭思考 = `"none"` */
  openai: {
    levels: {
      minimal: { reasoning_effort: "minimal" },
      low: { reasoning_effort: "low" },
      medium: { reasoning_effort: "medium" },
      high: { reasoning_effort: "high" },
      off: { reasoning_effort: "none" },
    },
  },

  /** 智谱 GLM-5.3 / 5.3-Flash / 5.3-FlashX：只认三档，且**不能关闭思考** */
  "zhipu-5.3": {
    levels: {
      low: { thinking: { type: "enabled" }, reasoning_effort: "low" },
      high: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      max: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    },
  },

  /** DeepSeek：`thinking` 开关 + `reasoning_effort`，可关闭 */
  deepseek: {
    levels: {
      low: { thinking: { type: "enabled" }, reasoning_effort: "low" },
      high: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      max: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      off: { thinking: { type: "disabled" } },
    },
  },
};
