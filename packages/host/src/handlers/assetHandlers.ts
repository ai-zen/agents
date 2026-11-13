/**
 * `asset.*`：上传入口与取回（PRD D5 / F-H7 / F-H8）。
 *
 * `asset.begin` / `asset.end` 不在这张表里：它们长在 WebSocket 上（分片要直接写进 `assets/`
 * 的临时文件、要能按连接清理），由接线层（`net/WsHub` + `net/UploadReceiver`）直接接管，
 * 这里再注册一份就成了两处实现，客户端会看到两个不同的答案。
 *
 * `asset.get` 在这一格里：它不需要连接状态（不问「你是谁这条连接在做什么」），一条 WS 上的
 * JSON 请求/响应就够 —— 内容走 base64 回包，因此不涉及二进制下行帧的关联问题。
 *
 * 这一域还有一件翻译工作留在这里：附件结局（`AttachmentOutcome`）里的句子是在素材层（不知道
 * 收件人是谁）按默认语言渲染的，重渲染发生在接线层。
 */

import { render } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { HandlerTable } from "../net/index.js";
import type { AssetService } from "../services/AssetService.js";
import type { AssetGetParams, AttachmentOutcome, ProblemFact } from "../wire/index.js";

/** `asset.*` 的 handler 依赖 */
export interface AssetHandlerDeps {
  assets: AssetService;
}

/**
 * `asset.*` 的 handler 表。
 *
 * 只有 `asset.get`：另外两个方法由接线层接管（见文件头），返回空表才是结论而不是占位。
 */
export function createAssetHandlers(deps: AssetHandlerDeps): HandlerTable {
  return {
    // 按 id 取回内容：`assets` 是资源的唯一真相，历史里的 `__asset_id` 靠它重放
    "asset.get": async (context) => await deps.assets.getAsset(context.params as AssetGetParams),
  };
}

/** 一个附件结局的句子按这条连接的语言重渲染（码与参数不动，PRD D8） */
export function localizeOutcome(outcome: AttachmentOutcome, language: Language): AttachmentOutcome {
  if (outcome.problem === null) return outcome;
  const problem: ProblemFact = {
    ...outcome.problem,
    message: render(language, outcome.problem.messageKey, outcome.problem.params),
  };
  return { ...outcome, problem };
}
