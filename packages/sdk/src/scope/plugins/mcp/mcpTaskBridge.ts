import {
  createSessionPortFromClient,
  withTasks,
  type TaskEnabledSession,
  type TaskOutcome,
  type ToolDeclaration,
  type ToolExecution,
  type WithTasksOptions,
} from "@modelcontextprotocol/ext-tasks/client";
import { toJsonValue, type JsonValue, type TaskId } from "@modelcontextprotocol/ext-tasks/core";
import type { Client } from "@modelcontextprotocol/client";
import type { Agent } from "@ai-zen/agents-core";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";
import type { McpTaskNoticePort } from "./mcpTaskNotice.js";

/** 任务跑完之后的三种终态（`tasks/get` 那一份状态里的用词） */
type TerminalStatus = "completed" | "failed" | "cancelled";

/**
 * 一台服务器上的任务会话。
 *
 * 任务这件事在 2026-07-28 那一版里搬去了扩展轨道（`io.modelcontextprotocol/tasks`），语义跟着变了：
 * 客户端只声明「我接得住」，一次调用到底当场回结果、还是交一个任务句柄，由服务器在应答里自己决定。
 * 这个类就是那条分岔在 SDK 这一侧的落点 —— 包住官方 `@modelcontextprotocol/ext-tasks` 的 session，
 * 只往外露三件我们真正要用的东西：发一次调用、按任务 id 等结果、取消一个任务。
 *
 * 为什么还要自己记一份 `executions` 与 `settled`：包里的 `result()` 是个 Promise，句柄交出之后没有
 * 地方再拿到它 —— 而我们的工具面是「先交句柄、模型稍后用 `get_mcp_task_result` 来取」，两件事之间
 * 隔着好几轮对话，所以句柄与执行对象得在这儿对上号。终态那份也要留一份：任务跑完之后再取结果不该
 * 变成「没有这个任务」。
 */
export class McpTaskBridge {
  private readonly session: TaskEnabledSession;
  /** 包在 client 外的那层适配器：关的时候要显式摘掉，否则同一个 client 不能再套第二个 */
  private readonly adapter: ReturnType<typeof createSessionPortFromClient>;
  /** 任务 id → 还在跑的那次执行 */
  private readonly executions = new Map<string, ToolExecution<unknown>>();
  /** 任务 id → 终态（已跑完的那些，供事后取结果） */
  private readonly settled = new Map<string, TaskOutcome<unknown>>();
  private readonly logger: LogSink;
  private readonly port?: McpTaskNoticePort;
  private readonly server: string;

  constructor(
    client: Client,
    server: string,
    port?: McpTaskNoticePort,
    logger: LogSink = SILENT_LOG,
    /**
     * 服务器在调用中途要人回答时走这里（现代协议的多轮 `input_required`）。
     *
     * 为什么得由外面递进来：这一层的 session 发 `tools/call` 时带着 `allowInputRequired`，意思是
     * 「那份 input_required 原样给我」—— SDK 自己那套「拿注册的处理器自动履行」因此被关掉了，
     * 轮次归调用方接。而「谁能答题」只有调用方知道（宿主的题板、挂在哪一段会话下）。
     */
    private readonly elicit?: (
      params: Record<string, unknown>,
    ) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>,
  ) {
    this.server = server;
    this.port = port;
    this.logger = logger;
    this.adapter = createSessionPortFromClient(client, server);
    this.session = withTasks(
      this.adapter,
      elicit === undefined
        ? {}
        : {
            // 这一格在包里是泛型的（按请求种类推结果类型），我们只有 elicitation 一种，
            // 所以在这儿收窄成具体形状，交给泛型去对
            onInputRequest: (async (request: {
              kind: string;
              params?: Record<string, unknown>;
            }) => {
              // 我们只声明了 `elicitation.form`：sampling / roots 问过来就是服务器越了界，
              // 那就报错，而不是编一个能过校验的答案
              if (request.kind !== "elicitation") {
                throw new Error(`unsupported input request from "${server}": ${request.kind}`);
              }
              return await elicit(request.params ?? {});
            }) as unknown as NonNullable<WithTasksOptions["onInputRequest"]>,
          },
    );
  }

