import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

export class SleepTool extends SdkCallbackTool {

  function: AgentNS.FunctionDefine = {
    name: "sleep",
    description:
      "Wait for the specified time in milliseconds. Use it when a delay is needed, for example to wait for another operation to finish or to space out actions. Note: long waits slow down responses; keep it at or below 30000 milliseconds (30 seconds).",
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "number",
          description: "Milliseconds to wait (1 second = 1000 milliseconds). Values above 30000 (30 seconds) are not recommended.",
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
        error: "ms must be a positive integer",
      });
    }

    if (ms > 300_000) {
      // 超过 5 分钟给出警告
      return JSON.stringify({
        success: false,
        error: `Wait time ${ms}ms is too long, keep it at or below 300000ms (5 minutes). For longer waits, split them into shorter steps`,
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
        error: "Wait aborted",
      });
    }

    return JSON.stringify({
      success: true,
      waitedMs: ms,
      waitedSeconds: (ms / 1000).toFixed(1),
      message: `Waited ${ms}ms (${(ms / 1000).toFixed(1)} seconds)`,
    });
  }
}
