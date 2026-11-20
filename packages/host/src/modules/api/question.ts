import { z } from "zod";

import type { QuestionRegistry } from "../question/registry.js";
import type { Trpc } from "./trpc.js";

/**
 * 题过 wire 的那一份。形状只有 `question/types.ts` 那一处，这里是它的声明式影子：
 * `.output()` 拿它校验出去的值，客户端照它生成类型。
 */
const choiceSchema = z.object({ value: z.string(), label: z.string() });

const questionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  message: z.string(),
  choices: z.array(choiceSchema).readonly(),
  blocking: z.boolean(),
  createdAt: z.number(),
});

/** 这一域只用得上登记表本身：题的生死全在 `QuestionRegistry` 上，返回值里也没有要翻译的东西 */
export interface QuestionApiDeps {
  readonly questions: QuestionRegistry;
}

export function questionRouter(deps: QuestionApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .input(z.object({ sessionId: z.string() }))
      .output(z.array(questionSchema))
      .query(({ input }) => deps.questions.list(input.sessionId)),

    /**
     * 答完就没了：这一次调用返回的是那道题在答之前的样子，之后按 id 已经查不到它。
     */
    answer: api.procedure
      .input(z.object({ questionId: z.string(), value: z.string() }))
      .output(questionSchema)
      .mutation(({ input }) => deps.questions.answer(input.questionId, input.value)),
  });
}
