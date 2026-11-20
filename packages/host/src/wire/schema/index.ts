/**
 * 方法名 → 入参形状（JSON-RPC 边界的唯一真相）。
 *
 * 一张表，两个用途：
 *   1. **运行期**：`WsHub.invoke` 在方法名确认之后、任何业务代码之前查一次表，查到了就
 *      `safeParse` —— 全仓只有这一处执行入参校验。`METHOD_NAMES` 里的 68 个方法一个不落：
 *      没有入参的那几个（`host.version` / `host.reload` / `agent.list` / `model.listImages` /
 *      `config.get`）也给 `z.object({})`，于是 `params: 42` 这种在边界上就被拒，而不是被静默
 *      当成「没给」。
 *   2. **类型**：`wire/methods.ts` 里那几份 `XxxParams` 是 `z.infer<typeof xxxParams>` 的推导
 *      结果 —— 契约面与校验面是同一份定义。
 *
 * 一域一文件（`session.ts` / `agent.ts` / `config.ts` …），这里只做汇总与再导出：谁要引用某个
 * 域里可复用的形状（`sessionIdSchema` / `agentIdSchema` / `sha256Schema` …），从哪个文件来都
 * 一样。
 *
 * **失败文案用的是既有的 reason 词**（`empty` / `not_an_object` / `not_a_file_name` /
 * `not_positive_integer` / `not_boolean` …），不是 Zod 的英文句子：出网的是码 + 参数，句子归
 * i18n 渲染（PRD D8）。
 */

import type { z } from "zod";

import {
  agentCreateParams,
  agentDeleteParams,
  agentGetParams,
  agentListParams,
  agentRestoreFactoryParams,
  agentSetModelParams,
  agentSetThinkingParams,
  agentUpdateParams,
} from "./agent.js";
import { assetBeginParams, assetEndParams, assetGetParams } from "./asset.js";
import { completionFilesParams } from "./completion.js";
import {
  configDeleteEndpointParams,
  configDeleteMcpParams,
  configGetDiscoveryParams,
  configGetParams,
  configPatchParams,
  configSaveEndpointParams,
  configSaveMcpParams,
  configSetDefaultsParams,
} from "./config.js";
import { handoffListDocumentsParams, handoffStartParams } from "./handoff.js";
import {
  hostHelloParams,
  hostReloadParams,
  hostSetLanguageParams,
  hostShutdownParams,
  hostUpgradeParams,
  hostVersionParams,
} from "./host.js";
import { messageListParams } from "./message.js";
import {
  modelCreateParams,
  modelDeleteImageParams,
  modelDeleteParams,
  modelListImagesParams,
  modelListParams,
  modelRestoreFactoryParams,
  modelSaveImageParams,
  modelUpdateParams,
} from "./model.js";
import { noticeClearParams, noticeDismissParams, noticeListParams } from "./notice.js";
import { questionAnswerParams, questionListParams } from "./question.js";
import { searchMessagesParams, searchSessionsParams } from "./search.js";
import {
  sessionAbortParams,
  sessionClearInboxParams,
  sessionCreateParams,
  sessionDeleteParams,
  sessionGetParams,
  sessionKillParams,
  sessionListParams,
  sessionPauseParams,
  sessionPinParams,
  sessionRenameParams,
  sessionResumeParams,
  sessionRevertParams,
  sessionSendParams,
  sessionSetModelParams,
  sessionSetThinkingParams,
  sessionSetThresholdsParams,
  sessionStartParams,
  sessionStateParams,
  sessionTransientParams,
} from "./session.js";
import {
  workspaceCreateParams,
  workspaceGetParams,
  workspaceListParams,
  workspaceRemoveParams,
  workspaceRenameParams,
} from "./workspace.js";

import type { MethodName } from "../methods.js";

export * from "./agent.js";
export * from "./asset.js";
export * from "./completion.js";
export * from "./config.js";
export * from "./handoff.js";
export * from "./host.js";
export * from "./message.js";
export * from "./model.js";
export * from "./notice.js";
export * from "./question.js";
export * from "./search.js";
export * from "./session.js";
export * from "./workspace.js";

/**
 * 已经迁到 schema 上的方法（现在是全部 68 个；新增方法时必须同步长一行 ——
 * `schema.test.ts` 的棘轮会当场红）。
 */
export const PARAM_SCHEMAS: Partial<Record<MethodName, z.ZodType>> = {
  "agent.create": agentCreateParams,
  "agent.delete": agentDeleteParams,
  "agent.get": agentGetParams,
  "agent.list": agentListParams,
  "agent.restoreFactory": agentRestoreFactoryParams,
  "agent.setModel": agentSetModelParams,
  "agent.setThinking": agentSetThinkingParams,
  "agent.update": agentUpdateParams,
  "asset.begin": assetBeginParams,
  "asset.end": assetEndParams,
  "asset.get": assetGetParams,
  "completion.files": completionFilesParams,
  "config.deleteEndpoint": configDeleteEndpointParams,
  "config.deleteMcp": configDeleteMcpParams,
  "config.get": configGetParams,
  "config.getDiscovery": configGetDiscoveryParams,
  "config.patch": configPatchParams,
  "config.saveEndpoint": configSaveEndpointParams,
  "config.saveMcp": configSaveMcpParams,
  "config.setDefaults": configSetDefaultsParams,
  "handoff.listDocuments": handoffListDocumentsParams,
  "handoff.start": handoffStartParams,
  "host.hello": hostHelloParams,
  "host.reload": hostReloadParams,
  "host.setLanguage": hostSetLanguageParams,
  "host.shutdown": hostShutdownParams,
  "host.upgrade": hostUpgradeParams,
  "host.version": hostVersionParams,
  "message.list": messageListParams,
  "model.create": modelCreateParams,
  "model.delete": modelDeleteParams,
  "model.deleteImage": modelDeleteImageParams,
  "model.list": modelListParams,
  "model.listImages": modelListImagesParams,
  "model.restoreFactory": modelRestoreFactoryParams,
  "model.saveImage": modelSaveImageParams,
  "model.update": modelUpdateParams,
  "notice.clear": noticeClearParams,
  "notice.dismiss": noticeDismissParams,
  "notice.list": noticeListParams,
  "question.answer": questionAnswerParams,
  "question.list": questionListParams,
  "search.messages": searchMessagesParams,
  "search.sessions": searchSessionsParams,
  "session.abort": sessionAbortParams,
  "session.clearInbox": sessionClearInboxParams,
  "session.create": sessionCreateParams,
  "session.delete": sessionDeleteParams,
  "session.get": sessionGetParams,
  "session.kill": sessionKillParams,
  "session.list": sessionListParams,
  "session.pause": sessionPauseParams,
  "session.pin": sessionPinParams,
  "session.rename": sessionRenameParams,
  "session.resume": sessionResumeParams,
  "session.revert": sessionRevertParams,
  "session.send": sessionSendParams,
  "session.setModel": sessionSetModelParams,
  "session.setThinking": sessionSetThinkingParams,
  "session.setThresholds": sessionSetThresholdsParams,
  "session.start": sessionStartParams,
  "session.state": sessionStateParams,
  "session.transient": sessionTransientParams,
  "workspace.create": workspaceCreateParams,
  "workspace.get": workspaceGetParams,
  "workspace.list": workspaceListParams,
  "workspace.remove": workspaceRemoveParams,
  "workspace.rename": workspaceRenameParams,
};
