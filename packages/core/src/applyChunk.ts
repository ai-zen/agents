/**
 * 一片增量（`AgentNS.Delta`）→ 就地攒进一条 assistant 消息。**这一件事在 core 里只有这一份实现。**
 *
 * 本文件处理的**是那一片增量本身**，不是任何外壳：厂商 chunk 里的 `choices[0].delta`、
 * 宿主推给客户端的 `message.delta` 载荷 —— 说的都是 `AgentNS.Delta`。所以它是独立导出的函数，
 * 而不是 `Agent.runTurn` 里的循环体：只看流的消费者（客户端镜像）要做的是同一件事，攒出来的
 * 对象必须与 core 手里那条**逐字一致**，否则「界面上的字」与「真正存下来的消息」迟早对不上，
 * 而症状只在某一类增量（数组内容段、半截工具参数）上显形 —— 那几条规则各有各的边界情形，
 * 抄一遍就是抄漏一处。
 *
 * 流末的 `usage` 与 `finish_reason` **不属于这一片增量**（它们说的是「这次响应花了多少、为什么
 * 停下」）：core 那边由 `runTurn` 从 chunk 的外层取，客户端那边由 `message.changed` 整条回来。
 *
 * 没有返回值：要「这一片新增了什么」读原始片（`Delta` 本身就在描述它），要「到目前为止有什么」
 * 读 `receiver` —— 它就地更新，不需要中间的转述对象。
 *
 * ## 只 import 类型，运行期零依赖
 *
 * `AgentNS` 只出现在类型位置，编译后抹掉：本模块的产物除了自己什么都不 import。客户端要
 * 折流时直接用它，不必因此把 `openai` 拖进自己的打包产物。
 */

import type { AgentNS } from "./AgentNS.js";

/**
 * 把一片增量攒进 `receiver`。
 *
 * 就地改 `receiver`（正文 / 推理 / 工具调用），不返回新对象 ——
 * 调用方手里那个引用就是「正在拼的那条消息」，换对象会让已经挂在它上面的引用（事件载荷、
 * 订阅方刚收到的那条消息、客户端的镜像）指着一条不再更新的旧消息。
 *
 * 一片什么都不带的增量（`{}`）是合法的：正文不动，别的字段也不动 —— 攒消息的规则只认
 * 这片增量**自己带的字段**。
 */
export function applyChunk(receiver: AgentNS.Message, delta: AgentNS.Delta): void {
  if (delta?.content) {
    if (delta.content instanceof Array) {
      // 一片里可以带多段（各自的 `index` 不同）：整数组遍历，按 `index` 归位。
      // 只看 `[0]` 会把同一片里其余段静默丢掉 —— 丢的可能是正文、也可能是图片，
      // 而且只在「一片多段」的流上显形（多数厂商一片一段，所以它很久没被发现）。
      // 空数组（不带段）不动任何东西：下面这段只为「真的有段」的片子准备。
      if (delta.content.length > 0) {
        if (!(receiver.content instanceof Array)) {
          receiver.content = [];
        }

        for (const deltaSection of delta.content) {
          const index = deltaSection.index!;

          if (!receiver.content[index]) {
            // 首片**只放声明字段**（`index` / `type`）：正文与 `url` 一律走下面的 `+=`。
            // 把整片 `...deltaSection` 铺进来的话，首片自带的正文会被拼两遍（`"A"` → `"AA"`），
            // 首片自带的 `image_url` 会被拼成 `"[object Object]…"`。
            receiver.content[index] = {
              index,
              type: deltaSection.type,
            } as AgentNS.MessageContentSection;
          }

          if ("image_url" in deltaSection) {
            const currentSection = receiver.content[index] as AgentNS.ImageUrlContentSection;
            currentSection["type"] = "image_url";
            currentSection["image_url"] ??= { url: "" };
            // `image_url` 是对象 `{ url, detail }`：要续的是它的 `url` 这个字符串
            currentSection["image_url"].url += deltaSection.image_url?.url ?? "";
            if (deltaSection.image_url?.detail) {
              currentSection["image_url"].detail = deltaSection.image_url.detail;
            }
          }

          if ("text" in deltaSection) {
            const currentSection = receiver.content[index] as AgentNS.TextContentSection;
            currentSection["type"] = "text";
            currentSection["text"] ??= "";
            currentSection["text"] += deltaSection.text ?? "";
          }
        }
      }
    } else {
      // 两种形状**不混**：已经攒成段数组的，来了字符串 delta 就把它包成一段 `text` 追进去 ——
      // 赋值成一个字符串会把握到此刻的段整段抹掉。
      if (receiver.content instanceof Array) {
        receiver.content.push({ type: "text", text: delta.content });
      } else {
        if (typeof receiver.content != "string") {
          receiver.content = "";
        }

        receiver.content += delta.content;
      }
    }
  }

  if (delta?.tool_calls) {
    if (!receiver.tool_calls) {
      receiver.tool_calls = [];
    }

    // 一片里可以带多个调用（并行工具调用就是这么发的）：整数组遍历，按 `index` 归位。
    // 只看 `[0]` 会把同片里其余调用整条丢掉 —— 模型说要调三个工具，这里只攒出一个。
    for (const deltaToolCall of delta.tool_calls) {
      const index = deltaToolCall.index!;

      if (!receiver.tool_calls[index]) {
        // 顺序不能反：先铺这一片原样的字段，再把它里面那个 `function` 换成归一过的一份。
        // 反过来的话，`...deltaToolCall` 里的 `function` 会把上面那份整个盖掉 ——
        // 首片只给 `name` 不给 `arguments` 时，攒参数的串就变成了 `undefined`。
        receiver.tool_calls[index] = {
          ...deltaToolCall,
          index,
          function: {
            name: "",
            arguments: "",
            ...deltaToolCall.function,
          },
        };
      }

      if (deltaToolCall.id) {
        receiver.tool_calls[index]["id"] = deltaToolCall.id;
      }

      if (deltaToolCall.function?.name) {
        receiver.tool_calls[index]["function"]!["name"] = deltaToolCall.function.name;
      }

      if (deltaToolCall.function?.arguments) {
        // 攒到此刻的那一段（厂商显式给了 `arguments: undefined` 时也不能变成 "undefined"）
        const accumulated = receiver.tool_calls[index]["function"]!["arguments"] ?? "";
        // 两种厂商行为都要认：有的把「到目前为止的整串」重发（本次串以已攒的为前缀），
        // 有的只发新增那一段（向前接上）。
        if (deltaToolCall.function.arguments.startsWith(accumulated)) {
          receiver.tool_calls[index]["function"]!["arguments"] = deltaToolCall.function.arguments;
        } else {
          receiver.tool_calls[index]["function"]!["arguments"] =
            accumulated + deltaToolCall.function.arguments;
        }
      }
    }
  }

  if (delta?.function_call) {
    if (!receiver.function_call) {
      receiver.function_call = {
        name: "",
        arguments: "",
        ...delta.function_call,
      };
    }

    if (delta.function_call.name) {
      receiver.function_call!.name = delta.function_call.name;
    }

    if (delta.function_call.arguments) {
      receiver.function_call!.arguments =
        (receiver.function_call!.arguments ?? "") + delta.function_call.arguments;
    }
  }

  if (delta?.reasoning_content) {
    if (typeof receiver.reasoning_content != "string") {
      receiver.reasoning_content = "";
    }

    receiver.reasoning_content += delta.reasoning_content;
  }
}
