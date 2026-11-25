import { z } from "zod";

import type { QuestionRegistry } from "../question/registry.js";
import type { FormAnswer, FormSchema } from "../question/types.js";
import type { Trpc } from "./trpc.js";

/**
 * 题过 wire 的那一份。形状只有 `question/types.ts` 那一处，这里是它的声明式影子：
 * `.output()` 拿它校验出去的值，客户端照它生成类型。
 *
 * `requestedSchema` 用 `z.custom`：字段那几种形状（字符串/数字/布尔/枚举/多选枚举）在 `types.ts`
 * 里是**判别联合**，在这里再抄一份就是第二份，抄漏一格不会报错、只会让客户端安静地少一个字段。
 */

/** 表单那一张表：形状只有 `question/types.ts` 一处，这里不抄第二份 */
const formSchema = z.custom<FormSchema>();

const formRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  message: z.string(),
  requestedSchema: formSchema,
  blocking: z.boolean(),
  createdAt: z.number(),
});

/** 作答三态：`accept` 才带 `content`，另两种带了也没有意义（登记表里会被丢掉） */
const answerSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<FormAnswer>;

/** 这一域只用得上登记表本身：题的生死全在 `QuestionRegistry` 上，返回值里也没有要翻译的东西 */
export interface QuestionApiDeps {
  readonly questions: QuestionRegistry;
}

export function questionRouter(deps: QuestionApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .input(z.object({ sessionId: z.string() }))
      .output(z.array(formRequestSchema))
      .query(({ input }) => deps.questions.list(input.sessionId)),

    /**
     * 答完就没了：这一次调用返回的是那道题在答之前的样子，之后按 id 已经查不到它。
     *
     * `accept` 的内容按题自己那张表校验一遍，形状不对是 `invalid_params`（见 `QuestionRegistry`
     * 的 `answer`）。
     */
    answer: api.procedure
      .input(z.object({ questionId: z.string(), answer: answerSchema }))
      .output(formRequestSchema)
      .mutation(({ input }) => deps.questions.answer(input.questionId, input.answer)),
  });
}
