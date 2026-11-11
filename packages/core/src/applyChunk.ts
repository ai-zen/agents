/**
 * 一片流式 chunk → 就地攒进一条 assistant 消息。**这一件事在 core 里只有这一份实现。**
 *
 * ## 为什么它是独立导出的函数，而不是 `Agent.parseStreamData` 里的循环体
 *
 * 因为「chunk 长什么样」不是某一条链路的私事：服务端跑 `Agent` 时它要把 chunk 攒成消息，
 * 而任何**只看流**的消费者（客户端从服务端收 `chunk` 事件、诊断工具回放抓包）要做的是
 * 同一件事 —— 攒出来的对象必须与 core 手里那条**逐字一致**，否则「界面上的字」与「真正
 * 存下来的消息」迟早对不上，而症状只在某一类 chunk（数组内容段、半截工具参数）上显形。
 *
 * 第二份实现是这类漂移的唯一起点：把 `delta.content` 拼进 `content`、把
 * `delta.tool_calls[index].function.arguments` 续到当前串上、把流末的 `usage` /
 * `finish_reason` 钉到消息上 —— 每条规则都有自己的边界情形（内容段数组、参数串整段重发），
 * 抄一遍就是抄漏一处。
 *
 * 所以 `parseStreamData` 只剩「取 chunk → 广播 → 调这里 → 广播」四步，攒消息的规则全在本文件。
 *
 * ## 返回值是 `void`：本片「新增了什么」在原始片里，不另立形状
 *
 * 曾经这里返回过一个 `{ text, reasoning, completionTokens }`，理由是有调用方要拿它校准
 * 生成速率。那个类型就是错的：`chunk.choices[0].delta` 本身（以及它的类型 `AgentNS.Delta`）
 * 已经在描述「本片新增了什么」，再摘一份出来等于给同一个概念立第二个定义 —— 摘的时候必然
 * 少了 `tool_calls`、少了内容段数组里的图片段，于是「速率算的」与「真正吐的」各自演化。
 *
 * 要「这一片新增了什么」的调用方直接看原始片；要「到目前为止有什么」的看 `receiver` ——
 * 它就地更新，不需要任何中间对象转述。
 *
 * ## 只 import 类型，运行期零依赖
 *
 * `AgentNS` 与 `ChatCompletionChunk` 都只出现在类型位置，编译后抹掉：本模块的产物除了自己
 * 什么都不 import。客户端要折流时直接用它，不必因此把 `openai` 拖进自己的打包产物。
 */

import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { AgentNS } from "./AgentNS.js";

/**
 * 把一片 chunk 攒进 `receiver`。
 *
 * 就地改 `receiver`（正文 / 推理 / 工具调用 / `finish_reason` / `usage`），不返回新对象 ——
 * 调用方手里那个引用就是「这一轮正在拼的那条消息」，换对象会让已经挂在它上面的引用（事件
 * 载荷、`innerLoopTasks` 里的任务）指着一条不再更新的旧消息。
 *
 * 一片什么都不带的 chunk（只有 `id` / `model` 这类外层字段）是合法的：正文不动，别的字段
 * 也不动。收尾片通常如此，它唯一的作用是带 `usage` 或 `finish_reason`。
 */
export function applyChunk(receiver: AgentNS.Message, chunk: ChatCompletionChunk): void {
  // 流式最后一个 chunk 才带 usage：钉到本轮 assistant 消息上（与 finish_reason 同处），
  // 使用量随消息持久化，从而可按消息求和统计累计消耗（计费口径）与审计。
  // 「最近一次用量」（`lastUsage`）由该字段派生，不再单独存一份。
  if (chunk?.usage) {
    receiver.usage = chunk.usage as unknown as AgentNS.Usage;
  }

  if (!chunk?.choices?.[0]) return;

  const finishReason = chunk.choices[0].finish_reason;
  if (finishReason) {
    receiver.finish_reason = finishReason as AgentNS.FinishReason;
  }

  const delta_ = chunk.choices[0].delta as any;

  if (delta_?.content) {
    if (delta_.content instanceof Array) {
      if (delta_.content[0]) {
        const deltaSection = delta_.content[0];
        const index = deltaSection.index!;

        if (!(receiver.content instanceof Array)) {
          receiver.content = [];
        }

        if (!receiver.content[index]) {
          receiver.content[index] = {
            index,
            ...deltaSection,
          };
        }

        if ("image_url" in deltaSection) {
          const currentSection = receiver.content[index] as AgentNS.ImageUrlContentSection;
          currentSection["type"] = "image_url";
          currentSection["image_url"] ??= { url: "" };
          currentSection["image_url"].url += deltaSection.image_url;
        }

        if ("text" in deltaSection) {
          const currentSection = receiver.content[index] as AgentNS.TextContentSection;
          currentSection["type"] = "text";
          currentSection["text"] ??= "";
          currentSection["text"] += deltaSection.text;
        }
      }
    } else {
      if (typeof receiver.content != "string") {
        receiver.content = "";
      }

      receiver.content += delta_.content;
    }
  }

  if (delta_?.tool_calls) {
    if (delta_.tool_calls[0]) {
      const deltaToolCall = delta_.tool_calls[0];
      const index = deltaToolCall.index!;

      if (!receiver.tool_calls) {
        receiver.tool_calls = [];
      }

      if (!receiver.tool_calls[index]) {
        receiver.tool_calls[index] = {
          index,
          function: {
            name: "",
            arguments: "",
            ...deltaToolCall.function,
          },
          ...deltaToolCall,
        };
      }

      if (deltaToolCall.id) {
        receiver.tool_calls[index]["id"] = deltaToolCall.id;
      }

      if (deltaToolCall.function?.name) {
        receiver.tool_calls[index]["function"]!["name"] = deltaToolCall.function.name;
      }

      if (deltaToolCall.function?.arguments) {
        // 两种厂商行为都要认：有的把「到目前为止的整串」重发（本次串以已攒的为前缀），
        // 有的只发新增那一段（向前接上）。
        if (
          deltaToolCall.function.arguments.startsWith(
            receiver.tool_calls[index]["function"]!["arguments"]!,
          )
        ) {
          receiver.tool_calls[index]["function"]!["arguments"] = deltaToolCall.function.arguments;
        } else {
          receiver.tool_calls[index]["function"]!["arguments"] += deltaToolCall.function.arguments;
        }
      }
    }
  }

  if (delta_?.function_call) {
    if (!receiver.function_call) {
      receiver.function_call = {
        name: "",
        arguments: "",
        ...delta_.function_call,
      };
    }

    if (delta_.function_call.name) {
      receiver.function_call!.name = delta_.function_call.name;
    }

    if (delta_.function_call.arguments) {
      receiver.function_call!.arguments += delta_.function_call.arguments;
    }
  }

  if (delta_?.reasoning_content) {
    if (typeof receiver.reasoning_content != "string") {
      receiver.reasoning_content = "";
    }

    receiver.reasoning_content += delta_.reasoning_content;
  }
}
