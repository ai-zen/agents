/**
 * 一次性模型调用 —— 「不流式、不带工具、问一句答一句」的唯一实现。
 *
 * ## 为什么要有它
 *
 * 产品里有几处「辅助小请求」：交接文档的 `summary` 模式、会话自动起名。它们的共同点是
 * **不是对话**：没有消息历史要维护、没有工具、不流式、结果用完即弃。如果各自
 * `client.chat.completions.create(...)` 一遍，就会各写一份「要不要 stream / 带不带 tools /
 * modelConfig 怎么摊开 / signal 怎么传」—— 这四件事写错任何一样都不会报错，只会让请求
 * 变成另一种东西（例如带了 `stream: true` 于是拿到的正文永远是空的）。
 *
 * 所以：请求体的形状只在这里拼一次，两处（`HandoffService.generateSummary`、服务端的
 * 自动标题）都从这里走。
 *
 * ## 为什么返回字符串而不是整条 response
 *
 * 调用方要的都是「模型说了什么」。把 response 交出去，每个调用方都会再写一次
 * `choices[0]?.message?.content ?? ""`，而 `?? ""` 与「空正文算失败」是两种不同的态度：
 * 前者交给调用方判（`summary` 模式把空正文当失败并抛错，标题直接留空），本函数不替它们选。
 *
 * ## 为什么取消信号走第二参数
 *
 * 与 `core/Agent.ts` 调用模型时一致：`signal` 属于 `RequestOptions`（HTTP 层），塞进 body
 * 不会被 OpenAI SDK 当成取消信号，请求照样会跑完。
 */

import type OpenAI from "openai";
import type { ModelParams } from "../types/index.js";

export interface CompleteOnceInput {
  /** 已装配好的客户端（`createModel` / `createModelFromConfig` 的产物） */
  client: OpenAI;
  /** 发给端点的模型名（`modelName || id`） */
  model: string;
  /** 模型参数（同 `model.defaultParams` + 覆盖），展开进 body */
  modelConfig?: ModelParams;
  /** 一次性指令（角色是 system） */
  system: string;
  /** 这一次要处理的输入（角色是 user） */
  user: string;
  /** 取消 / 超时信号；触发后请求真的被中断 */
  signal?: AbortSignal;
}

/** 发一次非流式请求，返回正文（模型没给正文时是空串，由调用方判成败） */
export async function completeOnce(input: CompleteOnceInput): Promise<string> {
  const { client, model, modelConfig, system, user, signal } = input;

  const response = await client.chat.completions.create(
    {
      model,
      ...(modelConfig ?? {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    signal ? { signal } : undefined,
  );

  return response.choices?.[0]?.message?.content ?? "";
}
