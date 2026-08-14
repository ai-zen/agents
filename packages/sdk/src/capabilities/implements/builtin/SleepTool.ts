import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

export class SleepTool extends SdkCallbackTool {

  function: AgentNS.FunctionDefine = {
    name: "sleep",
    description:
      "等待指定的时间（毫秒）。用于需要延迟执行的场景，例如等待其他操作完成、操作间隔控制等。注意：过长的等待时间会影响响应速度，建议不超过 30000 毫秒（30 秒）。",
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "number",
          description: "等待的毫秒数（1 秒 = 1000 毫秒）。建议不超过 30000（30 秒）。",
        },
      },
      required: ["ms"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { ms: number }, ctx?: ToolCallContext): Promise<string> {
    const ms = input.ms;

    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      return JSON.stringify({
        success: false,
        error: "ms 必须是正整数",
      });
    }

    if (ms > 300_000) {
      // 超过 5 分钟给出警告
      return JSON.stringify({
        success: false,
        error: `等待时间 ${ms}ms 过长，建议不超过 300000ms（5 分钟）。如需长时间等待请分段执行。`,
      });
    }

    // 若 signal 已处于 aborted，直接返回中断结果，避免不必要的等待
    const signal = ctx?.signal;

    // 等待 ms 毫秒，中断（abort）时提前结束
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });

    if (signal?.aborted) {
      return JSON.stringify({
        success: false,
        aborted: true,
        error: "等待被中断（aborted）",
      });
    }

    return JSON.stringify({
      success: true,
      waitedMs: ms,
      waitedSeconds: (ms / 1000).toFixed(1),
      message: `已等待 ${ms}ms（${(ms / 1000).toFixed(1)} 秒）`,
    });
  }
}
