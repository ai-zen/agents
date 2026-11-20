/**
 * `model.*` 的接线壳（F-F3 / F-F4 / F-F7 / F-B8）。
 *
 * 业务判断在 `services/ModelService.ts`；这里只转发 + 按连接语言重渲染句子（D8）。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { ModelService } from "../services/ModelService.js";
import { localizeLocalizedTexts } from "./configHandlers.js";

/** 本文件负责的方法名 */
export type ModelHandlerName =
  | "model.list"
  | "model.listImages"
  | "model.create"
  | "model.update"
  | "model.delete"
  | "model.restoreFactory"
  | "model.saveImage"
  | "model.deleteImage";

/** 本文件产出的 handler 表片段 */
export type ModelHandlers = Pick<HandlerTable, ModelHandlerName>;

/** 接线壳的依赖 */
export interface ModelHandlerDeps {
  models: ModelService;
}

/** 造出 `model.*` 的 handler 表 */
export function createModelHandlers(deps: ModelHandlerDeps): ModelHandlers {
  return {
    "model.list": async (context) =>
      localizeLocalizedTexts(await deps.models.list(context.params), context.connection.language),
    "model.listImages": async (context) =>
      localizeLocalizedTexts(await deps.models.listImages(), context.connection.language),
    "model.create": async (context) =>
      localizeLocalizedTexts(await deps.models.create(context.params), context.connection.language),
    "model.update": async (context) =>
      localizeLocalizedTexts(await deps.models.update(context.params), context.connection.language),
    "model.delete": async (context) =>
      localizeLocalizedTexts(await deps.models.delete(context.params), context.connection.language),
    "model.restoreFactory": async (context) =>
      localizeLocalizedTexts(
        await deps.models.restoreFactory(context.params),
        context.connection.language,
      ),
    "model.saveImage": async (context) =>
      localizeLocalizedTexts(
        await deps.models.saveImage(context.params),
        context.connection.language,
      ),
    "model.deleteImage": async (context) =>
      localizeLocalizedTexts(
        await deps.models.deleteImage(context.params),
        context.connection.language,
      ),
  };
}
