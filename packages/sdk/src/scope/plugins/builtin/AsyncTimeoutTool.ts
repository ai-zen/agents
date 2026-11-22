import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { Agent, AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import type { LogSink } from "../../../shared/logger.js";
import { ASYNC_TIMEOUT_TOOL, deliverAsyncResult, nextTaskId, trackTimer } from "./asyncTasks.js";

/** setTimeout 能吃下的最大延时（2^31-1 毫秒）；再长它会立刻触发。 */
const MAX_TIMER_MS = 2_147_483_647;

export class AsyncTimeoutTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: ASYNC_TIMEOUT_TOOL,
    description:
      "Set a timer and return immediately. Do not wait for it: this call is over the moment it returns. " +
      "The system will notify you when the time is up by pushing a message back into this session, " +
      "carrying that timer's id; that notification is the only way a timer reports, so do not wait and " +
      "do not poll: nothing comes back before the timer fires. Use it when the wait itself is the " +
      "point: give another process a head start, come back to a value later, or space out work. There " +
      "is no upper limit on `ms`: this is a timer that delivers one message, not a limit on how long a " +
      "run may take.",
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "number",
          description:
            "Milliseconds to wait before the message is delivered (a positive number, no upper limit).",
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
    const agent = ctx?.agent;
    if (!agent) throw new Error(`${ASYNC_TIMEOUT_TOOL} must be called by an agent`);

    const ms = input.ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
      throw new Error(
        `${ASYNC_TIMEOUT_TOOL}: ms must be a positive number of milliseconds, got: ${JSON.stringify(ms)}`,
      );
    }

    const log = this.env.log;
    const taskId = nextTaskId(agent, ASYNC_TIMEOUT_TOOL);

    scheduleTimer({
      agent,
      ms,
      log,
      fire: () => {
        deliverAsyncResult({
          agent,
          label: ASYNC_TIMEOUT_TOOL,
          content: JSON.stringify({
            task: ASYNC_TIMEOUT_TOOL,
            taskId,
            ms,
            message: `Time is up: timer "${taskId}" was set for ${ms}ms and has fired.`,
          }),
          log,
        });
      },
    });

    return JSON.stringify({
      started: true,
      taskId,
      ms,
      note: `The timer runs as task "${taskId}". Do not wait for it: the system will notify you in ${ms}ms. Nothing checks a timer, so do not poll.`,
    });
  }
}

/**
 * 排一个定时器，并把它的回收登记到执行体名下。
 *
 * 超过 {@link MAX_TIMER_MS} 的等待要分段排：setTimeout 拿到更长的延时会立刻触发，那样
 * 一次跨月的定时会在下一拍就报「时间到了」。分段之后每一段到点再排下一段，对外仍然是一次定时。
 */
function scheduleTimer(options: {
  agent: Agent;
  ms: number;
  fire: () => void;
  log?: LogSink;
}): void {
  const { agent, ms, fire, log } = options;
  let remaining = ms;
  let untrack: () => void = () => undefined;

  const scheduleNext = () => {
    const step = Math.min(remaining, MAX_TIMER_MS);
    untrack = trackTimer(agent, setTimeout(tick, step), log);
  };

  const tick = () => {
    untrack();
    remaining -= MAX_TIMER_MS;
    if (remaining > 0) {
      scheduleNext();
      return;
    }
    fire();
  };

  scheduleNext();
}
