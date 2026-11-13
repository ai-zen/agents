/**
 * `question.*` 两个方法的接线（PRD D22 / D23 / F-I9）。
 *
 * 两个事实只在这一层才拿得到，所以由 handler 递给服务层：
 *   - 这条连接的**语言**（`hello` 里协商出来，断开即忘，D8）；
 *   - 这条连接的 **id**（多端同时看一个问题时，「谁答的」要写进回答里）。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { QuestionService } from "../services/QuestionService.js";

export interface QuestionHandlerDeps {
  /** 只要本域用到的那两个方法（结构上 `QuestionService` 满足，用例可以给替身） */
  questions: Pick<QuestionService, "list" | "answer">;
}

/** 本域注册的方法 */
export type QuestionHandlers = Pick<HandlerTable, "question.list" | "question.answer">;

export function createQuestionHandlers(deps: QuestionHandlerDeps): QuestionHandlers {
  return {
    "question.list": async (context) =>
      await deps.questions.list(context.params, context.connection.language),
    "question.answer": async (context) =>
      await deps.questions.answer(context.params, {
        language: context.connection.language,
        answeredBy: context.connection.id,
      }),
  };
}
