/**
 * `config.*` 的接线壳（F-F1 / F-F2 / F-F6 / F-F7 / F-E2 / F-A8）。
 *
 * 这一层只做两件事：把入参交给服务，把出参里那些「已经按默认语言渲染好的句子」按**这条连接**
 * 的语言重渲染一次（PRD D8：语言挂在连接上，服务层存的是码 + 参数）。
 *
 * 业务判断都在 `services/ConfigService.ts`；这里没有一条分支是在决定「该怎么算」。
 */

import { hasMessage, render, type Language } from "../i18n/index.js";
import type { HandlerTable, MethodHandler } from "../net/WsHub.js";
import type { ConfigService } from "../services/ConfigService.js";

/** 本文件负责的方法名（其余域各有各的文件） */
export type ConfigHandlerName =
  | "config.get"
  | "config.patch"
  | "config.setDefaults"
  | "config.getDiscovery"
  | "config.saveMcp"
  | "config.deleteMcp"
  | "config.saveEndpoint"
  | "config.deleteEndpoint";

/** 本文件产出的 handler 表片段（单根把它摊进总表） */
export type ConfigHandlers = Pick<HandlerTable, ConfigHandlerName>;

/** 接线壳的依赖 */
export interface ConfigHandlerDeps {
  config: ConfigService;
}

/**
 * 把一段结构化结果里所有 `LocalizedText` 的句子换成目标语言。
 *
 * 判定按形状（`code` + `messageKey` + `params` + `message`）而不是认某个类：这些事实要能穿过
 * JSON-RPC 边界，形状本身就是契约（`wire/states.ts` 的 `LocalizedText`）。认不出来的原样留着
 * —— 渲染不出来时保留原句子比丢字段好。
 */
export function localizeLocalizedTexts<T>(value: T, language: Language): T {
  return walk(value, language, 0) as T;
}

function walk(value: unknown, language: Language, depth: number): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, language, depth + 1));
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  if (isLocalizedText(record) && hasMessage(record.messageKey)) {
    const message = render(
      language,
      record.messageKey,
      record.params as Record<string, unknown>,
    );
    const detail = "detail" in record ? { detail: walk(record.detail, language, depth + 1) } : {};
    return { ...record, message, ...detail };
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] = walk(item, language, depth + 1);
  }
  return result;
}

function isLocalizedText(record: Record<string, unknown>): record is Record<string, unknown> & {
  code: string;
  messageKey: string;
  message: string;
  params: Record<string, unknown>;
} {
  return (
    typeof record.code === "string" &&
    typeof record.messageKey === "string" &&
    typeof record.message === "string" &&
    typeof record.params === "object" &&
    record.params !== null &&
    !Array.isArray(record.params)
  );
}

/** 造出 `config.*` 的 handler 表 */
export function createConfigHandlers(deps: ConfigHandlerDeps): ConfigHandlers {
  return {
    "config.get": async (context) =>
      localizeLocalizedTexts(await deps.config.get(context.params), context.connection.language),
    "config.patch": async (context) =>
      localizeLocalizedTexts(await deps.config.patch(context.params), context.connection.language),
    "config.setDefaults": async (context) =>
      localizeLocalizedTexts(
        await deps.config.setDefaults(context.params),
        context.connection.language,
      ),
    "config.getDiscovery": async (context) =>
      localizeLocalizedTexts(
        await deps.config.getDiscovery(context.params),
        context.connection.language,
      ),
    "config.saveMcp": async (context) =>
      localizeLocalizedTexts(await deps.config.saveMcp(context.params), context.connection.language),
    "config.deleteMcp": async (context) =>
      localizeLocalizedTexts(
        await deps.config.deleteMcp(context.params),
        context.connection.language,
      ),
    "config.saveEndpoint": async (context) =>
      localizeLocalizedTexts(
        await deps.config.saveEndpoint(context.params),
        context.connection.language,
      ),
    "config.deleteEndpoint": async (context) =>
      localizeLocalizedTexts(
        await deps.config.deleteEndpoint(context.params),
        context.connection.language,
      ),
  };
}