  /**
   * 发一次调用。
   *
   * 两种结局都从这里出去：当场有结果就交结果；服务器把它当任务就交任务 id，且不在这条路上等 ——
   * 终态与结果由 `settle()` 那一侧接着，跑完往发起调用的那段会话投一条通知。
   */
  async call(input: {
    tool: string;
    args: Record<string, unknown>;
    declaration?: ToolDeclaration;
    agent?: Agent;
    signal?: AbortSignal;
  }): Promise<
    { kind: "immediate"; outcome: TaskOutcome<unknown> } | { kind: "task"; taskId: string }
  > {
    const preference = taskPreferenceOf(input.declaration?.taskSupport);
    const execution = await this.session.callTool(
      input.tool,
      toJsonValue(input.args) as Readonly<Record<string, JsonValue>>,
      {
        ...(input.declaration === undefined ? {} : { declaration: input.declaration }),
        // 2025 那一版要客户端在请求里提议才可能拿到任务，所以档位是 `optional` / `required` 时都要说话；
        // `forbidden`（含没声明）就明确不要，别拿任务参数去撞一个不接任务的服务器。
        ...(preference === undefined ? {} : { task: { preference } }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );

    if (execution.kind === "immediate") {
      return { kind: "immediate", outcome: await execution.result() };
    }

    const taskId = execution.handle.taskId;
    this.executions.set(taskId, execution);
    void this.watch(taskId, execution, input.agent);
    return { kind: "task", taskId };
  }

  /** 按任务 id 等结果：还在跑就等它跑完，已经跑完就给留下的那一份 */
  async getResult(taskId: string): Promise<TaskOutcome<unknown>> {
    const done = this.settled.get(taskId);
    if (done !== undefined) return done;

    const running = this.executions.get(taskId);
    if (running === undefined) {
      throw new Error(
        `no task "${taskId}" on "${this.server}": it was never started here, or it ended before this process learned about it`,
      );
    }
    return await running.result();
  }

  /** 让服务器停掉一个任务；停不掉的原因由包那一侧抛出来，原样往上抬 */
  async cancel(taskId: string): Promise<void> {
    await this.session.cancelTask(taskId as TaskId);
  }

  async close(): Promise<void> {
    await this.session.close();
    // 适配器是独占的：不摘掉，同一个 client 上就再也建不起第二个任务会话
    this.adapter[Symbol.dispose]();
  }

  /** 等终态、留下结果、投一条通知；这里没有人接得住异常，一律落日志 */
  private async watch(
    taskId: string,
    execution: ToolExecution<unknown>,
    agent?: Agent,
  ): Promise<void> {
    try {
      const outcome = await execution.result();
      this.settled.set(taskId, outcome);
      await this.report(taskId, outcome, agent);
    } catch (error: unknown) {
      this.logger.warn(
        `[McpTaskBridge] task "${taskId}" of "${this.server}" ended without an outcome: ${String(error)}`,
      );
    } finally {
      this.executions.delete(taskId);
    }
  }

  private async report(
    taskId: string,
    outcome: TaskOutcome<unknown>,
    agent?: Agent,
  ): Promise<void> {
    const port = this.port;
    // 不知道是谁发起的（工具测试、或者调用方没给上下文）：没有会话可投
    if (port === undefined || agent === undefined) return;

    const sessionId = port.sessionOf(agent);
    if (sessionId === undefined) {
      // 被派出去的 SubAgent、一次性 Agent：没有会话可以回报，任务本身照旧留在服务器上
      this.logger.info(
        `[McpTaskBridge] task "${taskId}" of "${this.server}" has no session to report to`,
      );
      return;
    }

    const status: TerminalStatus = outcome.status;
    // 失败时服务器给的原因在 error 里，其余情况在任务对象上（取消也会带一句）
    const statusMessage =
      outcome.status === "failed" ? outcome.error.message : outcome.task?.statusMessage;
    try {
      await port.deliver(sessionId, {
        server: this.server,
        taskId,
        status,
        ...(statusMessage === undefined ? {} : { statusMessage }),
      });
    } catch (error: unknown) {
      this.logger.warn(
        `[McpTaskBridge] could not deliver the end of task "${taskId}" of "${this.server}": ${String(error)}`,
      );
    }
  }
}

/**
 * 工具声明的那一档 → 这次调用怎么提议。
 *
 * 三档不是我们自己发明的：`tools/list` 里每个工具的 `execution.taskSupport` 就是这三格，只是现在由
 * 声明推出来、不再由模型在参数里说 —— 新扩展里「用不用任务」是服务器在应答时决定的，客户端能表的
 * 只有这个偏好。
 */
function taskPreferenceOf(
  support: "forbidden" | "optional" | "required" | undefined,
): "forbid" | "prefer" | "require" | undefined {
  if (support === "required") return "require";
  if (support === "optional") return "prefer";
  if (support === "forbidden") return "forbid";
  return undefined;
}
