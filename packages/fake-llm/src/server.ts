/**
 * 仿真的流式 LLM API —— 一个够用的 OpenAI 兼容端点。
 *
 * 只依赖 `node:http`：它接的是客户端发出来的那个 HTTP 请求，谁发的都一样。零运行时依赖是
 * 刻意的 —— 替身自己要是需要装一堆东西，「离线可跑」就不成立了。
 *
 * 只实现被用到的那一小面：`POST <baseUrl>/chat/completions`（`stream: true` → SSE，
 * 否则一次性 JSON）。不实现 `/models`：没有人调它。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { buildDeltas } from "./deltas.js";
import type {
  FakeLlm,
  FakeLlmFinishReason,
  FakeLlmMessage,
  FakeLlmOptions,
  FakeLlmRequest,
  FakeLlmToolCall,
  FakeLlmUsage,
} from "./types.js";

const MODEL = "fake-model";
const DEFAULT_REPLY = "假答复";
const DEFAULT_USAGE = { prompt: 21, completion: 7 };

/** 起一个假端点（端口由系统分配，避免与真在跑的服务端抢端口） */
export async function startFakeLlm(options: FakeLlmOptions = {}): Promise<FakeLlm> {
  const requests: FakeLlmRequest[] = [];
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 客户端在响应写完之前取消（慢响应 + abort 的用例）时，socket 已关，再写会抛
    // ERR_STREAM_DESTROYED。那不是故障，正是那些用例要的结果，不该让它终止测试进程。
    response.on("error", () => {});
    const parsed = safeJson(await readBody(request));
    const record: FakeLlmRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      body: parsed,
      headers: request.headers,
      aborted: false,
    };
    requests.push(record);

    // 端点自己中断流时 `close` 一样会来，那不是客户端挂断，不能算进 `aborted`
    const state = { serverHungUp: false };
    response.on("close", () => {
      if (!response.writableEnded && !state.serverHungUp) record.aborted = true;
    });

    const index = requests.length - 1;
    const failWith = options.failWith;
    if (failWith !== undefined && (options.failOn === undefined || options.failOn === index)) {
      response.writeHead(failWith.status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: failWith.message, type: "invalid_request_error" },
        }),
      );
      return;
    }

    const message = targetFor(parsed, index);
    if (parsed?.stream === true) {
      await streamOut(message, response, state);
      return;
    }

    if (options.jsonDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.jsonDelayMs));
      // 等的时候客户端已经取消：这条请求到此为止（请求体仍留在 `requests` 里）
      if (response.destroyed || response.writableEnded) {
        record.aborted = true;
        return;
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: MODEL,
        choices: [
          {
            index: 0,
            message: messageOfReply(message),
            finish_reason: finishReasonOf(message),
          },
        ],
        usage: usageOf(message.usage),
      }),
    );
  }

  async function streamOut(
    message: FakeLlmMessage,
    response: ServerResponse,
    state: { serverHungUp: boolean },
  ): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // 首片按 OpenAI 的规矩带 role，正文为空；之后每一片都是目标消息的一部分
    const payloads: Record<string, unknown>[] = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      ...buildDeltas(message, { chunks: options.chunks, chunkSize: options.chunkSize }).map(
        (delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] }),
      ),
      // 收尾片：正文为空、`finish_reason`，`usage` 落在这一片上
      {
        choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf(message) }],
        usage: usageOf(message.usage),
      },
    ];

    for (const [at, payload] of payloads.entries()) {
      // 上一片之后先等一等：`chunkDelayMs` 就是「慢模型」那一个可测的中间态。写在这里而不是写在
      // 整个响应之后 —— `end()` 之后客户端已经拿到全文了，那之后再等只是拖住处理函数。
      if (at > 0 && options.chunkDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
      }
      const last = at === payloads.length - 1;
      if (last) {
        send(payload);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      send(payload);
      // 断流：写完这一片就不再往下写，也不写 `[DONE]`。断的是 socket 而不是 `end()`：
      // `end()` 收尾的流在客户端看来是一次完整回答，只有连接中途消失才叫断。
      if (options.breakAfter !== undefined && options.breakAfter === at + 1) {
        state.serverHungUp = true;
        await flush(response);
        response.destroy();
        return;
      }
    }

    function send(payload: Record<string, unknown>): void {
      const chunk = {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 0,
        model: MODEL,
        ...payload,
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  }

  function targetFor(body: any, index: number): FakeLlmMessage {
    const reply = options.reply ?? DEFAULT_REPLY;
    if (typeof reply === "function") return messageOf(reply(body, index));
    if (Array.isArray(reply)) {
      const picked = (reply as readonly (string | FakeLlmMessage)[])[
        Math.min(index, reply.length - 1)
      ];
      return messageOf(picked ?? DEFAULT_REPLY);
    }
    return messageOf(reply as string | FakeLlmMessage);
  }

  function usageOf(preferred: FakeLlmUsage | undefined) {
    if (preferred !== undefined) {
      return {
        prompt_tokens: preferred.prompt_tokens,
        completion_tokens: preferred.completion_tokens,
        total_tokens:
          preferred.total_tokens ?? preferred.prompt_tokens + preferred.completion_tokens,
      };
    }
    const usage = options.usage ?? DEFAULT_USAGE;
    return {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    };
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await closeServer(server);
    },
  };
}

/** 剧本里给的字符串就是这个意思：正文是这句话，没有工具调用 */
function messageOf(reply: string | FakeLlmMessage): FakeLlmMessage {
  return typeof reply === "string" ? { role: "assistant", content: reply } : reply;
}

function finishReasonOf(message: FakeLlmMessage): FakeLlmFinishReason {
  if (message.finish_reason !== undefined) return message.finish_reason;
  return (message.tool_calls?.length ?? 0) > 0 ? "tool_calls" : "stop";
}

/** 非流式那一份 `message`：与流式拼出来的是同一条消息，只是不再拆分 */
function messageOfReply(message: FakeLlmMessage): Record<string, unknown> {
  const reply: Record<string, unknown> = { role: "assistant", content: message.content ?? "" };
  if (message.reasoning_content !== undefined) reply.reasoning_content = message.reasoning_content;
  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    reply.tool_calls = message.tool_calls.map((toolCall, at) => ({
      index: toolCall.index ?? at,
      id: toolCall.id ?? `call_${at}`,
      type: toolCall.type ?? "function",
      function: {
        name: toolCall.function?.name ?? "",
        arguments: toolCall.function?.arguments ?? "",
      },
    })) satisfies FakeLlmToolCall[];
  }
  return reply;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk.toString()));
    request.on("end", () => resolve(body));
  });
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 等这一片真的写出去，再断连接：直接 destroy 会把刚写的那一片连同缓冲一起丢掉 */
function flush(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (response.destroyed) {
      resolve();
      return;
    }
    response.write("", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // 长连接（SSE 用完已经结束）也要断：不 closeAllConnections 的话收尾会挂住
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
