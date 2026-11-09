/**
 * 仿真的流式 LLM API —— 一个够用的 OpenAI 兼容端点，只活在测试里。
 *
 * ## 它假的是「模型提供方」，不是本项目的任何一层
 *
 * 只依赖 `node:http`：它接的是 `openai` SDK 发出来的那个 HTTP 请求。所以 core / sdk /
 * server / CLI 谁都能用，也不需要知道对方存在。
 *
 * ## 为什么需要一个「假模型」
 *
 * 各包的单元测试里 Agent 一律是被驱动的假件（`agent.fire("chunk-parsed", …)`、
 * `createMockClient([[chunk({content:"…"})]])`），那是对的：它们要隔离的正是传输。但那条
 * 隔离留了一段**谁都没走的路** —— `openai` SDK 发 `stream: true` + `stream_options.include_usage`，
 * 客户端逐片解析 SSE、把正文拼成消息、流末拿真实 `completion_tokens`、core 再把每片
 * 广播成 `chunk-parsed`：这一段只有在真有 HTTP 流的时候才成立。
 *
 * 用真模型验它要 key、要网、要钱，而且答复不确定（断言只能写「非空」）。这个假端点换来
 * 三件事：
 *
 *   1. **确定**：答复正文、分片数、用量都由用例指定，断言可以写等号；
 *   2. **离线**：CI 与本地都能跑，不需要任何 key；
 *   3. **可观测**：请求体被原样记下来 —— 「管道内容真的拼进了 prompt」「第二次调用没带
 *      上一轮历史」这类断言，只能从服务端收到的请求里看。
 *
 * 它已经抓到过一次真 bug：core 发 `emit("chunk-parsed", receiver, chunk)` 是**两参**，
 * 而消费方按单参写也照样过编译，于是正文增量一条都推不出去，界面只能等收尾快照一次性
 * 刷出。手捏 chunk 的单测永远抓不到这一层（它们不经过 SDK、也不看事件载荷）。
 *
 * ## 只实现被用到的那一小面
 *
 * `POST <baseUrl>/chat/completions`（`stream:true` → SSE，否则一次性 JSON）。不实现
 * `/models`、不实现多轮剧本：前者没人调，后者会让「答复是什么」变成好几轮的事，而用它的
 * 用例要验的是传输、事件与落盘，不是编排。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** 服务端收到的一次请求（断言「发出去的是什么」用） */
export interface FakeLlmRequest {
  method: string;
  path: string;
  /** 解析后的请求体（`messages` / `stream` / `stream_options` 都在里面） */
  body: any;
  /**
   * 客户端在响应写完之前就挂断了（= 它取消了这次请求）。
   *
   * 这是「取消信号真的抵达了 socket」的唯一外部证据：只看「最后抛了取消错」不够，
   * 服务可以在请求正常返回之后再检查一次 `signal.aborted` 得到同样的结果 —— 那种情况下
   * 请求其实跑完了全部延迟与 token。`jsonDelayMs` 把窗口撞开之后，这个字段才能区分两者。
   */
  aborted: boolean;
}

export interface FakeLlmOptions {
  /**
   * 答复正文的来源。
   *
   * 给字符串 = 每次都回它；给数组 = 按请求序号取（用完停在最后一条）；给函数 = 自己算
   * （多轮用例按 `messages` 决定回什么）。
   */
  reply?: string | string[] | ((body: any, index: number) => string);
  /** 把答复切成几片发（缺省 3）：片数 > 1 才能证明客户端是**流式**拼出来的 */
  chunks?: number;
  /** 每个 SSE 分片之间等多久（缺省 0；给正数可模拟慢模型） */
  chunkDelayMs?: number;
  /**
   * 非流式响应「首字节」之前的等待（缺省 0）。
   *
   * `chunkDelayMs` 只活在 SSE 分支：非流式是一把梭回的，没有中间态。但有一类用例
   * 需要**非流式**的慢响应 —— 「请求还在路上时被取消」（交接摘要就是这种：它不 stream，
   * 退不掉，只能真取消）。所以这里单独给一个开关，而不是让 `chunkDelayMs` 兼职。
   */
  jsonDelayMs?: number;
  /** 流末 `usage`（`include_usage` 要的就是它；缺省给一组固定值） */
  usage?: { prompt: number; completion: number };
  /** 让这次请求直接失败（错误路径用；SDK 会把 message 抛成 error 事件） */
  failWith?: { status: number; message: string };
}

