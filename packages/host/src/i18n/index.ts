import { en } from "./en.js";
import { zh } from "./zh.js";

/**
 * 文案层：一个键 + 一组参数 → 一句当前语言的话。
 *
 * 语言挂在连接上（PRD D8）：`hello` 带可选 `language`，断开即忘；缺省用配置里的默认语言。
 * 所以这里只有「按语言渲染」这一件事，不持有任何进程级语言状态 —— 渲染由调用方把语言传进来。
 *
 * 需要落库的东西（通知、问题、消息上的失败说明）入库的是「码 + 参数」，读取时再按连接语言
 * 渲染（PLAN §8）；本文件的 `render` 就是那一步。
 */

/** 文案键：集合以 `en.ts` 为准 */
export type MessageKey = keyof typeof en;

/** 支持的语言；增删语言只改这两处（`Language` 与 `DICTIONARIES`） */
export type Language = "en" | "zh";

/** 默认语言（PRD D8：缺省英文） */
export const DEFAULT_LANGUAGE: Language = "en";

/** 全部受支持的语言，按展示顺序 */
export const LANGUAGES: readonly Language[] = ["en", "zh"];

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, zh };

/**
 * 把外部给的值收敛成受支持的语言；认不出来就回落默认语言。
 *
 * `hello` 里的 `language` 来自客户端、可能缺失或写错，收敛点只有这一处，
 * 免得「en-US」「zh-CN」「EN」在调用链上各被解释一次。
 */
export function normalizeLanguage(value: unknown): Language {
  if (typeof value !== "string") return DEFAULT_LANGUAGE;
  const lowered = value.trim().toLowerCase();
  if (lowered === "") return DEFAULT_LANGUAGE;
  // 先认整串，再认 `zh-CN` / `en_US` 这类带地区的写法
  const exact = LANGUAGES.find((language) => language === lowered);
  if (exact) return exact;
  const base = lowered.split(/[-_]/)[0] ?? "";
  const matched = LANGUAGES.find((language) => language === base);
  return matched ?? DEFAULT_LANGUAGE;
}

/** 运行时判断某个字符串是不是已知文案键（`hasMessage("error.busy")`） */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/**
 * 取原始模板；键不存在时返回 undefined。
 *
 * 供「按码取模板」的场合使用（例如把库里的旧码渲染出来），找不到时由调用方决定说什么。
 */
export function template(language: Language, key: MessageKey): string | undefined {
  return DICTIONARIES[language][key];
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * 渲染一条文案：`render("zh", "error.notFound", { entity: "会话" })`。
 *
 * 占位符 `{name}` 从 `params` 里取。取不到值时**原样留下占位符**：把 `undefined` 拼进
 * 句子会让界面出现「存在 undefined」这种更难解释的东西，留下 `{name}` 至少指明了缺什么。
 * 非字符串的值按可读形式拼接（数字、布尔直出，其余 JSON 化）。
 */
export function render(
  language: Language,
  key: MessageKey,
  params?: Record<string, unknown>,
): string {
  const source = DICTIONARIES[language][key];
  if (params === undefined) return source;
  return source.replace(PLACEHOLDER, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    if (value === null) return whole;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    // `bigint` 已在上一行被 `String()` 接走；剩下的对象都由调用方就地造出来，没有环
    return JSON.stringify(value);
  });
}

export { en, zh };
