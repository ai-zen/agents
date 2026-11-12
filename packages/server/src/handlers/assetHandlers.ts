/**
 * `asset.*`：上传入口（PRD D5 / F-H7 / F-H8）。
 *
 * 这一段在契约里是两个方法（`asset.begin` / `asset.end`）加一条二进制分帧通道，
 * 而它们都长在 WebSocket 上：分片要直接写进 `assets/` 的临时文件、要能按连接清理，
 * 所以由接线层（`net/WsHub` + `net/UploadReceiver`）直接接管，本文件**不重复注册**
 * 这两个方法名，只提供这一域的翻译工作与素材层给别处用的入口。
 *
 * 之所以仍然留着这个文件：附件结局（`AttachmentOutcome`）里的句子是在素材层（不知道
 * 收件人是谁）按默认语言渲染的，重渲染发生在接线层 —— 那是这一域的翻译，放在这里而不是
 * 散在 `conversation.send` 里。
 */

import { render } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { HandlerTable } from "../net/index.js";
import type { AttachmentOutcome, ProblemFact } from "../wire/index.js";

/**
 * `asset.*` 的 handler 表。
 *
 * 返回空表是**结论**而不是占位：`asset.begin` / `asset.end` 由 `WsHub` 在注入了
 * `UploadReceiver` 时自己接管（它要拿到连接 id 才能分帧落盘），这里再注册一份就成了两处
 * 实现，客户端会看到两个不同的答案。
 */
export function createAssetHandlers(): HandlerTable {
  return {};
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