export interface FakeLlm {
  /** 端点根地址，直接写进 `config.json` 的 `endpoints[].baseUrl` */
  baseUrl: string;
  /** 到目前为止收到的请求（按到达顺序） */
  requests: FakeLlmRequest[];
  /** 关掉监听（用完必须关，否则进程不退出） */
  close(): Promise<void>;
}

const MODEL = "fake-model";
const DEFAULT_USAGE = { prompt: 21, completion: 7 };

/** 起一个假端点（端口由系统分配，避免与真实服务端抢 8790） */
export async function startFakeLlm(
  options: FakeLlmOptions = {},
): Promise<FakeLlm> {
  const requests: FakeLlmRequest[] = [];
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  async function handle(
    request: IncomingMessage,
    response: any,
  ): Promise<void> {
    // 客户端在响应写完之前取消（慢响应 + abort 的用例）时，socket 已关，再写会抛
    // ERR_STREAM_DESTROYED。那不是故障，正是那些用例要的结果，不该让它掀掉测试进程。
    response.on("error", () => {});
    const body = await readBody(request);
    const parsed = safeJson(body);
    const record: FakeLlmRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      body: parsed,
      aborted: false,
    };
    requests.push(record);
    // 客户端在响应写完之前断线：`writableEnded` 还是 false，说明不是正常收尾
    response.on("close", () => {
      if (!response.writableEnded) record.aborted = true;
    });

    const failWith = options.failWith;
    if (failWith) {
      response.writeHead(failWith.status, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: { message: failWith.message, type: "invalid_request_error" },
        }),
      );
      return;
    }

    const reply = replyFor(parsed, requests.length - 1);
    if (parsed?.stream === true) await streamOut(response, reply);
    else {
      if (options.jsonDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.jsonDelayMs),
        );
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
              message: { role: "assistant", content: reply },
              finish_reason: "stop",
            },
          ],
          usage: usageOf(),
        }),
      );
    }
  }

  async function streamOut(response: any, reply: string): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // 第一片按 OpenAI 的规矩带 role，正文为空
    send({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    });
    for (const piece of splitReply(reply, options.chunks ?? 3)) {
      send({
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
    }
    // 收尾片：正文为空、`finish_reason` + `usage`（`include_usage` 时它在最后一片上）
    send({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usageOf(),
    });
    response.write("data: [DONE]\n\n");
    response.end();

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

    if (options.chunkDelayMs) {
      // 分片之间的延迟：让「慢模型」这件事可测（速率、阶段变化都靠它才有中间态）
      await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
    }
  }

  function usageOf(): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } {
    const usage = options.usage ?? DEFAULT_USAGE;
    return {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    };
  }

  function replyFor(body: any, index: number): string {
    const reply = options.reply ?? "假答复";
    if (typeof reply === "function") return reply(body, index);
    if (Array.isArray(reply)) return reply[Math.min(index, reply.length - 1)];
    return reply;
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await closeServer(server);
    },
  };
}

/** 把答复切成 `count` 片（按字符均分；`count <= 1` 或答复很短时就是一片） */
export function splitReply(reply: string, count: number): string[] {
  if (count <= 1 || reply.length <= 1) return [reply];
  const size = Math.ceil(reply.length / count);
  const pieces: string[] = [];
  for (let at = 0; at < reply.length; at += size)
    pieces.push(reply.slice(at, at + size));
  return pieces;
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // 长连接（SSE 用完已经结束）也要断：不 closeAllConnections 的话收尾会挂住
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
